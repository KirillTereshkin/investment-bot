"""Временный смоук-тест проекта (после проверки удаляется).

Запуск: .\\.venv\\Scripts\\python.exe _smoke_test.py
"""

from __future__ import annotations

import asyncio
import logging
import requests
import sys
import types
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Any

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

logging.basicConfig(level=logging.WARNING, format="%(levelname)s | %(name)s | %(message)s")

import config
from ai import prompts
from ai.client import DeepSeekClient, extract_json
from aiogram import Bot
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.base import BaseSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import SendMessage
from aiogram.types import Chat, Message, User
from bot import handlers, notifier
from broker import tinkoff
from market import quotes
from news import collector
from news.dedup import Deduplicator, deduplicate, jaccard_similarity, normalize_title, title_hash
from predictions import horizon
from scheduler import jobs
from storage import db

FAILED: list[str] = []
TOTAL: list[str] = []


def check(name: str, condition: bool, extra: str = "") -> None:
    TOTAL.append(name)
    print(f"[{'OK  ' if condition else 'FAIL'}] {name} {extra}")
    if not condition:
        FAILED.append(name)


def build_fake_feed() -> bytes:
    """Синтетический RSS: свежая новость, старая новость, новость без даты."""
    fresh = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=30))
    old = format_datetime(datetime.now(timezone.utc) - timedelta(days=5))
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Test</title>
<item><title>ЦБ повысил ключевую ставку до 17%</title>
<description><![CDATA[<p>Совет директоров Банка России повысил ставку. Прогноз инфляции обновлён.</p>]]></description>
<pubDate>{fresh}</pubDate><link>https://example.com/1</link></item>
<item><title>Старая новость про рубль</title><description>Текст.</description>
<pubDate>{old}</pubDate><link>https://example.com/2</link></item>
<item><title>Новость без даты</title><description>Текст.</description></item>
</channel></rss>"""
    return xml.encode("utf-8")


def test_dedup() -> None:
    norm = normalize_title("Сбербанк: дивиденды — 33,3 руб.!")
    check("dedup.normalize_title", norm == "сбербанк дивиденды 33 3 руб", repr(norm))
    check("dedup.title_hash стабилен", title_hash(norm) == title_hash(norm))
    check("dedup.jaccard идентичных", jaccard_similarity({"а", "б"}, {"б", "а"}) == 1.0)

    dedup = Deduplicator()
    first, _ = dedup.is_duplicate("ЦБ повысил ключевую ставку до 17 процентов")
    second, reason = dedup.is_duplicate("ключевую ставку ЦБ повысил до 17 процентов")
    check("dedup.jaccard дубликат", first is False and second is True and reason == "similarity", str(reason))

    unique, dropped = deduplicate(
        [
            {"title": "Газпром отчитался за квартал"},
            {"title": "ГАЗПРОМ отчитался за квартал!"},
            {"title": "Лукойл объявил дивиденды"},
        ]
    )
    check("dedup.deduplicate", len(unique) == 2 and dropped == 1, f"unique={len(unique)} dropped={dropped}")


def test_collector() -> None:
    window_end = config.now_msk()
    window_start = window_end - timedelta(minutes=config.NEWS_WINDOW_MINUTES)
    parsed = collector._parse_feed(
        "Test Source", "https://example.com/rss", build_fake_feed(),
        window_start.timestamp(), window_end.timestamp(),
    )
    check("collector._parse_feed status", parsed["status"] == "ok", str(parsed["status"]))
    check("collector._parse_feed count (только свежая)", parsed["count"] == 1, f"count={parsed['count']}")
    empty_result = collector._parse_feed("S", "u", b"", 0, 1e18)
    check(
        "collector: пустой ответ → error",
        empty_result["status"] == "error" and empty_result["reason"] == "empty_response",
        f"{empty_result['status']}/{empty_result['reason']}",
    )
    garbage_result = collector._parse_feed("S", "u", b"<html>not an rss</html>", 0, 1e18)
    check("collector: не-RSS → empty", garbage_result["status"] == "empty", garbage_result["status"])
    check("collector: метка пустого ответа", notifier.reason_label("empty_response") == "пустой ответ")
    check("collector: имена источников", [s["name"] for s in collector.SOURCES][:2] == ["RBC News", "CBR"])
    check("collector: HTML вычищен", "<p>" not in parsed["items"][0]["summary"])

    digest = collector.build_digest(
        [
            {"source": "A", "title": "T1", "summary": "Первое предложение. Второе."},
            {"source": "B", "title": "T2", "summary": "Без точки"},
            {"source": "A", "title": "T3", "summary": ""},
        ]
    )
    lines = digest.splitlines()
    check(
        "collector.build_digest round-robin",
        lines[0].startswith("A | T1") and lines[1].startswith("B | T2") and lines[2].startswith("A | T3"),
        f"lines={len(lines)}",
    )
    check("collector.build_digest первое предложение", "Первое предложение" in lines[0] and "Второе" not in lines[0])
    many = collector.build_digest([{"source": "A", "title": f"t{i}", "summary": ""} for i in range(50)])
    check("collector.build_digest лимит 25", len(many.splitlines()) == config.MAX_DIGEST_LINES)


def test_prompts_and_json() -> None:
    user_prompt = prompts.build_user_prompt(
        window_start="12:00", window_end="14:00", digest="RBC | Тест | Текст",
        key_rate=16.0, moex_value=3200.0, moex_change=0.0, usdrub=92.0,
    )
    check("prompts: дайджест и контекст подставлены", "RBC | Тест | Текст" in user_prompt and "16.0%" in user_prompt)
    check("prompts: слово json присутствует", "json" in user_prompt.lower())
    check("prompts: SYSTEM_PROMPT на месте", "аналитик российского фондового рынка" in prompts.SYSTEM_PROMPT)
    check(
        "prompts: правила 8-10 про позиции",
        "предупреждения_по_позициям" in prompts.SYSTEM_PROMPT
        and "8. Если среди моих открытых позиций" in prompts.SYSTEM_PROMPT
        and "10. Не предлагай закрывать позиции" in prompts.SYSTEM_PROMPT,
    )

    with_portfolio = prompts.build_user_prompt(
        window_start="12:00", window_end="14:00", digest="RBC | Тест",
        key_rate=14.0, moex_value=2400.0, moex_change=-0.9, usdrub=83.95,
        cnyrub=12.54, eurrub=93.92,
        portfolio_text="Мои открытые позиции:\n- SBER: 100 шт, средняя 285.50 ₽",
    )
    check(
        "prompts: блок позиций и новые курсы",
        "Мои открытые позиции:" in with_portfolio
        and "CNY/RUB 12.54" in with_portfolio
        and "EUR/RUB 93.92" in with_portfolio,
    )
    check(
        "prompts: без позиций блока нет",
        "Мои открытые позиции" not in prompts.build_user_prompt(
            window_start="12:00", window_end="14:00", digest="RBC | Тест",
            key_rate=14.0, moex_value=2400.0, moex_change=-0.9, usdrub=83.95,
        ),
    )
    check("prompts: неизвестные курсы → «н/д»", "CNY/RUB н/д" in user_prompt)

    check("client.extract_json обычный", extract_json('{"a": 1}') == {"a": 1})
    check("client.extract_json в ```-обёртке", extract_json('```json\n{"а": [1]}\n```') == {"а": [1]})
    check("client.extract_json мусор вокруг", extract_json('Вот ответ: {"a": 2} конец') == {"a": 2})
    try:
        extract_json("не json")
        check("client.extract_json битый → ошибка", False)
    except ValueError:
        check("client.extract_json битый → ошибка", True)


def base_sources() -> list[dict]:
    return [
        {"source": "RBC News", "status": "ok", "reason": None, "count": 8},
        {"source": "CBR", "status": "ok", "reason": None, "count": 12},
        {"source": "TASS", "status": "ok", "reason": None, "count": 5},
        {"source": "Interfax", "status": "ok", "reason": None, "count": 3},
        {"source": "Kommersant", "status": "empty", "reason": None, "count": 0},
        {"source": "Investing.com", "status": "error", "reason": "timeout", "count": 0},
    ]


def ok_payload(window_end: datetime) -> dict:
    return {
        "window_start": window_end - timedelta(hours=2),
        "window_end": window_end,
        "sources": base_sources(),
        "deepseek_status": "ok",
        "tokens": 1240,
        "duration_ms": 1800,
        "parsed": {
            "резюме_рынка": "Ставка выросла, банки под давлением.",
            "идеи": [
                {
                    "инструмент": "SBER", "направление": "лонг", "горизонт": "2-8 недель",
                    "уверенность": "средняя", "обоснование": "Высокие ставки = высокая маржа.",
                    "триггер_отмены": "Снижение ставки ЦБ.",
                },
                {
                    "инструмент": "CNY/RUB", "направление": "наблюдать", "горизонт": "4 недели",
                    "уверенность": "низкая", "обоснование": "Ждём данные по экспорту.",
                    "триггер_отмены": "Рост нефти.",
                },
            ],
            "урок_дня": "Рынок живёт ожиданиями ставки.",
            "сигналов_нет": False,
        },
    }


def test_messages(window_end: datetime) -> None:
    payload = ok_payload(window_end)
    message = notifier.build_analysis_message(payload)
    check("msg: заголовок окна", "📊 <b>Анализ за" in message and "МСК (" in message)
    check(
        "msg: статусы источников",
        "📡 <b>Источники (4/6 ok):</b>" in message
        and "❌ Investing.com — timeout" in message
        and "⚠️ Kommersant — пусто" in message,
    )
    check("msg: DeepSeek ok с токенами", "🧠 DeepSeek: ok | 1240 токенов | 1.8 сек" in message)
    check(
        "msg: идеи и обоснование",
        "1. SBER — лонг, 2-8 недель, уверенность: средняя" in message
        and "⚠️ Отмена: Снижение ставки ЦБ." in message,
    )
    check("msg: урок дня", "📌 <b>Урок дня:</b>" in message)
    check("msg: следующий анализ", "⏭️ Следующий анализ в" in message)
    check("msg: нет дисклеймера при 1/6 упавших", "Больше половины источников" not in message)

    dead = dict(payload)
    dead["sources"] = [{"source": f"S{i}", "status": "error", "reason": "http_500", "count": 0} for i in range(4)]
    dead["sources"] += [
        {"source": "OK", "status": "ok", "reason": None, "count": 2},
        {"source": "OK2", "status": "empty", "reason": None, "count": 0},
    ]
    check("msg: дисклеймер >50% упавших", "Больше половины источников недоступно" in notifier.build_analysis_message(dead))


def test_message_variants(payload: dict) -> None:
    error_message = notifier.build_analysis_message(
        dict(payload, deepseek_status="error:invalid_json", tokens=None, duration_ms=None, parsed=None)
    )
    check(
        "msg: ошибка DeepSeek",
        'ошибка после 2 ретраев — "ответ модели не является JSON"' in error_message
        and "Прогноз не получен" in error_message,
    )

    skipped_message = notifier.build_analysis_message(
        dict(payload, deepseek_status="skipped", tokens=None, duration_ms=None, parsed=None)
    )
    check("msg: пустой дайджест", "не вызывался" in skipped_message and "Новостей за окно нет." in skipped_message)

    no_signals = notifier.build_analysis_message(
        dict(payload, parsed={"резюме_рынка": "Тишина.", "идеи": [], "урок_дня": "Ждём.", "сигналов_нет": True})
    )
    check("msg: сигналов нет", "Сигналов нет. Рынок без значимых новостей за окно." in no_signals)

    escaped = notifier.build_analysis_message(
        dict(payload, parsed={"резюме_рынка": "ставка < 20 & инфляция > 5", "идеи": [], "сигналов_нет": True})
    )
    check("msg: экранирование HTML", "&lt; 20" in escaped and "&amp;" in escaped)

    chunks = notifier.split_message("я" * 10000)
    check(
        "msg: разбивка длинного текста",
        len(chunks) > 1 and max(len(chunk) for chunk in chunks) <= config.TELEGRAM_MAX_MESSAGE_LEN,
    )

    check("msg: расписание", "🗓 <b>Расписание:</b>" in notifier.format_schedule())
    startup = notifier.format_startup_message()
    check("msg: сообщение о старте", "Бот запущен." in startup and "10,12,14,16,18,20" in startup)


def test_schedule() -> None:
    noonish = config.now_msk().replace(hour=13, minute=30, second=0, microsecond=0)
    nxt = jobs.next_run_time(noonish)
    check("jobs.next_run_time внутри дня", nxt.hour == 14 and nxt.minute == 0, str(nxt))
    late = config.now_msk().replace(hour=23, minute=10, second=0, microsecond=0)
    check("jobs.next_run_time после 20:00 → 10:00", jobs.next_run_time(late).hour == 10)
    check("jobs.build_trigger часы", "10,12,14,16,18,20" in str(jobs.build_trigger()))
    check("jobs.schedule_human", jobs.schedule_human() == "10, 12, 14, 16, 18, 20", jobs.schedule_human())

    # jobs.get_market_snapshot теперь берёт реальные данные — подменяем источник, без сети
    original_snapshot = quotes.get_snapshot
    quotes.get_snapshot = lambda force=False: quotes.MarketSnapshot(  # type: ignore[assignment]
        captured_at=config.now_msk(),
        usdrub=91.0,
        cnyrub=12.6,
        eurrub=94.0,
        moex_value=2400.0,
        moex_change=-0.5,
        key_rate=14.0,
        source_status={quotes.SOURCE_CBR_RATES: "ok"},
    )
    try:
        snapshot = jobs.get_market_snapshot()
    finally:
        quotes.get_snapshot = original_snapshot  # type: ignore[assignment]
    check(
        "jobs.get_market_snapshot: реальные значения (не заглушка)",
        snapshot["usdrub"] == 91.0 and snapshot["key_rate"] == 14.0
        and snapshot["cnyrub"] == 12.6 and snapshot["moex_value"] == 2400.0,
        str(snapshot),
    )

    fire_time = jobs.build_trigger().get_next_fire_time(None, config.now_msk())
    check(
        "cron: следующий запуск на ровный час МСК",
        fire_time is not None and fire_time.minute == 0 and fire_time.hour in config.ANALYSIS_HOURS,
        str(fire_time),
    )

    bot, session = build_test_bot()
    scheduler = jobs.setup_scheduler(bot)
    job = scheduler.get_job("hourly_analysis")
    check("scheduler: job зарегистрирован с trigger=schedule", job is not None and job.kwargs.get("trigger") == "schedule")
    check("scheduler: max_instances=1 и coalesce=True", job is not None and job.max_instances == 1 and job.coalesce is True)
    check("scheduler: таймзона МСК", str(scheduler.timezone) in ("Europe/Moscow", "MSK"), str(scheduler.timezone))
    check("scheduler: misfire_grace_time=300", job is not None and job.misfire_grace_time == 300)
    check("scheduler: без start() ничего не запущено", scheduler.running is False)

    # Часть 3: второй job — ежедневная проверка идей
    check_job = scheduler.get_job("daily_prediction_check")
    check(
        "scheduler: job проверки идей зарегистрирован",
        check_job is not None and check_job.max_instances == 1 and check_job.coalesce is True,
    )
    check("scheduler: ровно два job'а", len(scheduler.get_jobs()) == 2, str([j.id for j in scheduler.get_jobs()]))

    check_fire = jobs.build_check_trigger().get_next_fire_time(None, config.now_msk())
    check(
        "cron: проверка идей в 21:00 МСК",
        check_fire is not None
        and check_fire.hour == config.PREDICTION_CHECK_HOUR
        and check_fire.minute == config.PREDICTION_CHECK_MINUTE,
        str(check_fire),
    )


def test_db(window_end: datetime) -> None:
    config.DB_PATH = config.BASE_DIR / "_smoke.sqlite3"
    if config.DB_PATH.exists():
        config.DB_PATH.unlink()
    db.init_db()
    run_id = db.save_run(
        started_at=window_end, finished_at=window_end, sources_status=base_sources(),
        deepseek_status="ok", deepseek_tokens=100, deepseek_duration_ms=900,
        digest="A | T", raw_response='{"a": 1}', parsed_json={"идеи": [{"инструмент": "SBER"}]},
        signal_present=True,
    )
    db.save_run(
        started_at=window_end, finished_at=window_end,
        sources_status=[{"source": "X", "status": "error", "reason": "timeout", "count": 0}],
        deepseek_status="error:timeout", deepseek_tokens=None, deepseek_duration_ms=None,
        digest="", raw_response=None, parsed_json=None, signal_present=False,
    )
    check("db.save_run id", run_id == 1, str(run_id))

    last = db.get_last_run()
    check("db.get_last_run", last is not None and last["deepseek_status"] == "error:timeout")
    check("msg: /last", last is not None and "Последний прогон" in notifier.format_last_run(last))

    stats = db.get_stats(days=7)
    summary = {key: value for key, value in stats.items() if key not in ("since", "failed_sources")}
    check(
        "db.get_stats",
        stats["total_runs"] == 2 and stats["with_ideas"] == 1 and stats["deepseek_errors"] == 1
        and stats["source_failures"] == 2,
        str(summary),
    )
    check("db.get_stats failed_sources", stats["failed_sources"] == {"Investing.com": 1, "X": 1}, str(stats["failed_sources"]))
    check("msg: /stats", "Статистика за 7 дней" in notifier.format_stats(stats))
    return stats


def test_horizon() -> None:
    check("horizon: «2-8 недель» → нижняя граница", horizon.parse_horizon_days("2-8 недель") == 14)
    check("horizon: «4 недели»", horizon.parse_horizon_days("4 недели") == 28)
    check("horizon: «1 месяц»", horizon.parse_horizon_days("1 месяц") == 30)
    check("horizon: «3 месяца»", horizon.parse_horizon_days("3 месяца") == 90)
    check(
        "horizon: мусор → 30 дней по умолчанию",
        horizon.parse_horizon_days("когда-нибудь") == config.PREDICTION_DEFAULT_HORIZON_DAYS,
    )
    check("horizon: пусто → 30 дней", horizon.parse_horizon_days(None) == 30)

    created = config.now_msk().replace(microsecond=0)
    check(
        "horizon: check_at = created + горизонт",
        horizon.compute_check_at(created, "2-8 недель") == created + timedelta(days=14),
    )

    check("horizon: рост", horizon.classify_move(100.0, 102.5) == horizon.RISE)
    check("horizon: падение", horizon.classify_move(100.0, 98.0) == horizon.FALL)
    check("horizon: боковик (в пределах ±1%)", horizon.classify_move(100.0, 100.5) == horizon.FLAT)
    check(
        "horizon: без цен → None",
        horizon.classify_move(None, 100.0) is None and horizon.classify_move(100.0, None) is None,
    )
    check("horizon: move_pct", abs((horizon.move_pct(100.0, 110.0) or 0) - 10.0) < 1e-9)

    check("horizon: лонг + рост = попадание", horizon.is_hit("лонг", horizon.RISE) == 1)
    check("horizon: лонг + падение = промах", horizon.is_hit("лонг", horizon.FALL) == 0)
    check("horizon: шорт + падение = попадание", horizon.is_hit("шорт", horizon.FALL) == 1)
    check("horizon: шорт + боковик = промах", horizon.is_hit("шорт", horizon.FLAT) == 0)
    check("horizon: «наблюдать» не считается", horizon.is_hit("наблюдать", horizon.RISE) is None)
    check(
        "horizon: нормализация направления",
        horizon.normalize_direction("ЛОНГ") == "лонг"
        and horizon.normalize_direction("шорт") == "шорт"
        and horizon.normalize_direction("hold") == "наблюдать"
        and horizon.normalize_direction(None) == "наблюдать",
    )


def test_market_quotes_parsers() -> None:
    xml = (
        '<?xml version="1.0" encoding="windows-1251"?>'
        '<ValCurs name="Ключевая ставка Банка России">'
        '<Record Date="05.06.2026" Rate="15.50"/><Record Date="15.10.2026" Rate="14.00"/>'
        "</ValCurs>"
    )
    check("quotes: XML ставки → свежайшая запись", quotes.parse_key_rate_xml(xml) == 14.0)
    check("quotes: XML ставки без даты", quotes.parse_key_rate_xml("<root><Rate>16,25</Rate></root>") == 16.25)
    check("quotes: HTML вместо XML → None", quotes.parse_key_rate_xml("<html><body>404</body></html>") is None)

    html = (
        "<table><tr><th>Дата</th><th>Ставка</th></tr>"
        "<tr><td>15.10.2026</td><td>14,00</td></tr>"
        "<tr><td>14.10.2026</td><td>14,00</td></tr></table>"
    )
    check("quotes: HTML-таблица ставки", quotes.parse_key_rate_html(html) == 14.0)
    check("quotes: HTML без таблицы → None", quotes.parse_key_rate_html("<html></html>") is None)
    check("quotes: _to_float с запятой и процентами", quotes._to_float("14,00%") == 14.0 and quotes._to_float(None) is None)
    check(
        "quotes: тикер из названия инструмента",
        quotes.extract_ticker("SBER") == "SBER"
        and quotes.extract_ticker("GAZP (ао)") == "GAZP"
        and quotes.extract_ticker("ОФЗ 26238") is None
        and quotes.extract_ticker("CNY/RUB") is None,
    )


def test_market_quotes_fallbacks() -> None:
    """Часть 1: живой источник → SQLite → config fallback (проверка без сети)."""
    quotes.reset_cache()
    broken = quotes.LiveQuotes(rates_error="timeout", moex_error="timeout", key_rate_error="timeout")

    # 1. Пустая база + упавшие источники → fallback из config.py
    with db._connect() as conn:
        conn.execute("DELETE FROM market_snapshots")
    empty = quotes.build_snapshot(lambda: broken, save=False)
    check(
        "quotes: полный отказ → fallback config",
        empty.usdrub == config.USDRUB
        and empty.key_rate == config.KEY_RATE
        and empty.moex_value == config.MOEX_VALUE,
    )
    check(
        "quotes: fallback помечен",
        {"usdrub", "cnyrub", "eurrub", "moex_value", "key_rate"} <= set(empty.fallback_values),
    )
    check(
        "quotes: статусы источников",
        empty.source_status[quotes.SOURCE_CBR_RATES] == "error:timeout"
        and empty.source_status[quotes.SOURCE_MOEX_INDEX] == "error:timeout"
        and empty.source_status[quotes.SOURCE_KEY_RATE] == "error:timeout",
    )
    check(
        "quotes: as_row отдаёт все колонки таблицы",
        {
            "captured_at", "usdrub", "cnyrub", "eurrub",
            "moex_value", "moex_change_pct", "key_rate", "source_status",
        }
        <= set(empty.as_row()),
    )

    # 2. Источники упали, но в SQLite есть прошлый снимок → берём его
    db.save_market_snapshot(
        captured_at=config.now_msk(), usdrub=90.0, cnyrub=12.0, eurrub=95.0,
        moex_value=2500.0, moex_change_pct=-1.0, key_rate=16.5,
        source_status={
            quotes.SOURCE_CBR_RATES: "ok",
            quotes.SOURCE_MOEX_INDEX: "ok",
            quotes.SOURCE_KEY_RATE: "ok:html",
        },
    )
    cached = quotes.build_snapshot(lambda: broken, save=False)
    check(
        "quotes: fallback на SQLite при падении источников",
        cached.usdrub == 90.0 and cached.cnyrub == 12.0
        and cached.moex_value == 2500.0 and cached.moex_change == -1.0,
    )
    check(
        "quotes: данные из SQLite помечены stale",
        {"usdrub", "cnyrub", "eurrub", "moex_value", "moex_change"} <= set(cached.stale_values),
    )
    check(
        "quotes: ставка из свежего кэша (< 24 ч)",
        cached.key_rate == 16.5 and cached.source_status[quotes.SOURCE_KEY_RATE] == "cache",
    )

    # 3. Частичный ответ: курсы ok, индекс упал, ставка из живого источника
    partial = quotes.build_snapshot(
        lambda: quotes.LiveQuotes(
            rates={"usdrub": 91.5, "cnyrub": 12.7, "eurrub": 94.1},
            moex_error="http_500",
            key_rate=14.0,
            key_rate_source="html",
        ),
        save=False,
    )
    check(
        "quotes: частичный успех источников",
        partial.usdrub == 91.5
        and partial.source_status[quotes.SOURCE_MOEX_INDEX] == "error:http_500",
    )
    check(
        "quotes: индекс из SQLite, ставка — из кэша 24 ч (живой запрос не нужен)",
        partial.moex_value == 2500.0
        and "moex_value" in partial.stale_values
        and partial.key_rate == 16.5
        and partial.source_status[quotes.SOURCE_KEY_RATE] == "cache",
    )

    # 4. Кэш ставки не считается доверенным, если в прошлом снимке был fallback
    db.save_market_snapshot(
        captured_at=config.now_msk(), usdrub=90.0, cnyrub=12.0, eurrub=95.0,
        moex_value=2500.0, moex_change_pct=-1.0, key_rate=config.KEY_RATE,
        source_status={
            quotes.SOURCE_CBR_RATES: "ok",
            quotes.SOURCE_MOEX_INDEX: "ok",
            quotes.SOURCE_KEY_RATE: "error:timeout",
        },
    )
    fresh = quotes.build_snapshot(
        lambda: quotes.LiveQuotes(
            rates={"usdrub": 91.0},
            moex={"moex_value": 2490.0, "moex_change": -0.4},
            key_rate=20.0,
            key_rate_source="xml",
        ),
        save=False,
    )
    check(
        "quotes: fallback-ставка в кэше не доверенная",
        fresh.key_rate == 20.0 and fresh.source_status[quotes.SOURCE_KEY_RATE] == "ok:xml",
    )

    # 5. Доверенный, но просроченный кэш (> 24 ч) + упавшие источники → stale_cache
    db.save_market_snapshot(
        captured_at=config.now_msk() - timedelta(hours=config.CBR_KEY_RATE_CACHE_HOURS + 2),
        usdrub=89.0, cnyrub=11.9, eurrub=94.0, moex_value=2480.0, moex_change_pct=-0.2, key_rate=17.5,
        source_status={
            quotes.SOURCE_CBR_RATES: "ok",
            quotes.SOURCE_MOEX_INDEX: "ok",
            quotes.SOURCE_KEY_RATE: "ok:html",
        },
    )
    stale = quotes.build_snapshot(lambda: broken, save=False)
    check(
        "quotes: просроченный кэш ставки",
        stale.key_rate == 17.5
        and stale.source_status[quotes.SOURCE_KEY_RATE] == "stale_cache"
        and "key_rate" in stale.stale_values,
    )

    # 6. Неожиданная ошибка фетчера не роняет анализ
    def boom() -> quotes.LiveQuotes:
        raise RuntimeError("тестовый сбой источника")

    crashed = quotes.build_snapshot(boom, save=False)
    check(
        "quotes: исключение фетчера не выходит наружу",
        crashed.usdrub is not None and crashed.moex_value is not None,
    )


async def test_check_predictions() -> None:
    """Часть 3: идеи → predictions → проверка job'ом → статистика → /accuracy."""
    with db._connect() as conn:
        conn.execute("DELETE FROM predictions")

    created = config.now_msk().replace(microsecond=0)
    due_at = created - timedelta(days=1)
    saved = db.save_predictions(
        1,
        created,
        [
            {"ticker": "SBER", "instrument": "SBER", "direction": "лонг", "confidence": "высокая",
             "horizon": "2-8 недель", "entry_price": 285.5, "check_at": due_at},
            {"ticker": "GAZP", "instrument": "GAZP", "direction": "шорт", "confidence": "средняя",
             "horizon": "4 недели", "entry_price": 165.2, "check_at": due_at},
            {"ticker": "YDEX", "instrument": "YDEX", "direction": "лонг", "confidence": "низкая",
             "horizon": "2 недели", "entry_price": 4200.0, "check_at": due_at},
            {"ticker": "LKOH", "instrument": "LKOH", "direction": "наблюдать", "confidence": "низкая",
             "horizon": "3 недели", "entry_price": 6000.0, "check_at": due_at},
            {"ticker": "T", "instrument": "T", "direction": "лонг", "confidence": "средняя",
             "horizon": "4 недели", "entry_price": 300.0, "check_at": created + timedelta(days=20)},
        ],
    )
    check("db.predictions: сохранение идей", saved == 5, str(saved))
    check("db.predictions: к проверке готовы 4", len(db.get_predictions_due(config.now_msk())) == 4)

    prices = {"SBER": 300.0, "GAZP": 170.0, "YDEX": 4100.0, "LKOH": 6100.0}
    original_fetch = quotes.fetch_ticker_price
    original_chat_id = config.TELEGRAM_CHAT_ID
    config.TELEGRAM_CHAT_ID = 4242        # без .env уведомление иначе не отправить
    quotes.fetch_ticker_price = lambda ticker: prices.get(ticker)  # type: ignore[assignment]
    bot, session = build_test_bot()
    try:
        summary = await jobs.check_predictions(bot)
    finally:
        quotes.fetch_ticker_price = original_fetch  # type: ignore[assignment]
        config.TELEGRAM_CHAT_ID = original_chat_id
        await bot.session.close()

    check("jobs.check_predictions: проверено 4 идеи", summary["checked"] == 4, str(summary))
    check(
        "jobs.check_predictions: сообщение в Telegram",
        any("Проверка идей" in text for text in session.texts),
    )

    stats = db.get_prediction_stats(days=30)
    check(
        "db.predictions: итоги проверки",
        stats["total"] == 5 and stats["evaluated"] == 3 and stats["hit"] == 1
        and stats["watchlisted"] == 1 and stats["pending"] == 1,
        str({key: stats[key] for key in ("total", "evaluated", "hit", "watchlisted", "pending")}),
    )
    check("db.predictions: точность ≈ 33%", abs((stats["accuracy"] or 0) - 33.33) < 0.5, str(stats["accuracy"]))
    check(
        "db.predictions: разбивка по уверенности",
        stats["by_confidence"]["высокая"]["hit"] == 1 and stats["by_confidence"]["низкая"]["hit"] == 0,
        str(stats["by_confidence"]),
    )
    check(
        "db.predictions: тикеры проверены",
        {item["ticker"] for item in stats["by_ticker"]} == {"SBER", "GAZP", "YDEX"},
        str(stats["by_ticker"]),
    )
    check("db.count_pending_predictions", db.count_pending_predictions() == 1)

    accuracy_text = notifier.format_accuracy(stats)
    check("msg: /accuracy заголовок", "📊 <b>Точность прогнозов за 30 дней</b>" in accuracy_text)
    check(
        "msg: /accuracy цифры",
        "Всего идей: 5" in accuracy_text
        and "Отработано: 3" in accuracy_text
        and "Точность общая: 33%" in accuracy_text,
    )
    check(
        "msg: /accuracy по уверенности и тикерам",
        "• высокая: 100% (1/1)" in accuracy_text
        and "✅ SBER — 100% (1/1)" in accuracy_text
        and "❌ YDEX — 0% (0/1)" in accuracy_text,
    )
    check(
        "msg: /accuracy хвост",
        "⏳ Ожидают проверки: 1" in accuracy_text
        and "«Наблюдать» (в точность не входят): 1" in accuracy_text,
    )

    # Создание предсказаний из ответа модели: валютная пара и ОФЗ отбрасываются
    quotes.fetch_ticker_price = lambda ticker: prices.get(ticker)  # type: ignore[assignment]
    try:
        created_count = jobs.create_predictions_for_run(
            2,
            {
                "идеи": [
                    {"инструмент": "SBER", "направление": "лонг", "горизонт": "2-8 недель", "уверенность": "средняя"},
                    {"инструмент": "CNY/RUB", "направление": "наблюдать", "горизонт": "4 недели", "уверенность": "низкая"},
                    {"инструмент": "ОФЗ 26238", "направление": "лонг", "горизонт": "2 недели", "уверенность": "низкая"},
                ]
            },
            created,
        )
    finally:
        quotes.fetch_ticker_price = original_fetch  # type: ignore[assignment]
    check("jobs: из 3 идей создана 1 запись", created_count == 1, str(created_count))

    with db._connect() as conn:
        row = conn.execute(
            "SELECT * FROM predictions WHERE run_id = 2 ORDER BY id DESC LIMIT 1"
        ).fetchone()
    check(
        "jobs: цена входа и дата проверки записаны",
        row is not None and row["entry_price"] == 300.0 and row["ticker"] == "SBER"
        and (db.parse_iso(row["check_at"]) or created) == created + timedelta(days=14),
        str(dict(row) if row else None),
    )


def test_tinkoff_without_token() -> None:
    """Часть 4: без токена бот работает, статус — «не настроен»."""
    original = config.TINKOFF_INVEST_TOKEN
    config.TINKOFF_INVEST_TOKEN = None
    tinkoff.reset_client()
    try:
        snapshot = tinkoff.get_portfolio_snapshot(force=True)
    finally:
        config.TINKOFF_INVEST_TOKEN = original
        tinkoff.reset_client()

    check("tinkoff: без токена статус no_token", snapshot.status == tinkoff.STATUS_NO_TOKEN, snapshot.status)
    check(
        "tinkoff: текст статуса без токена",
        "не настроен" in snapshot.status_text() and "TINKOFF_INVEST_TOKEN" in snapshot.status_text(),
    )
    check(
        "tinkoff: без токена нет позиций и промпта",
        snapshot.positions == [] and snapshot.prompt_text() == "",
    )
    check(
        "tinkoff: /portfolio без токена",
        "Работаем без контекста позиций" in notifier.format_portfolio(snapshot),
    )


def _install_fake_tinkoff_sdk() -> Any:
    """Подменяет tinkoff.invest фейковым SDK: read-only путь проверяется без реальной библиотеки."""
    module = types.ModuleType("tinkoff.invest")

    class InstrumentIdType:
        INSTRUMENT_ID_TYPE_FIGI = "figi"
        INSTRUMENT_ID_TYPE_UID = "uid"

    class Money:
        def __init__(self, units: int, nano: int = 0, currency: str = "rub") -> None:
            self.units = units
            self.nano = nano
            self.currency = currency

    class RawPosition:
        def __init__(self, figi: str, kind: str, quantity: float, average: float, current: float) -> None:
            self.figi = figi
            self.instrument_type = kind
            self.instrument_uid = f"uid-{figi}"
            self.quantity = Money(int(quantity))
            self.average_position_price = Money(int(average), int(round((average % 1) * 1e9)))
            self.current_price = Money(int(current), int(round((current % 1) * 1e9)))

    class Account:
        def __init__(self, account_id: str, account_type: str) -> None:
            self.id = account_id
            self.type = account_type

    tickers: dict[str, Any] = {
        "positions": [
            RawPosition("BBG004730N88", "share", 100, 285.5, 292.3),
            RawPosition("BBG004730RP0", "share", 50, 165.2, 158.7),
            RawPosition("BBG0013HSW87", "currency", 1000, 12.85, 12.91),
        ],
        "map": {"BBG004730N88": "SBER", "BBG004730RP0": "GAZP", "BBG0013HSW87": "CNYRUB"},
    }

    class Portfolio:
        def __init__(self) -> None:
            self.positions = tickers["positions"]
            self.total_portfolio_value = Money(45230)

    class Instrument:
        def __init__(self, ticker: str, name: str) -> None:
            self.ticker = ticker
            self.name = name

    class Response:
        def __init__(self, **kwargs: Any) -> None:
            self.__dict__.update(kwargs)

    class _Users:
        def __init__(self, client: Any) -> None:
            self._client = client

        def get_accounts(self, **kwargs: Any) -> Any:
            return Response(accounts=[Account("acc-1", "ACCOUNT_TYPE_TINKOFF")])

    class _Operations:
        def __init__(self, client: Any) -> None:
            self._client = client

        def get_portfolio(self, account_id: str | None = None, **kwargs: Any) -> Any:
            if Client.failure:
                raise RuntimeError(Client.failure)
            self._client.account_id = account_id
            return Portfolio()

    class _Instruments:
        def __init__(self, client: Any) -> None:
            self._client = client

        def get_instrument_by(self, id_type: Any = None, id: str | None = None, **kwargs: Any) -> Any:
            return Response(instrument=Instrument(tickers["map"].get(id or "", ""), "Тестовый инструмент"))

    class Client:
        instances: list[Any] = []
        failure: str | None = None

        def __init__(self, token: str, **kwargs: Any) -> None:
            self.token = token
            self.account_id: str | None = None
            Client.instances.append(self)
            self.users = _Users(self)
            self.operations = _Operations(self)
            self.instruments = _Instruments(self)

        def __enter__(self) -> "Client":
            return self

        def __exit__(self, *args: Any) -> bool:
            return False

    module.Client = Client
    module.InstrumentIdType = InstrumentIdType
    package = types.ModuleType("tinkoff")
    package.invest = module
    sys.modules["tinkoff"] = package
    sys.modules["tinkoff.invest"] = module
    return Client


def test_tinkoff_with_fake_sdk() -> None:
    """Часть 4: SDK-транспорт, разбор позиций, кэш в SQLite, статусы (реальная библиотека не нужна)."""
    original_token = config.TINKOFF_INVEST_TOKEN
    original_retries = config.TINKOFF_RETRIES
    original_delay = config.TINKOFF_RETRY_DELAY_SEC
    original_transport = config.TINKOFF_TRANSPORT
    config.TINKOFF_INVEST_TOKEN = "t.test-token"
    config.TINKOFF_TRANSPORT = "sdk"      # проверяется опциональный gRPC-путь
    config.TINKOFF_RETRIES = 0            # в тесте без 3-секундных пауз
    config.TINKOFF_RETRY_DELAY_SEC = 0
    tinkoff.reset_client()
    client_cls = _install_fake_tinkoff_sdk()

    try:
        snapshot = tinkoff.get_portfolio_snapshot(force=True)
        check("tinkoff: позиции разобраны", len(snapshot.positions) == 3, str(len(snapshot.positions)))
        check("tinkoff: выбран брокерский счет", snapshot.account_id == "acc-1", str(snapshot.account_id))
        check(
            "tinkoff: FIGI→тикер",
            [position.ticker for position in snapshot.positions] == ["SBER", "GAZP", "CNYRUB"],
            str([position.ticker for position in snapshot.positions]),
        )
        check(
            "tinkoff: P&L позиции",
            abs((snapshot.positions[0].pnl_pct or 0) - 2.4) < 0.1,
            str(snapshot.positions[0].pnl_pct),
        )
        check("tinkoff: стоимость портфеля", snapshot.total_value == 45230.0, str(snapshot.total_value))
        check(
            "tinkoff: строка статуса",
            snapshot.status_text() == "💼 Tinkoff: ok | 3 позиции, 45 230 ₽",
            snapshot.status_text(),
        )

        prompt_text = snapshot.prompt_text()
        check(
            "tinkoff: блок позиций для промпта",
            "Мои открытые позиции:" in prompt_text
            and "- SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)" in prompt_text
            and "Общая стоимость портфеля: 45 230 ₽" in prompt_text,
            prompt_text.replace("\n", " | "),
        )

        portfolio_text = notifier.format_portfolio(snapshot)
        check(
            "tinkoff: /portfolio",
            "• <b>SBER</b> — 100 шт" in portfolio_text and "Итого: <b>45 230 ₽</b>" in portfolio_text,
        )
        check(
            "tinkoff: кэш позиций в SQLite",
            isinstance(db.cache_get(tinkoff.CACHE_KEY_PORTFOLIO, ttl_sec=config.TINKOFF_POSITIONS_CACHE_TTL_SEC), dict),
        )
        check(
            "tinkoff: FIGI→тикер сохранён в кэш",
            "BBG004730N88" in (db.cache_get(tinkoff.CACHE_KEY_FIGI_MAP) or {}),
        )

        calls_before = len(client_cls.instances)
        cached = tinkoff.get_portfolio_snapshot()
        check(
            "tinkoff: повторный вызов берёт кэш (5 минут)",
            cached.ok and len(client_cls.instances) == calls_before,
        )

        client_cls.failure = "RequestError: code=40003 token is not active"
        expired = tinkoff.get_portfolio_snapshot(force=True)
        check(
            "tinkoff: 40003 → токен истёк",
            expired.status == tinkoff.STATUS_TOKEN_EXPIRED and "токен истёк" in expired.status_text(),
            expired.status_text(),
        )
        check(
            "tinkoff: при ошибке прогноз идёт без позиций",
            expired.positions == [] and expired.prompt_text() == "",
        )

        client_cls.failure = "Deadline Exceeded: timeout"
        timed_out = tinkoff.get_portfolio_snapshot(force=True)
        check(
            "tinkoff: timeout → статус timeout",
            timed_out.status == tinkoff.STATUS_TIMEOUT and "timeout" in timed_out.status_text(),
            timed_out.status_text(),
        )

        client_cls.failure = "unknown grpc error"
        broken = tinkoff.get_portfolio_snapshot(force=True)
        check(
            "tinkoff: прочие сбои → статус error",
            broken.status == tinkoff.STATUS_ERROR and "прогноз без учёта позиций" in broken.status_text(),
            broken.status_text(),
        )
    finally:
        client_cls.failure = None
        sys.modules.pop("tinkoff.invest", None)
        sys.modules.pop("tinkoff", None)
        config.TINKOFF_INVEST_TOKEN = original_token
        config.TINKOFF_TRANSPORT = original_transport
        config.TINKOFF_RETRIES = original_retries
        config.TINKOFF_RETRY_DELAY_SEC = original_delay
        tinkoff.reset_client()

    # Библиотека физически отсутствует: статус вместо исключения
    config.TINKOFF_INVEST_TOKEN = "t.test-token"
    config.TINKOFF_TRANSPORT = "sdk"       # недоступный SDK-транспорт не должен ронять бота
    config.TINKOFF_RETRIES = 0
    tinkoff.reset_client()
    try:
        missing = tinkoff.get_portfolio_snapshot(force=True)
    finally:
        config.TINKOFF_INVEST_TOKEN = original_token
        config.TINKOFF_TRANSPORT = original_transport
        config.TINKOFF_RETRIES = original_retries
        tinkoff.reset_client()
    check(
        "tinkoff: без библиотеки — понятный статус, без падения",
        missing.status
        in (tinkoff.STATUS_LIBRARY_MISSING, tinkoff.STATUS_ERROR, tinkoff.STATUS_TIMEOUT)
        and bool(missing.status_text()),
        f"{missing.status}: {missing.status_text()}",
    )


class _FakeRestResponse:
    """Мини-ответ requests: status_code + тело (dict отдаётся через .json())."""

    def __init__(self, status_code: int, payload: Any = None) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload) if payload is not None else ""

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("тело ответа не JSON")
        return self._payload


class _FakeRestSession:
    """Поддельная requests.Session: журнал запросов + ответ из handler(url, payload)."""

    def __init__(self, handler: Any) -> None:
        self.handler = handler
        self.headers: dict[str, str] = {}
        self.calls: list[tuple[str, dict[str, Any], dict[str, str], Any]] = []
        self.closed = False

    def post(self, url: str, json: Any = None, headers: Any = None, timeout: Any = None) -> Any:
        body = json if isinstance(json, dict) else {}
        self.calls.append((url, body, dict(headers or {}), timeout))
        return self.handler(url, body)

    def close(self) -> None:
        self.closed = True


# Ответы gRPC-gateway: int64 (`units`) приходят СТРОКАМИ, имена полей — camelCase
REST_ACCOUNTS_PAYLOAD: dict[str, Any] = {
    "accounts": [
        {
            "id": "acc-rest",
            "type": "ACCOUNT_TYPE_TINKOFF",
            "status": "ACCOUNT_STATUS_OPEN",
            "accessLevel": "ACCOUNT_ACCESS_LEVEL_FULL_ACCESS",
        }
    ]
}
REST_PORTFOLIO_PAYLOAD: dict[str, Any] = {
    "totalPortfolioValue": {"currency": "rub", "units": "45230", "nano": 0},
    "positions": [
        {
            "figi": "BBG_REST_1",
            "instrumentUid": "uid-REST-1",
            "instrumentType": "share",
            "ticker": "SBER",
            "quantity": {"units": "100", "nano": 0},
            "averagePositionPrice": {"currency": "rub", "units": "285", "nano": 500000000},
            "currentPrice": {"currency": "rub", "units": "292", "nano": 300000000},
        },
        {
            "figi": "BBG_REST_2",
            "instrumentUid": "uid-REST-2",
            "instrumentType": "bond",
            "quantity": {"units": "5", "nano": 0},
            "averagePositionPrice": {"currency": "rub", "units": "1000", "nano": 0},
            "currentPrice": {"currency": "rub", "units": "1010", "nano": 0},
        },
    ],
}
REST_INSTRUMENT_PAYLOAD: dict[str, Any] = {
    "instrument": {"figi": "BBG_REST_2", "ticker": "OFZ-REST", "name": "ОФЗ тест"}
}


def _rest_handler(url: str, payload: dict[str, Any]) -> Any:
    """Правдоподобные ответы REST T-Invest API (только read-only методы)."""
    if "UsersService/GetAccounts" in url:
        return _FakeRestResponse(200, REST_ACCOUNTS_PAYLOAD)
    if "OperationsService/GetPortfolio" in url:
        return _FakeRestResponse(200, REST_PORTFOLIO_PAYLOAD)
    if "InstrumentsService/GetInstrumentBy" in url:
        return _FakeRestResponse(200, REST_INSTRUMENT_PAYLOAD)
    return _FakeRestResponse(404, {"message": f"нет метода {url}"})


def test_tinkoff_rest_transport() -> None:
    """REST T-Invest API: proto3-JSON, кэш, статусы ошибок, резервный хост — без сети."""
    original_token = config.TINKOFF_INVEST_TOKEN
    original_transport = config.TINKOFF_TRANSPORT
    original_retries = config.TINKOFF_RETRIES
    original_delay = config.TINKOFF_RETRY_DELAY_SEC
    config.TINKOFF_INVEST_TOKEN = "t.rest-token"
    config.TINKOFF_TRANSPORT = "rest"
    config.TINKOFF_RETRIES = 0
    config.TINKOFF_RETRY_DELAY_SEC = 0
    tinkoff.reset_client()

    session = _FakeRestSession(_rest_handler)
    client = tinkoff.TinkoffPortfolioClient(
        "t.rest-token", transport=tinkoff.RestTransport("t.rest-token", session=session)
    )
    try:
        snapshot = client.get_portfolio_snapshot(force=True)

        check("tinkoff REST: снимок получен", snapshot.status == tinkoff.STATUS_OK, snapshot.status_text())
        check("tinkoff REST: позиции разобраны", len(snapshot.positions) == 2, str(len(snapshot.positions)))
        check("tinkoff REST: тикер взят из позиции", snapshot.positions[0].ticker == "SBER")
        check(
            "tinkoff REST: FIGI→тикер через GetInstrumentBy",
            snapshot.positions[1].ticker == "OFZ-REST",
            snapshot.positions[1].ticker,
        )
        check(
            "tinkoff REST: количество из строки «100»",
            abs(snapshot.positions[0].quantity - 100) < 1e-9,
            str(snapshot.positions[0].quantity),
        )
        check(
            "tinkoff REST: средняя цена units+nano",
            abs((snapshot.positions[0].average_price or 0) - 285.5) < 1e-6,
            str(snapshot.positions[0].average_price),
        )
        check("tinkoff REST: стоимость портфеля", snapshot.total_value == 45230.0, str(snapshot.total_value))
        check("tinkoff REST: выбран брокерский счет", snapshot.account_id == "acc-rest", str(snapshot.account_id))
        check(
            "tinkoff REST: строка статуса",
            snapshot.status_text() == "💼 Tinkoff: ok | 2 позиции, 45 230 ₽",
            snapshot.status_text(),
        )
        check(
            "tinkoff REST: заголовок Authorization: Bearer",
            bool(session.calls) and all(c[2].get("Authorization") == "Bearer t.rest-token" for c in session.calls),
        )
        check(
            "tinkoff REST: вызываются только три read-only метода",
            [call[0].rsplit("/", 1)[-1] for call in session.calls]
            == ["GetAccounts", "GetPortfolio", "GetInstrumentBy"],
            str([call[0].rsplit("/", 1)[-1] for call in session.calls]),
        )
        check(
            "tinkoff REST: FIGI→тикер попал в кэш SQLite",
            "BBG_REST_2" in (db.cache_get(tinkoff.CACHE_KEY_FIGI_MAP) or {}),
        )
        check(
            "tinkoff REST: кэш позиций в SQLite",
            isinstance(db.cache_get(tinkoff.CACHE_KEY_PORTFOLIO), dict),
        )

        def snapshot_with(handler_fn: Any, retries: int = 0) -> tuple[Any, _FakeRestSession]:
            """Снимок на поддельной сессии; один хост — чтобы точно считать попытки."""
            config.TINKOFF_RETRIES = retries
            fake = _FakeRestSession(handler_fn)
            transport = tinkoff.RestTransport("t.rest-token", ["https://api.test"], fake)
            result = tinkoff.TinkoffPortfolioClient(
                "t.rest-token", transport
            ).get_portfolio_snapshot(force=True)
            return result, fake

        expired, _ = snapshot_with(
            lambda url, payload: _FakeRestResponse(401, {"code": 16, "description": "40003"})
        )
        check(
            "tinkoff REST: 401 + 40003 → токен истёк",
            expired.status == tinkoff.STATUS_TOKEN_EXPIRED and "токен истёк" in expired.status_text(),
            expired.status_text(),
        )

        limited, _ = snapshot_with(
            lambda url, payload: _FakeRestResponse(429, {"code": 8, "message": "RESOURCE_EXHAUSTED"})
        )
        check(
            "tinkoff REST: 429 → лимит запросов",
            limited.status == tinkoff.STATUS_RATE_LIMITED and limited.positions == [],
            limited.status_text(),
        )

        def _timeout_handler(url: str, payload: dict[str, Any]) -> Any:
            raise requests.exceptions.Timeout("connect timeout")

        timed_out, _ = snapshot_with(_timeout_handler)
        check(
            "tinkoff REST: timeout → статус timeout",
            timed_out.status == tinkoff.STATUS_TIMEOUT,
            timed_out.status_text(),
        )

        unreliable, retry_session = snapshot_with(
            lambda url, payload: _FakeRestResponse(503, {"message": "unavailable"}), retries=1
        )
        check(
            "tinkoff REST: 503 повторяется (2 попытки)",
            len(retry_session.calls) == 2 and unreliable.status == tinkoff.STATUS_ERROR,
            f"{len(retry_session.calls)} попыток, {unreliable.status}",
        )

        seen_hosts: list[str] = []

        def _failover_handler(url: str, payload: dict[str, Any]) -> Any:
            seen_hosts.append(url)
            if url.startswith("https://primary.test"):
                raise requests.exceptions.ConnectionError("нет маршрута")
            return _rest_handler(url, payload)

        failover_session = _FakeRestSession(_failover_handler)
        failover_transport = tinkoff.RestTransport(
            "t.rest-token", ["https://primary.test", "https://backup.test"], failover_session
        )
        failover_snapshot = tinkoff.TinkoffPortfolioClient(
            "t.rest-token", failover_transport
        ).get_portfolio_snapshot(force=True)
        check(
            "tinkoff REST: сбой основного хоста → резервный",
            failover_snapshot.ok and failover_transport._base_urls[0] == "https://backup.test",
            str(seen_hosts),
        )
        check("tinkoff REST: хост переехал в конец списка", failover_transport._base_urls[1] == "https://primary.test")
        failover_session.close()
        check("tinkoff REST: закрытие сессии транспортом", failover_session.closed is True)

    finally:
        config.TINKOFF_INVEST_TOKEN = original_token
        config.TINKOFF_TRANSPORT = original_transport
        config.TINKOFF_RETRIES = original_retries
        config.TINKOFF_RETRY_DELAY_SEC = original_delay
        tinkoff.reset_client()


def test_notifier_new_blocks(window_end: datetime) -> None:
    """Часть 4/5: статус Tinkoff в сообщении, блок предупреждений, /last, проверка идей."""
    payload = ok_payload(window_end)
    check("msg: без предупреждений блока нет", "По вашим позициям" not in notifier.build_analysis_message(payload))

    with_warnings = dict(payload)
    with_warnings["parsed"] = dict(
        payload["parsed"],
        предупреждения_по_позициям=[
            {
                "инструмент": "GAZP",
                "позиция": "50 шт, -3.9%",
                "риск": "негативно",
                "обоснование": "Новость о снижении экспортных пошлин давит на бумагу",
                "рекомендация": "наблюдать, не усреднять",
            }
        ],
    )
    with_warnings["tinkoff_status"] = "💼 Tinkoff: ok | 5 позиций, 45 230 ₽"
    message = notifier.build_analysis_message(with_warnings)

    check("msg: строка статуса Tinkoff", "💼 Tinkoff: ok | 5 позиций, 45 230 ₽" in message)
    check(
        "msg: блок предупреждений по позициям",
        "⚠️ <b>По вашим позициям:</b>" in message
        and "• GAZP — негативно (50 шт, -3.9%): Новость о снижении экспортных пошлин давит на бумагу" in message
        and "  Рекомендация: наблюдать, не усреднять" in message,
    )
    check(
        "msg: предупреждения идут до «Следующий анализ»",
        message.index("По вашим позициям") < message.index("⏭️ Следующий анализ в"),
    )
    check(
        "msg: блок предупреждений экранируется",
        "&lt;b&gt;" in notifier.build_analysis_message(
            dict(
                with_warnings,
                parsed=dict(
                    with_warnings["parsed"],
                    предупреждения_по_позициям=[{"инструмент": "SBER", "риск": "негативно", "обоснование": "<b>жирный&амперсанд</b>"}],
                ),
            )
        ),
    )

    fake_run = {
        "started_at": "2026-10-15T12:00:00+03:00",
        "deepseek_status": "ok",
        "deepseek_tokens": 100,
        "deepseek_duration_ms": 1200,
        "sources_status": "[]",
        "digest": "A | T",
        "parsed_json": None,
        "tinkoff_status": "💼 Tinkoff: ok | 5 позиций, 45 230 ₽",
    }
    check("msg: /last показывает Tinkoff", "💼 Tinkoff: ok | 5 позиций, 45 230 ₽" in notifier.format_last_run(fake_run))
    check("msg: /last без Tinkoff не падает", "Последний прогон" in notifier.format_last_run(dict(fake_run, tinkoff_status=None)))

    check(
        "msg: итог проверки идей",
        "🔍 <b>Проверка идей</b>" in notifier.format_predictions_check(
            [
                {"ticker": "SBER", "direction": "лонг", "realized_direction": horizon.RISE, "hit": 1, "change_pct": 5.1},
                {"ticker": "YDEX", "direction": "лонг", "realized_direction": horizon.FALL, "hit": 0, "change_pct": -2.4},
                {"ticker": "LKOH", "direction": "наблюдать", "realized_direction": horizon.RISE, "hit": None, "change_pct": 1.7},
            ]
        )
        and "✅ SBER — лонг → рост (+5.1%)" in notifier.format_predictions_check(
            [{"ticker": "SBER", "direction": "лонг", "realized_direction": horizon.RISE, "hit": 1, "change_pct": 5.1}]
        ),
    )


def test_live_collect() -> None:
    live_start = config.now_msk() - timedelta(hours=48)
    live_end = config.now_msk()
    sources, items = collector.collect_all(live_start, live_end)
    for source in sources:
        print(f"      live: {source['source']:<15} {source['status']:<6} {source['count']:>3} новостей, reason={source['reason']}")
    check("live: хотя бы один источник ok", any(s["status"] == "ok" for s in sources), f"items={len(items)}")
    return sources, items


def test_market_live() -> None:
    """Часть 1 вживую: ЦБ РФ (курсы, ставка) и MOEX ISS (индекс, цены)."""
    rates = quotes.fetch_cbr_rates()
    check(
        "live quotes: курсы ЦБ РФ",
        rates.get("usdrub", 0) > 1 and rates.get("cnyrub", 0) > 1 and rates.get("eurrub", 0) > 1,
        str(rates),
    )

    index = quotes.fetch_moex_index()
    check("live quotes: IMOEX с MOEX ISS", index["moex_value"] > 100, str(index))

    key_rate, source = quotes.fetch_key_rate()
    check("live quotes: ключевая ставка ЦБ", key_rate is not None and 0 < key_rate < 100, f"{key_rate} ({source})")

    price = quotes.fetch_ticker_price("SBER")
    check("live quotes: цена SBER", price is not None and price > 1, str(price))
    check("live quotes: неизвестный тикер → None", quotes.fetch_ticker_price("ZZZZZZ") is None)

    quotes.reset_cache()
    snapshot = quotes.build_snapshot()
    check(
        "live quotes: снимок рынка целиком",
        snapshot.usdrub is not None and snapshot.moex_value is not None and snapshot.key_rate is not None,
        snapshot.log_line(),
    )
    check("live quotes: снимок записан в SQLite", db.get_last_market_snapshot() is not None)


class RecordingSession(BaseSession):
    """Мок-сессия aiogram: перехватывает вызовы Bot API и возвращает правдоподобные ответы."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[Any] = []

    async def make_request(self, bot: Any, method: Any, timeout: Any = None) -> Any:
        self.calls.append(method)
        if isinstance(method, SendMessage):
            return Message(
                message_id=len(self.calls),
                date=config.now_msk(),
                chat=Chat(id=method.chat_id, type="private"),
                text=method.text or "",
            )
        return True

    async def stream_content(
        self, url: str, headers: Any = None, timeout: int = 30, chunk_size: int = 65536, raise_for_status: bool = True
    ) -> Any:
        yield b""

    async def close(self) -> None:
        return None

    @property
    def texts(self) -> list[str]:
        """Тексты отправленных сообщений."""
        return [str(method.text) for method in self.calls if isinstance(method, SendMessage)]


def build_test_bot(session: RecordingSession | None = None) -> tuple[Bot, RecordingSession]:
    """Настоящий aiogram Bot с мок-сессией: проверяет реальный путь отправки сообщений."""
    session = session or RecordingSession()
    bot = Bot(
        token="123456:TEST_TOKEN",
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    return bot, session


def make_message(bot: Bot, text: str = "/help") -> Message:
    """Собирает настоящую модель aiogram Message и привязывает к ней бота (как это делает aiogram)."""
    message = Message(
        message_id=1,
        date=config.now_msk(),
        chat=Chat(id=config.TELEGRAM_CHAT_ID or 1, type="private"),
        from_user=User(id=1, is_bot=False, first_name="Tester"),
        text=text,
    )
    message.as_(bot)
    return message


async def test_handlers() -> None:
    check("handlers: зарегистрировано 9 хендлеров", len(handlers.router.message.handlers) == 9)
    bot, session = build_test_bot()
    message = make_message(bot)
    check("handlers: message.bot привязан", message.bot is bot)
    check("bot: parse_mode по умолчанию HTML", bot.default.parse_mode == ParseMode.HTML)

    await handlers.cmd_help(message)
    check("handlers: /help отдаёт HELP_TEXT", session.texts[-1] == handlers.HELP_TEXT)
    await handlers.cmd_schedule(message)
    check(
        "handlers: /schedule показывает расписание",
        "Следующий запуск" in session.texts[-1] and "10:00, 12:00, 14:00, 16:00, 18:00, 20:00" in session.texts[-1],
    )
    await handlers.cmd_start(message)
    check(
        "handlers: /start",
        "News Analyst Bot" in session.texts[-1] and "10:00" in session.texts[-1] and "/now" in session.texts[-1],
    )
    await handlers.cmd_last(message)
    check("handlers: /last читает БД", "Последний прогон" in session.texts[-1])
    await handlers.cmd_stats(message)
    check("handlers: /stats читает БД", "Статистика за 7 дней" in session.texts[-1])
    await handlers.cmd_accuracy(message)
    check(
        "handlers: /accuracy читает predictions",
        "Точность прогнозов за 30 дней" in session.texts[-1] and "Ожидают проверки" in session.texts[-1],
    )

    saved_token = config.TINKOFF_INVEST_TOKEN
    config.TINKOFF_INVEST_TOKEN = None          # детерминированно: без обращения к API
    tinkoff.reset_client()
    try:
        await handlers.cmd_portfolio(message)
    finally:
        config.TINKOFF_INVEST_TOKEN = saved_token
        tinkoff.reset_client()
    check("handlers: /portfolio отвечает снимком", "Портфель Tinkoff" in session.texts[-1])
    check(
        "handlers: /portfolio без токена сообщает причину",
        "не настроен" in session.texts[-1],
        session.texts[-1][:80],
    )
    check("handlers: /help знает про /accuracy и /portfolio", "/accuracy" in handlers.HELP_TEXT and "/portfolio" in handlers.HELP_TEXT)
    await handlers.cmd_unknown(message)
    check("handlers: неизвестная команда", session.texts[-1].startswith("Неизвестная команда"))
    sent = [method for method in session.calls if isinstance(method, SendMessage)]
    check("handlers: все ответы с отключённым предпросмотром", all(m.disable_web_page_preview is True for m in sent))
    check("handlers: ответы адресованы тому же чату", all(m.chat_id == message.chat.id for m in sent))

    original_run = jobs.run_analysis
    original_running = jobs.is_analysis_running
    calls: list[tuple[object, str]] = []

    async def fake_run(bot_arg: object, trigger: str = "schedule") -> dict[str, object]:
        calls.append((bot_arg, trigger))
        return {"run_id": 1}

    async def failing_run(bot_arg: object, trigger: str = "schedule") -> None:
        calls.append((bot_arg, trigger))
        return None

    try:
        jobs.run_analysis = fake_run  # type: ignore[assignment]
        await handlers.cmd_now(message)
        check("handlers: /now передаёт message.bot и trigger=manual", calls == [(bot, "manual")], str(calls))
        check("handlers: /now отвечает «Запускаю»", "Запускаю анализ" in session.texts[-1])

        jobs.run_analysis = failing_run  # type: ignore[assignment]
        calls.clear()
        await handlers.cmd_now(message)
        check("handlers: /now при сбое", "Анализ не удался" in session.texts[-1])

        jobs.is_analysis_running = lambda: True  # type: ignore[assignment]
        calls.clear()
        await handlers.cmd_now(message)
        check(
            "handlers: /now при активном анализе ничего не запускает",
            not calls and "уже выполняется" in session.texts[-1],
        )
    finally:
        jobs.run_analysis = original_run  # type: ignore[assignment]
        jobs.is_analysis_running = original_running  # type: ignore[assignment]
    await bot.session.close()


class FailingOnceSession(RecordingSession):
    """Первое сообщение отклоняется Telegram (невалидный HTML), дальше — успех."""

    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    async def make_request(self, bot: Any, method: Any, timeout: Any = None) -> Any:
        if isinstance(method, SendMessage) and not self.failed:
            self.failed = True
            raise TelegramBadRequest(method=method, message="Bad Request: can't parse entities")
        return await super().make_request(bot, method, timeout)


async def test_notifier_send() -> None:
    bot, session = build_test_bot()
    config.TELEGRAM_CHAT_ID = 4242
    long_text = "Очень длинная новость про ключевую ставку. " * 300  # ~12 000 символов
    delivered = await notifier.send_message(bot, long_text)
    sent = [m for m in session.calls if isinstance(m, SendMessage)]
    check("notifier: длинное сообщение разбито на части", len(sent) > 1, f"частей={len(sent)}")
    check("notifier: отправка помечена успешной", delivered is True)
    check("notifier: все части в пределах лимита Telegram", all(len(m.text or "") <= 4096 for m in sent))
    check("notifier: parse_mode=HTML задан явно", all(m.parse_mode == ParseMode.HTML for m in sent))
    check("notifier: адресат — TELEGRAM_CHAT_ID", all(m.chat_id == 4242 for m in sent))
    await bot.session.close()

    failing_bot, failing_session = build_test_bot(FailingOnceSession())
    delivered = await notifier.send_message(failing_bot, "<b>Сломанный HTML</b> &amp; инфляция")
    check("notifier: повтор без разметки после ошибки Telegram", delivered is True)
    check(
        "notifier: fallback ушёл без HTML-тегов",
        failing_session.texts[-1] == "Сломанный HTML & инфляция",
        failing_session.texts[-1],
    )
    check("notifier: strip_html", notifier.strip_html("<i>а</i> &amp; <b>б</b>") == "а & б")
    await failing_bot.session.close()


async def test_deepseek_without_key() -> None:
    original = config.DEEPSEEK_API_KEY
    config.DEEPSEEK_API_KEY = None
    result = await DeepSeekClient().analyze(
        digest="A | T | text", window_start="12:00", window_end="14:00",
        key_rate=16.0, moex_value=3200.0, moex_change=0.0, usdrub=92.0,
    )
    config.DEEPSEEK_API_KEY = original
    check("client: без ключа → error:no_api_key", result.status == "error:no_api_key", result.status)


async def test_end_to_end() -> None:
    """Полный прогон run_analysis с заглушкой бота и реальным RSS."""

    class FakeBot:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send_message(self, chat_id: int, text: str, **kwargs: object) -> None:
            self.sent.append(text)

    config.DB_PATH = config.BASE_DIR / "_smoke.sqlite3"
    config.TELEGRAM_CHAT_ID = 123456789
    config.NEWS_WINDOW_MINUTES = 1440  # в тесте окно шире, чтобы новости точно были

    bot = FakeBot()
    payload = await jobs.run_analysis(bot, trigger="manual")  # type: ignore[arg-type]
    check("e2e: run_analysis вернул результат", isinstance(payload, dict))
    check("e2e: сообщение отправлено", len(bot.sent) == 1 and len(bot.sent[0]) > 100, f"частей={len(bot.sent)}")

    if isinstance(payload, dict):
        check("e2e: дайджест не пуст", payload["digest_lines"] > 0, f"строк={payload['digest_lines']}")
        check("e2e: шесть источников в отчёте", len(payload["sources"]) == 6)
        check(
            "e2e: статус DeepSeek зафиксирован",
            payload["deepseek_status"] == "ok" or payload["deepseek_status"].startswith("error:"),
            payload["deepseek_status"],
        )
        check("e2e: прогон записан в БД", db.get_last_run() is not None)
        check(
            "e2e: рыночный контекст в payload",
            isinstance(payload.get("market"), dict) and "usdrub" in payload["market"] and "cnyrub" in payload["market"],
            str(payload.get("market")),
        )
        check(
            "e2e: статус Tinkoff в сообщении",
            "💼 Tinkoff:" in (payload.get("tinkoff_status") or ""),
            str(payload.get("tinkoff_status")),
        )
        check("e2e: снимок рынка сохранён в SQLite", db.get_last_market_snapshot() is not None)
        check("e2e: статус Tinkoff сохранён в runs", bool((db.get_last_run() or {}).get("tinkoff_status")))
        check(
            "e2e: счётчик предсказаний посчитан",
            isinstance(payload.get("predictions_created"), int),
            str(payload.get("predictions_created")),
        )
        if payload.get("predictions_created"):
            check(
                "e2e: идеи попали в predictions",
                db.get_prediction_stats()["total"] > 0,
                str(db.get_prediction_stats()["total"]),
            )

        # Повторный одновременный запуск должен быть отклонён (lock)
        check("e2e: повторный запуск после завершения работает", jobs.is_analysis_running() is False)

    if bot.sent:
        print("\n--- ТЕЛЕГРАМ-СООБЩЕНИЕ (заглушка) ---\n" + bot.sent[0][:2500] + "\n--- КОНЕЦ ---\n")


async def main() -> None:
    test_dedup()
    test_collector()
    test_prompts_and_json()
    window_end = config.now_msk()
    payload = ok_payload(window_end)
    test_messages(window_end)
    test_message_variants(payload)
    test_notifier_new_blocks(window_end)
    test_horizon()
    test_market_quotes_parsers()
    test_schedule()
    test_db(window_end)
    test_market_quotes_fallbacks()
    await test_check_predictions()
    test_tinkoff_without_token()
    test_tinkoff_with_fake_sdk()
    test_tinkoff_rest_transport()
    await test_handlers()
    await test_notifier_send()
    await test_deepseek_without_key()
    test_live_collect()
    test_market_live()
    await test_end_to_end()

    print()
    print(f"Выполнено проверок: {len(TOTAL)}")
    if FAILED:
        print(f"ПРОВАЛЕНО ПРОВЕРОК: {len(FAILED)} -> {FAILED}")
        raise SystemExit(1)
    print("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ")


if __name__ == "__main__":
    asyncio.run(main())
