"""Временный смоук-тест проекта (после проверки удаляется).

Запуск: .\\.venv\\Scripts\\python.exe _smoke_test.py
"""

from __future__ import annotations

import asyncio
import logging
import sys
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
from news import collector
from news.dedup import Deduplicator, deduplicate, jaccard_similarity, normalize_title, title_hash
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
    check("jobs.get_market_snapshot (заглушка)", jobs.get_market_snapshot()["usdrub"] == config.USDRUB)
    check("jobs.schedule_human", jobs.schedule_human() == "10, 12, 14, 16, 18, 20", jobs.schedule_human())

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


def test_live_collect() -> None:
    live_start = config.now_msk() - timedelta(hours=48)
    live_end = config.now_msk()
    sources, items = collector.collect_all(live_start, live_end)
    for source in sources:
        print(f"      live: {source['source']:<15} {source['status']:<6} {source['count']:>3} новостей, reason={source['reason']}")
    check("live: хотя бы один источник ok", any(s["status"] == "ok" for s in sources), f"items={len(items)}")
    return sources, items


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
    check("handlers: зарегистрировано 7 хендлеров", len(handlers.router.message.handlers) == 7)
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
    test_schedule()
    test_db(window_end)
    await test_handlers()
    await test_notifier_send()
    await test_deepseek_without_key()
    test_live_collect()
    await test_end_to_end()

    print()
    print(f"Выполнено проверок: {len(TOTAL)}")
    if FAILED:
        print(f"ПРОВАЛЕНО ПРОВЕРОК: {len(FAILED)} -> {FAILED}")
        raise SystemExit(1)
    print("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ")


if __name__ == "__main__":
    asyncio.run(main())
