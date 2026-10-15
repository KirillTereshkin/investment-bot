"""Планировщик и главный сценарий анализа.

Здесь живёт job run_analysis: сбор новостей → дедупликация → дайджест →
DeepSeek → запись в SQLite → отправка сообщения в Telegram.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from aiogram import Bot
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import config
from ai.client import DeepSeekClient
from bot import notifier
from news import collector
from news.dedup import deduplicate
from storage import db

logger = logging.getLogger(__name__)

# Анализ выполняется строго по одному: /now во время планового прогона не запустится
_analysis_lock = asyncio.Lock()
_deepseek = DeepSeekClient()


def is_analysis_running() -> bool:
    """True, если анализ уже выполняется."""
    return _analysis_lock.locked()


def next_run_time(now: datetime | None = None) -> datetime:
    """Ближайшее время планового запуска (МСК)."""
    current = now or config.now_msk()
    for hour in config.ANALYSIS_HOURS:
        candidate = current.replace(hour=hour, minute=0, second=0, microsecond=0)
        if candidate > current:
            return candidate
    return (current + timedelta(days=1)).replace(
        hour=config.ANALYSIS_HOURS[0], minute=0, second=0, microsecond=0
    )


def schedule_human() -> str:
    """Расписание в виде «10, 12, 14, 16, 18, 20»."""
    return ", ".join(str(hour) for hour in config.ANALYSIS_HOURS)


def build_trigger() -> CronTrigger:
    """CronTrigger на ровные часы МСК (а не interval — так привязка к HH:00)."""
    return CronTrigger(
        hour=",".join(str(hour) for hour in config.ANALYSIS_HOURS),
        minute=0,
        timezone=config.TIMEZONE,
    )


def setup_scheduler(bot: Bot) -> AsyncIOScheduler:
    """Создаёт AsyncIOScheduler с единственным job-ом анализа."""
    scheduler = AsyncIOScheduler(timezone=config.TIMEZONE)
    scheduler.add_job(
        run_analysis,
        build_trigger(),
        id="hourly_analysis",
        replace_existing=True,
        kwargs={"bot": bot, "trigger": "schedule"},
        misfire_grace_time=300,
        coalesce=True,
        max_instances=1,
    )
    return scheduler


def get_market_snapshot() -> dict[str, float]:
    """Снимок рыночного контекста для промпта.

    TODO(котировки): ЗДЕСЬ ЗАГЛУШКА, значения берутся из config.py
    (KEY_RATE, MOEX_VALUE, MOEX_CHANGE, USDRUB). Заменить на реальные данные:
      * индекс MOEX (IMOEX) — MOEX ISS, JSON:
        https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json
      * USD/RUB — MOEX ISS (USD000UTSTOM) или ЦБ РФ: https://www.cbr-xml-daily.ru/daily_json.js
      * ключевая ставка ЦБ — https://www.cbr.ru/hd_base/KeyRate/ или вручную через .env
    Достаточно заменить тело функции — остальной код менять не нужно.
    """
    return {
        "key_rate": config.KEY_RATE,
        "moex_value": config.MOEX_VALUE,
        "moex_change": config.MOEX_CHANGE,
        "usdrub": config.USDRUB,
    }


async def run_analysis(bot: Bot, trigger: str = "schedule") -> dict[str, Any] | None:
    """Точка входа для планировщика и команды /now.

    Возвращает результат прогона или None, если анализ уже идёт / упал целиком.
    """
    if _analysis_lock.locked():
        logger.warning("Анализ уже выполняется — запуск (%s) пропущен", trigger)
        return None

    async with _analysis_lock:
        try:
            return await _run_analysis(bot, trigger)
        except Exception as exc:  # непредвиденная ошибка — уведомляем владельца
            logger.exception("Анализ не удался: %s", exc)
            await notifier.send_message(bot, f"⚠️ <b>Анализ не удался:</b> {notifier.esc(exc)}")
            return None


def _count_ideas(parsed: dict[str, Any] | None) -> int:
    """Сколько идей вернула модель (0, если их нет или сигналов нет)."""
    if not isinstance(parsed, dict) or parsed.get("сигналов_нет"):
        return 0
    ideas = parsed.get("идеи")
    return len(ideas) if isinstance(ideas, list) else 0


async def _run_analysis(bot: Bot, trigger: str) -> dict[str, Any]:
    """Полный цикл одного прогона анализа."""
    started_at = config.now_msk()
    window_end = started_at
    window_start = window_end - timedelta(minutes=config.NEWS_WINDOW_MINUTES)
    logger.info(
        "Анализ (%s) начат в %s МСК, окно новостей %s — %s МСК",
        trigger, started_at.strftime("%H:%M:%S"),
        window_start.strftime("%H:%M"), window_end.strftime("%H:%M"),
    )

    # 1-2. Сбор источников (sync-часть уводим в поток, чтобы не блокировать event loop)
    sources, raw_items = await asyncio.to_thread(collector.collect_all, window_start, window_end)

    # 3. Дедупликация
    unique_items, dropped = deduplicate(raw_items)

    # 4. Дайджест
    digest = collector.build_digest(unique_items)
    digest_lines = len([line for line in digest.splitlines() if line.strip()])
    logger.info(
        "Новостей собрано: %s, после дедупликации: %s (дубликатов %s), строк в дайджесте: %s",
        len(raw_items), len(unique_items), dropped, digest_lines,
    )

    deepseek_status = "skipped"
    deepseek_error: str | None = None
    tokens: int | None = None
    duration_ms: int | None = None
    parsed: dict[str, Any] | None = None
    raw_response: str | None = None

    # 5. DeepSeek — вызываем только если есть что анализировать
    if unique_items:
        snapshot = get_market_snapshot()
        logger.info("Отправка дайджеста в DeepSeek (%s)", config.DEEPSEEK_MODEL)
        response = await _deepseek.analyze(
            digest=digest,
            window_start=window_start.strftime("%H:%M"),
            window_end=window_end.strftime("%H:%M"),
            key_rate=snapshot["key_rate"],
            moex_value=snapshot["moex_value"],
            moex_change=snapshot["moex_change"],
            usdrub=snapshot["usdrub"],
        )
        deepseek_status = response.status
        deepseek_error = response.error
        tokens = response.tokens
        duration_ms = response.duration_ms
        parsed = response.parsed
        raw_response = response.raw_response
    else:
        logger.warning("Новостей за окно нет — DeepSeek не вызывается")

    ideas_count = _count_ideas(parsed)
    signal_present = ideas_count > 0

    # 8. Сохраняем прогон в SQLite
    finished_at = config.now_msk()
    run_id: int | None = None
    try:
        run_id = db.save_run(
            started_at=started_at,
            finished_at=finished_at,
            sources_status=sources,
            deepseek_status=deepseek_status,
            deepseek_tokens=tokens,
            deepseek_duration_ms=duration_ms,
            digest=digest,
            raw_response=raw_response,
            parsed_json=parsed,
            signal_present=signal_present,
        )
    except Exception as exc:  # БД не должна ронять отправку прогноза
        logger.exception("Не удалось сохранить прогон в SQLite: %s", exc)

    # 9. Отправляем сообщение владельцу
    payload: dict[str, Any] = {
        "run_id": run_id,
        "trigger": trigger,
        "started_at": started_at,
        "finished_at": finished_at,
        "window_start": window_start,
        "window_end": window_end,
        "sources": sources,
        "news_total": len(raw_items),
        "news_unique": len(unique_items),
        "dedup_dropped": dropped,
        "digest": digest,
        "digest_lines": digest_lines,
        "deepseek_status": deepseek_status,
        "deepseek_error": deepseek_error,
        "tokens": tokens,
        "duration_ms": duration_ms,
        "parsed": parsed,
        "raw_response": raw_response,
        "ideas_count": ideas_count,
        "signal_present": signal_present,
    }

    await notifier.send_message(bot, notifier.build_analysis_message(payload))
    logger.info(
        "Анализ завершён за %.1f сек: новостей %s, DeepSeek %s, идей %s, id=%s",
        (finished_at - started_at).total_seconds(), len(unique_items), deepseek_status, ideas_count, run_id,
    )
    return payload
