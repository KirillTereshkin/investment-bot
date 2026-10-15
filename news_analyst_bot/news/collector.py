"""Сбор новостей из RSS-источников.

Каждый источник обрабатывается независимо: падение одного не роняет job.
Возвращаемая по источнику структура:
    {
        "source": "RBC Economics",
        "url": "...",
        "status": "ok" | "empty" | "error",
        "reason": "timeout" | "http_500" | "parse_error" | None,
        "count": 8,
        "items": [...]
    }
"""

from __future__ import annotations

import calendar
import html as html_lib
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

import feedparser
import requests

import config

logger = logging.getLogger(__name__)

# RSS-источники по российскому рынку
# Проверено 15.10.2026: www.rbc.ru/rss/economics и www.rbc.ru/rss/finance отдают 404,
# вместо них используются rssexport.rbc.ru (общая лента RBC) и официальная лента ЦБ РФ.
# Рабочие альтернативы при необходимости: https://www.vedomosti.ru/rss/news,
# https://lenta.ru/rss/news, https://www.banki.ru/xml/news.rss.
SOURCES: list[dict[str, str]] = [
    {"name": "RBC News", "url": "https://rssexport.rbc.ru/rbcnews/news/30/full.rss"},
    {"name": "CBR", "url": "https://www.cbr.ru/rss/RssNews"},
    {"name": "TASS", "url": "https://tass.ru/rss/v2.xml"},
    {"name": "Interfax", "url": "https://www.interfax.ru/rss.asp"},
    {"name": "Kommersant", "url": "https://www.kommersant.ru/RSS/news.xml"},
    {"name": "Investing.com", "url": "https://ru.investing.com/rss/news_25.rss"},
]

HEADERS = {
    "User-Agent": config.HTTP_USER_AGENT,
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
}

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")

# Допуск для «новостей из будущего» — некоторые RSS отдают дату с завышением
FUTURE_TOLERANCE_SEC = 900
# Длина обрезки первого предложения summary в дайджесте
SUMMARY_LIMIT = 220


def clean_text(raw: str | None) -> str:
    """Убирает HTML-теги, HTML-сущности и лишние пробелы."""
    if not raw:
        return ""
    text = _TAG_RE.sub(" ", str(raw))
    text = html_lib.unescape(text)
    return _WHITESPACE_RE.sub(" ", text).strip()


def first_sentence(text: str, limit: int = SUMMARY_LIMIT) -> str:
    """Первое предложение summary (или обрезок, если предложения нет)."""
    cleaned = clean_text(text)
    if not cleaned:
        return ""
    parts = _SENTENCE_RE.split(cleaned, maxsplit=1)
    sentence = parts[0].strip() if parts else cleaned
    if len(sentence) > limit:
        sentence = sentence[: limit - 1].rstrip() + "…"
    return sentence


def _entry_timestamp(entry: Any) -> float | None:
    """Время публикации записи в UNIX-времени (UTC) или None."""
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if not parsed:
        return None
    try:
        return float(calendar.timegm(parsed))
    except (TypeError, ValueError, OverflowError):
        return None


def _parse_entries(feed: Any, window_start_ts: float, window_end_ts: float) -> tuple[list[dict[str, Any]], int]:
    """Отбирает записи фида, попадающие в окно. Возвращает (items, сколько записей без даты)."""
    items: list[dict[str, Any]] = []
    undated = 0
    for entry in getattr(feed, "entries", []) or []:
        title = clean_text(entry.get("title"))
        if not title:
            continue
        published_ts = _entry_timestamp(entry)
        if published_ts is None:
            # Новости без даты не берём: иначе они повторялись бы в каждом окне
            undated += 1
            continue
        if published_ts < window_start_ts or published_ts > window_end_ts + FUTURE_TOLERANCE_SEC:
            continue
        published = config.to_msk(datetime.fromtimestamp(published_ts, tz=timezone.utc))
        items.append(
            {
                "title": title,
                "summary": clean_text(entry.get("summary") or entry.get("description") or ""),
                "link": str(entry.get("link") or ""),
                "published": published.isoformat(),
                "published_ts": published_ts,
            }
        )
    return items, undated


def _parse_feed(name: str, url: str, content: bytes, window_start_ts: float, window_end_ts: float) -> dict[str, Any]:
    """Разбирает скачанный фид и формирует результат по источнику."""
    if not content or not content.strip():
        # Пустое тело при коде 200 — это ошибка источника, а не «новостей нет»
        logger.error("Источник %s: пустой ответ", name)
        return {"source": name, "url": url, "status": "error", "reason": "empty_response", "count": 0, "items": []}

    try:
        feed = feedparser.parse(content)
    except Exception as exc:  # pragma: no cover — feedparser бросает редко, но подстрахуемся
        logger.error("Источник %s: ошибка парсинга XML: %s", name, exc)
        return {"source": name, "url": url, "status": "error", "reason": "parse_error", "count": 0, "items": []}

    bozo = int(getattr(feed, "bozo", 0) or 0)
    entries = getattr(feed, "entries", []) or []
    if bozo and not entries:
        logger.error("Источник %s: сломанный XML (%s)", name, getattr(feed, "bozo_exception", "unknown"))
        return {"source": name, "url": url, "status": "error", "reason": "parse_error", "count": 0, "items": []}
    if bozo:
        logger.warning("Источник %s: XML с замечаниями, записи прочитаны (%s)", name, getattr(feed, "bozo_exception", "?"))

    items, undated = _parse_entries(feed, window_start_ts, window_end_ts)
    for item in items:
        item["source"] = name
        item["source_url"] = url
    if undated:
        logger.info("Источник %s: пропущено %s записей без даты публикации", name, undated)

    status = "ok" if items else "empty"
    logger.info("Источник %s: %s, новостей в окне — %s", name, status, len(items))
    return {"source": name, "url": url, "status": status, "reason": None, "count": len(items), "items": items}


def fetch_source(source: dict[str, str], window_start_ts: float, window_end_ts: float) -> dict[str, Any]:
    """Скачивает и разбирает один источник.

    При падении делает config.SOURCE_RETRIES повторов с задержкой
    config.SOURCE_RETRY_DELAY_SEC секунд. Исключения наружу не пробрасываются.
    """
    name = source["name"]
    url = source["url"]
    attempts = config.SOURCE_RETRIES + 1
    reason = "unknown_error"

    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, timeout=config.SOURCE_TIMEOUT_SEC, headers=HEADERS)
        except requests.Timeout:
            reason = "timeout"
        except requests.RequestException as exc:
            reason = "connection_error"
            logger.warning("Источник %s: сетевая ошибка (%s)", name, exc)
        except Exception as exc:  # непредвиденная ошибка — job не роняем
            reason = "unknown_error"
            logger.exception("Источник %s: непредвиденная ошибка: %s", name, exc)
        else:
            if response.status_code >= 400:
                reason = f"http_{response.status_code}"
            else:
                return _parse_feed(name, url, response.content, window_start_ts, window_end_ts)

        if attempt < attempts:
            logger.warning(
                "Источник %s: попытка %s/%s не удалась (%s), повтор через %s сек",
                name, attempt, attempts, reason, config.SOURCE_RETRY_DELAY_SEC,
            )
            time.sleep(config.SOURCE_RETRY_DELAY_SEC)

    logger.error("Источник %s: данные не получены после %s попыток (%s)", name, attempts, reason)
    return {"source": name, "url": url, "status": "error", "reason": reason, "count": 0, "items": []}


def collect_all(window_start: datetime, window_end: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Собирает все источники.

    Возвращает (статусы источников, плоский список новостей). Новости идут
    в порядке обхода источников, каждый item содержит ключ "source".
    """
    window_start_ts = window_start.timestamp()
    window_end_ts = window_end.timestamp()
    logger.info("Сбор новостей за окно %s — %s МСК", window_start.strftime("%H:%M"), window_end.strftime("%H:%M"))

    results: list[dict[str, Any]] = []
    all_items: list[dict[str, Any]] = []
    for source in SOURCES:
        result = fetch_source(source, window_start_ts, window_end_ts)
        results.append(result)
        all_items.extend(result["items"])

    ok_count = sum(1 for item in results if item["status"] == "ok")
    logger.info(
        "Сбор завершён: %s/%s источников с новостями, всего новостей — %s",
        ok_count, len(results), len(all_items),
    )
    return results, all_items


def build_digest(items: list[dict[str, Any]], max_lines: int | None = None) -> str:
    """Собирает дайджест «источник | заголовок | первое предложение summary».

    Строки берутся round-robin по источникам, чтобы в дайджест попали все
    источники, а не только первый. Всего не более config.MAX_DIGEST_LINES строк.
    """
    limit = config.MAX_DIGEST_LINES if max_lines is None else max_lines
    if not items:
        return ""

    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for item in items:
        name = str(item.get("source", "unknown"))
        if name not in groups:
            groups[name] = []
            order.append(name)
        groups[name].append(item)

    lines: list[str] = []
    index = 0
    while len(lines) < limit:
        added = False
        for name in order:
            bucket = groups[name]
            if index >= len(bucket):
                continue
            item = bucket[index]
            summary = first_sentence(item.get("summary", ""))
            line = f"{name} | {str(item.get('title', '')).strip()}"
            if summary:
                line += f" | {summary}"
            lines.append(line)
            added = True
            if len(lines) >= limit:
                break
        if not added:
            break
        index += 1

    return "\n".join(lines)
