"""Планировщик и главный сценарий анализа.

Здесь живут job'ы:
* run_analysis — сбор новостей → дедупликация → дайджест → котировки → портфель Tinkoff →
  DeepSeek → запись в SQLite (runs + predictions) → отправка сообщения в Telegram;
* check_predictions — ежедневная в 21:00 МСК проверка отработки идей по MOEX ISS.
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
from broker import tinkoff
from market import quotes
from news import collector
from news.dedup import deduplicate
from predictions import horizon
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
    """Создаёт AsyncIOScheduler: анализ по расписанию + ежедневная проверка идей."""
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
    scheduler.add_job(
        check_predictions,
        build_check_trigger(),
        id="daily_prediction_check",
        replace_existing=True,
        kwargs={"bot": bot},
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
    )
    return scheduler


def build_check_trigger() -> CronTrigger:
    """CronTrigger ежедневной проверки идей (по умолчанию 21:00 МСК)."""
    return CronTrigger(
        hour=config.PREDICTION_CHECK_HOUR,
        minute=config.PREDICTION_CHECK_MINUTE,
        timezone=config.TIMEZONE,
    )


def get_market_snapshot() -> dict[str, float]:
    """Снимок рыночного контекста для промпта (реальные данные, Часть 1).

    Порядок источников внутри market.quotes: живой запрос (MOEX ISS, ЦБ РФ) →
    последний снимок из SQLite → fallback из config.py. Ошибки источников не
    бросаются наружу: они превращаются в статусы и предупреждения в логе.
    """
    return quotes.get_snapshot().as_prompt_dict()


def get_portfolio_snapshot(force: bool = False) -> tinkoff.PortfolioSnapshot:
    """Портфель Tinkoff (только чтение). Без токена — статус no_token, без падения."""
    return tinkoff.get_portfolio_snapshot(force=force)


def create_predictions_for_run(
    run_id: int | None,
    parsed: dict[str, Any] | None,
    created_at: datetime,
) -> int:
    """Создаёт записи predictions по идеям прогона (Часть 3).

    Цена входа берётся с MOEX ISS; если её узнать не удалось — entry_price = None,
    идея сохраняется, но в проверку не попадёт (см. db.get_predictions_due).
    Инструменты без тикера MOEX (ОФЗ, валютные пары) пропускаются.
    """
    ideas = parsed.get("идеи") if isinstance(parsed, dict) else None
    if not isinstance(ideas, list) or not ideas:
        return 0

    prices: dict[str, float | None] = {}
    items: list[dict[str, Any]] = []

    for idea in ideas:
        if not isinstance(idea, dict):
            continue
        instrument = str(idea.get("инструмент") or "").strip()
        ticker = quotes.extract_ticker(instrument)
        if not ticker:
            logger.info("Прогнозы: %r — не тикер MOEX, в проверку не попадает", instrument)
            continue
        if ticker not in prices:
            prices[ticker] = quotes.fetch_ticker_price(ticker)

        horizon_text = str(idea.get("горизонт") or "").strip()
        items.append(
            {
                "ticker": ticker,
                "instrument": instrument,
                "direction": horizon.normalize_direction(idea.get("направление")),
                "confidence": str(idea.get("уверенность") or "").strip(),
                "horizon": horizon_text,
                "entry_price": prices[ticker],
                "check_at": horizon.compute_check_at(created_at, horizon_text),
            }
        )

    if not items:
        return 0

    try:
        return db.save_predictions(run_id, created_at, items)
    except Exception as exc:  # БД не должна ронять прогон
        logger.exception("Не удалось сохранить предсказания: %s", exc)
        return 0


async def check_predictions(bot: Bot) -> dict[str, Any]:
    """Проверка отработки идей (Часть 3, ежедневно 21:00 МСК).

    Для идей, у которых наступил check_at, берём текущую цену с MOEX ISS, определяем
    фактическое направление (±1% — «боковик») и пишем hit: 1 — сбылось, 0 — нет,
    None — «наблюдать» (не считается ни попаданием, ни промахом).
    """
    now = config.now_msk()
    due = await asyncio.to_thread(db.get_predictions_due, now)
    if not due:
        logger.info("Проверка идей: на %s МСК проверять нечего", now.strftime("%d.%m.%Y %H:%M"))
        return {"checked": 0, "skipped": 0, "results": []}

    results: list[dict[str, Any]] = []
    skipped = 0

    for row in due:
        ticker = str(row.get("ticker") or "")
        entry_price = row.get("entry_price")
        price = await asyncio.to_thread(quotes.fetch_ticker_price, ticker) if ticker else None
        realized = horizon.classify_move(entry_price, price)
        if realized is None:
            skipped += 1
            logger.warning(
                "Проверка идей: id=%s (%s) — нет цены для сравнения, вернёмся к ней позже",
                row.get("id"), ticker or "—",
            )
            continue

        direction = horizon.normalize_direction(row.get("direction"))
        hit = horizon.is_hit(direction, realized)
        await asyncio.to_thread(
            db.update_prediction_result,
            int(row["id"]),
            price_at_check=price,
            realized_direction=realized,
            hit=hit,
        )
        results.append(
            {
                "ticker": ticker,
                "direction": direction,
                "entry_price": entry_price,
                "price_at_check": price,
                "realized_direction": realized,
                "hit": hit,
                "change_pct": horizon.move_pct(entry_price, price),
            }
        )

    logger.info("Проверка идей завершена: проверено %s, отложено %s", len(results), skipped)
    if results:
        await notifier.send_message(bot, notifier.format_predictions_check(results))
    return {"checked": len(results), "skipped": skipped, "results": results}


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

    # 5. Котировки (Часть 1) и портфель Tinkoff (Часть 4).
    # Синхронные сетевые вызовы уводим в поток, чтобы не блокировать event loop.
    snapshot = await asyncio.to_thread(quotes.get_snapshot)
    market = snapshot.as_prompt_dict()
    logger.info("Рыночный контекст: %s", snapshot.log_line())

    portfolio = await asyncio.to_thread(tinkoff.get_portfolio_snapshot)
    if portfolio.ok:
        logger.info(
            "Tinkoff: позиций %s, стоимость %s", len(portfolio.positions), portfolio.total_value
        )
    tinkoff_status_text = portfolio.status_text()

    # 6. DeepSeek — вызываем только если есть что анализировать
    if unique_items:
        logger.info("Отправка дайджеста в DeepSeek (%s)", config.DEEPSEEK_MODEL)
        response = await _deepseek.analyze(
            digest=digest,
            window_start=window_start.strftime("%H:%M"),
            window_end=window_end.strftime("%H:%M"),
            key_rate=market["key_rate"],
            moex_value=market["moex_value"],
            moex_change=market["moex_change"],
            usdrub=market["usdrub"],
            cnyrub=market["cnyrub"],
            eurrub=market["eurrub"],
            portfolio_text=portfolio.prompt_text(),
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

    # 7. Сохраняем прогон в SQLite
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
            tinkoff_status=tinkoff_status_text,
            market_snapshot=snapshot.as_row(),
        )
    except Exception as exc:  # БД не должна ронять отправку прогноза
        logger.exception("Не удалось сохранить прогон в SQLite: %s", exc)

    # 8. Идеи прогона → predictions для последующей проверки отработки (Часть 3)
    predictions_created = 0
    if signal_present and deepseek_status == "ok":
        predictions_created = await asyncio.to_thread(
            create_predictions_for_run, run_id, parsed, finished_at
        )
        if predictions_created:
            logger.info("Прогнозы: создано %s записей для проверки", predictions_created)

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
        "market": market,
        "market_status": snapshot.source_status,
        "market_stale_values": snapshot.stale_values,
        "market_fallback_values": snapshot.fallback_values,
        "tinkoff_status": tinkoff_status_text,
        "tinkoff_status_code": portfolio.status,
        "tinkoff_positions": len(portfolio.positions),
        "tinkoff_total_value": portfolio.total_value,
        "predictions_created": predictions_created,
    }

    await notifier.send_message(bot, notifier.build_analysis_message(payload))
    logger.info(
        "Анализ завершён за %.1f сек: новостей %s, DeepSeek %s, идей %s, id=%s",
        (finished_at - started_at).total_seconds(), len(unique_items), deepseek_status, ideas_count, run_id,
    )
    return payload
