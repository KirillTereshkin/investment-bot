"""Формирование и отправка сообщений в Telegram.

Все ответы модели проходят через html.escape, поэтому parse_mode=HTML безопасен.
Отправка никогда не бросает исключений наружу: ошибки пишутся в лог.
"""

from __future__ import annotations

import html
import json
import logging
import re
from datetime import datetime
from typing import Any

from aiogram import Bot
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest

import config

logger = logging.getLogger(__name__)

SEPARATOR = "━" * 20
IDEA_TEXT_LIMIT = 500
MODEL_TEXT_LIMIT = 300

_TAG_RE = re.compile(r"<[^>]+>")

STATUS_ICONS = {"ok": "✅", "empty": "⚠️", "error": "❌"}

# Человекочитаемые причины падения источников
REASON_LABELS = {
    "timeout": "timeout",
    "connection_error": "нет соединения",
    "parse_error": "parse_error",
    "unknown_error": "ошибка",
    "empty_response": "пустой ответ",
    "empty": "пусто",
}

# Человекочитаемые причины ошибок DeepSeek
DEEPSEEK_REASON_LABELS = {
    "timeout": "таймаут",
    "connection_error": "нет соединения",
    "auth_error": "неверный API-ключ",
    "rate_limit": "превышен лимит запросов",
    "invalid_json": "ответ модели не является JSON",
    "no_api_key": "DEEPSEEK_API_KEY не задан",
    "unknown_error": "неизвестная ошибка",
}


def esc(value: Any) -> str:
    """Экранирование произвольного текста для parse_mode=HTML."""
    return html.escape(str(value), quote=False)


def strip_html(text: str) -> str:
    """Превращает текст с HTML-разметкой в плоский (для повторной отправки без разметки)."""
    return html.unescape(_TAG_RE.sub("", text))


def short(value: Any, limit: int) -> str:
    """Обрезает длинный текст, сохраняя читаемость."""
    text = " ".join(str(value).split()) if value is not None else ""
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def reason_label(reason: str | None) -> str:
    if not reason:
        return "ошибка"
    if reason.startswith("http_"):
        return "http " + reason[5:]
    return REASON_LABELS.get(reason, reason)


def deepseek_reason_label(reason: str | None) -> str:
    if not reason:
        return "неизвестная ошибка"
    if reason.startswith("http_"):
        return "http " + reason[5:]
    return DEEPSEEK_REASON_LABELS.get(reason, reason)


def split_message(text: str, limit: int | None = None) -> list[str]:
    """Разбивает длинное сообщение на части по строкам (лимит Telegram — 4096)."""
    max_len = config.TELEGRAM_MAX_MESSAGE_LEN if limit is None else limit
    if len(text) <= max_len:
        return [text]

    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) <= max_len:
            current = candidate
            continue
        if current:
            chunks.append(current)
        while len(line) > max_len:
            chunks.append(line[:max_len])
            line = line[max_len:]
        current = line
    if current:
        chunks.append(current)
    return chunks


async def send_message(bot: Bot, text: str, chat_id: int | None = None) -> bool:
    """Отправляет сообщение владельцу бота. Возвращает True, если отправка удалась."""
    target = chat_id or config.TELEGRAM_CHAT_ID
    if not target:
        logger.error("TELEGRAM_CHAT_ID не задан — сообщение не отправлено")
        return False

    delivered = True
    for chunk in split_message(text):
        try:
            await bot.send_message(target, chunk, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
        except TelegramBadRequest as exc:
            # Обычно причина — невалидная разметка: отправляем как plain-текст
            logger.warning("Telegram отклонил HTML-разметку (%s), повтор без разметки", exc)
            try:
                await bot.send_message(target, strip_html(chunk), disable_web_page_preview=True)
            except TelegramAPIError as inner:
                logger.error("Не удалось отправить сообщение в Telegram: %s", inner)
                delivered = False
        except TelegramAPIError as exc:
            logger.error("Ошибка отправки в Telegram: %s", exc)
            delivered = False
    return delivered


def next_run_hhmm(now: datetime | None = None) -> str:
    """Ближайшее время запуска в формате HH:MM (МСК). Импорт ленивый — против цикла модулей."""
    from scheduler.jobs import next_run_time  # локальный импорт: jobs импортирует notifier

    return next_run_time(now).strftime("%H:%M")


def _format_sources(sources: list[dict[str, Any]]) -> str:
    """Блок статусов источников."""
    ok_count = sum(1 for source in sources if source.get("status") == "ok")
    lines = [f"📡 <b>Источники ({ok_count}/{len(sources)} ok):</b>"]
    for source in sources:
        status = source.get("status")
        icon = STATUS_ICONS.get(status, "❔")
        name = esc(source.get("source", "unknown"))
        if status == "ok":
            lines.append(f"{icon} {name} — {source.get('count', 0)}")
        elif status == "empty":
            lines.append(f"{icon} {name} — пусто")
        else:
            lines.append(f"{icon} {name} — {esc(reason_label(source.get('reason')))}")
    return "\n".join(lines)


def _format_deepseek(result: dict[str, Any]) -> str:
    """Строка статуса DeepSeek."""
    status = str(result.get("deepseek_status") or "").strip()
    if status == "ok":
        tokens = result.get("tokens")
        tokens_text = f"{tokens} токенов" if tokens is not None else "токены н/д"
        duration_ms = result.get("duration_ms")
        duration_text = f"{duration_ms / 1000:.1f} сек" if duration_ms is not None else "—"
        return f"🧠 DeepSeek: ok | {tokens_text} | {duration_text}"
    if status == "skipped":
        return "🧠 DeepSeek: ⏭️ не вызывался (новостей за окно нет)"
    reason = status.split(":", 1)[1] if ":" in status else status
    return (
        f"🧠 DeepSeek: ❌ ошибка после {config.DEEPSEEK_RETRIES} ретраев — "
        f"\"{esc(deepseek_reason_label(reason))}\""
    )


def _format_ideas(parsed: dict[str, Any]) -> list[str]:
    """Блок идей из ответа модели (максимум 4 идеи, как требует промпт)."""
    ideas = parsed.get("идеи")
    if not isinstance(ideas, list):
        return []

    lines: list[str] = []
    for index, idea in enumerate(ideas[:4], start=1):
        if not isinstance(idea, dict):
            continue
        instrument = short(idea.get("инструмент", "—"), 60) or "—"
        direction = short(idea.get("направление", "—"), 40) or "—"
        horizon = short(idea.get("горизонт", ""), 40)
        confidence = short(idea.get("уверенность", "—"), 40) or "—"

        head = f"{index}. {instrument} — {direction}"
        if horizon:
            head += f", {horizon}"
        head += f", уверенность: {confidence}"
        lines.append(f"<b>{esc(head)}</b>")

        justification = short(idea.get("обоснование", ""), IDEA_TEXT_LIMIT)
        if justification:
            lines.append(f"   {esc(justification)}")

        cancel_trigger = short(idea.get("триггер_отмены", ""), IDEA_TEXT_LIMIT)
        if cancel_trigger:
            lines.append(f"   ⚠️ Отмена: {esc(cancel_trigger)}")
    return lines


def _format_body(result: dict[str, Any]) -> str:
    """Тело сообщения: прогноз, идеи, урок дня — или причина отсутствия прогноза."""
    status = str(result.get("deepseek_status") or "").strip()

    if status == "skipped":
        return "Новостей за окно нет."

    if status != "ok":
        reason = status.split(":", 1)[1] if ":" in status else status
        return f"❌ Прогноз не получен: {esc(deepseek_reason_label(reason))}"

    parsed = result.get("parsed") or {}
    lines: list[str] = []

    summary = short(parsed.get("резюме_рынка", ""), MODEL_TEXT_LIMIT)
    if summary:
        lines.append(f"📈 <b>Рынок:</b> {esc(summary)}")

    ideas = _format_ideas(parsed)
    no_signals = bool(parsed.get("сигналов_нет"))

    lines.append("")
    if ideas and not no_signals:
        lines.append("🎯 <b>Идеи:</b>")
        lines.extend(ideas)
    else:
        lines.append("Сигналов нет. Рынок без значимых новостей за окно.")

    lesson = short(parsed.get("урок_дня", ""), MODEL_TEXT_LIMIT)
    if lesson:
        lines.append("")
        lines.append(f"📌 <b>Урок дня:</b> {esc(lesson)}")

    return "\n".join(lines)


def build_analysis_message(result: dict[str, Any]) -> str:
    """Собирает итоговое сообщение анализа по формату проекта."""
    window_start: datetime = result["window_start"]
    window_end: datetime = result["window_end"]
    sources: list[dict[str, Any]] = result.get("sources") or []

    blocks: list[str] = []

    failed = sum(1 for source in sources if source.get("status") == "error")
    if sources and failed * 2 > len(sources):
        blocks.append("⚠️ <b>Больше половины источников недоступно, прогноз может быть неполным.</b>")
        blocks.append("")

    blocks.append(f"📊 <b>Анализ за {window_start:%H:%M}–{window_end:%H:%M} МСК ({window_end:%d.%m.%Y})</b>")
    blocks.append("")
    blocks.append(_format_sources(sources))
    blocks.append("")
    blocks.append(_format_deepseek(result))
    blocks.append("")
    blocks.append(SEPARATOR)
    blocks.append(_format_body(result))
    blocks.append("")
    blocks.append(SEPARATOR)
    blocks.append(f"⏭️ Следующий анализ в {next_run_hhmm()} МСК")

    return "\n".join(blocks)


def _load_json(raw: Any, default: Any) -> Any:
    """Безопасный json.loads для значений из БД."""
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def format_last_run(run: dict[str, Any] | None) -> str:
    """Текст для команды /last."""
    if not run:
        return "📭 Прогонов ещё не было. Запустите /now."

    lines: list[str] = [
        f"🕓 <b>Последний прогон:</b> {esc(run.get('started_at') or '—')}",
        "",
    ]

    tokens = run.get("deepseek_tokens")
    duration = run.get("deepseek_duration_ms")
    duration_text = f"{duration / 1000:.1f} сек" if duration else "—"
    lines.append(
        f"🧠 DeepSeek: {esc(run.get('deepseek_status') or '—')}"
        f" | токенов: {tokens if tokens is not None else '—'}"
        f" | {duration_text}"
    )

    sources = _load_json(run.get("sources_status"), [])
    if isinstance(sources, list) and sources:
        lines.append("")
        lines.append(_format_sources(sources))

    digest = run.get("digest") or ""
    lines.append("")
    lines.append(f"📄 Дайджест: {len([line for line in digest.splitlines() if line.strip()])} строк")

    lines.append("")
    lines.append(SEPARATOR)
    lines.append(
        _format_body(
            {
                "deepseek_status": run.get("deepseek_status") or "",
                "parsed": _load_json(run.get("parsed_json"), None),
            }
        )
    )
    return "\n".join(lines)


def format_stats(stats: dict[str, Any]) -> str:
    """Текст для команды /stats."""
    since = stats.get("since")
    header = f"📊 <b>Статистика за {stats.get('days', 7)} дней</b>"
    if since:
        header += f" (с {since:%d.%m.%Y %H:%M} МСК)"

    lines: list[str] = [
        header,
        "",
        f"Прогонов: <b>{stats.get('total_runs', 0)}</b>",
        f"С идеями: {stats.get('with_ideas', 0)}",
        f"«Сигналов нет»: {stats.get('no_signal', 0)}",
        f"Пропущено (новостей не было): {stats.get('deepseek_skipped', 0)}",
        f"Ошибок DeepSeek: {stats.get('deepseek_errors', 0)}",
        f"Падений источников: {stats.get('source_failures', 0)}",
        f"Прогонов с деградацией (упало >50% источников): {stats.get('degraded_runs', 0)}",
    ]

    failed_sources: dict[str, int] = stats.get("failed_sources") or {}
    if failed_sources:
        lines.append("")
        lines.append("<b>Падения по источникам:</b>")
        for name, count in sorted(failed_sources.items(), key=lambda pair: -pair[1]):
            lines.append(f"• {esc(name)} — {count}")

    return "\n".join(lines)


def format_schedule() -> str:
    """Текст для команды /schedule и /start."""
    hours = ", ".join(f"{hour:02d}:00" for hour in config.ANALYSIS_HOURS)
    return "\n".join(
        [
            f"🗓 <b>Расписание:</b> {hours} МСК, ежедневно",
            f"⏭️ Следующий запуск: <b>{next_run_hhmm()} МСК</b>",
            f"🪟 Окно сбора новостей: {config.NEWS_WINDOW_MINUTES} минут",
            f"🌍 Таймзона: {config.TIMEZONE}",
        ]
    )


def format_startup_message() -> str:
    """Сообщение при старте бота (требование ТЗ)."""
    hours = ",".join(str(hour) for hour in config.ANALYSIS_HOURS)
    return (
        f"🤖 <b>Бот запущен.</b>\n"
        f"Следующий анализ в {next_run_hhmm()} МСК.\n"
        f"Расписание: {hours}."
    )
