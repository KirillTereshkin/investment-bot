"""Конфигурация проекта.

Все секреты читаются только из .env (образец — .env.example).
Модуль не содержит тяжёлых зависимостей: его импортируют все остальные модули.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

# Корень проекта (папка, в которой лежит этот файл)
BASE_DIR = Path(__file__).resolve().parent

# Читаем .env рядом с config.py
load_dotenv(BASE_DIR / ".env")


def _get_int_env(name: str) -> int | None:
    """Читает целочисленную переменную окружения, не роняя импорт при мусоре в .env."""
    raw = os.getenv(name)
    if not raw:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        logging.getLogger(__name__).error("Переменная %s должна быть целым числом, получено: %r", name, raw)
        return None


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN: str | None = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID: int | None = _get_int_env("TELEGRAM_CHAT_ID")

# ---------------------------------------------------------------------------
# DeepSeek (OpenAI-совместимый API)
# ---------------------------------------------------------------------------
DEEPSEEK_API_KEY: str | None = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"
DEEPSEEK_TEMPERATURE = 0.3
DEEPSEEK_MAX_TOKENS = 1000
DEEPSEEK_TIMEOUT_SEC = 60
DEEPSEEK_RETRIES = 2          # число ПОВТОРНЫХ попыток (итого попыток = 3)
DEEPSEEK_RETRY_DELAY_SEC = 5

# ---------------------------------------------------------------------------
# Расписание
# ---------------------------------------------------------------------------
ANALYSIS_HOURS = [10, 12, 14, 16, 18, 20]   # МСК
TIMEZONE = "Europe/Moscow"
NEWS_WINDOW_MINUTES = 120                    # окно сбора = интервал расписания
MAX_DIGEST_LINES = 25
SOURCE_TIMEOUT_SEC = 10
SOURCE_RETRIES = 2                           # число ПОВТОРНЫХ попыток на источник
SOURCE_RETRY_DELAY_SEC = 3

# ---------------------------------------------------------------------------
# Котировки (market/quotes.py)
# ---------------------------------------------------------------------------
# Индекс MOEX (IMOEX) и цены тикеров берутся с MOEX ISS (без ключа, задержка ~15 мин).
MOEX_ISS_BASE_URL = "https://iss.moex.com/iss"
MOEX_ISS_INDEX_URL = (
    "https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json"
)
MOEX_ISS_SHARES_URL = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/{board}/securities/{ticker}.json"
MOEX_TICKER_BOARDS = ("TQBR", "TQTF")            # акции, затем фонды/ETF
MOEX_ISS_TIMEOUT_SEC = 10
MOEX_ISS_RETRIES = 2                             # число ПОВТОРНЫХ попыток
MOEX_ISS_RETRY_DELAY_SEC = 3

# Курсы ЦБ РФ (JSON-зеркало официального XML ЦБ, кодировка UTF-8)
CBR_DAILY_URL = "https://www.cbr-xml-daily.ru/daily_json.js"
# Ключевая ставка ЦБ РФ: XML-эндпоинт + HTML-страница-резерв
CBR_KEY_RATE_URL = "https://www.cbr.ru/scripts/XML_key_rate.asp"
CBR_KEY_RATE_HTML_URL = "https://www.cbr.ru/hd_base/KeyRate/"
CBR_KEY_RATE_CACHE_HOURS = 24                    # ставка меняется 8 раз в год — кэш на сутки

# ---------------------------------------------------------------------------
# Tinkoff Invest (только чтение, Часть 4)
# ---------------------------------------------------------------------------
# Токен read-only: не может выставлять или отменять ордера. Только через .env.
TINKOFF_INVEST_TOKEN: str | None = os.getenv("TINKOFF_INVEST_TOKEN")
TINKOFF_ACCOUNT_ID: str | None = os.getenv("TINKOFF_ACCOUNT_ID")   # необязательно: иначе первый брокерский
# Транспорт: rest — REST T-Invest API обычным requests (по умолчанию, без лишних
# зависимостей), sdk — gRPC-библиотека tinkoff-investments, если она установлена вручную.
# PyPI-пакет tinkoff-investments удалён, поэтому REST — основной путь, SDK — опция.
TINKOFF_TRANSPORT = (os.getenv("TINKOFF_TRANSPORT") or "rest").strip().lower()
# Хосты REST: основной (T-Bank) + резервный (Tinkoff). Перебираются при сетевом сбое.
TINKOFF_API_HOST = (os.getenv("TINKOFF_API_HOST") or "https://invest-public-api.tbank.ru").rstrip("/")
TINKOFF_API_BACKUP_HOSTS = [
    host.strip().rstrip("/")
    for host in (os.getenv("TINKOFF_API_BACKUP_HOSTS") or "https://invest-public-api.tinkoff.ru").split(",")
    if host.strip()
]
TINKOFF_API_BASE_URLS = [TINKOFF_API_HOST, *TINKOFF_API_BACKUP_HOSTS]
TINKOFF_POSITIONS_CACHE_TTL_SEC = 300             # 5 минут
TINKOFF_FIGI_CACHE_TTL_SEC = 604800               # FIGI→тикер практически не меняется (7 суток)
TINKOFF_RETRIES = 2                               # число ПОВТОРНЫХ попыток
TINKOFF_TIMEOUT_SEC = 15
TINKOFF_RETRY_DELAY_SEC = 3

# ---------------------------------------------------------------------------
# Прогнозы (Часть 3)
# ---------------------------------------------------------------------------
PREDICTION_CHECK_HOUR = 21                        # ежедневная проверка идей, МСК
PREDICTION_CHECK_MINUTE = 0
PREDICTION_DEFAULT_HORIZON_DAYS = 30              # если горизонт идеи не распознан
PREDICTION_FLAT_THRESHOLD_PCT = 1.0               # ±1% за период — это «боковик»
PREDICTION_ACCURACY_WINDOW_DAYS = 30              # окно для команды /accuracy
PREDICTION_TOP_TICKERS = 5                        # сколько тикеров показывать в /accuracy

# ---------------------------------------------------------------------------
# Fallback котировок (если API недоступен и в SQLite нет прошлых значений)
# ---------------------------------------------------------------------------
# fallback, если API недоступен
KEY_RATE = 16.0
MOEX_VALUE = 3200.0
MOEX_CHANGE = 0.0
USDRUB = 92.0
CNYRUB = 12.5
EURRUB = 93.0

# ---------------------------------------------------------------------------
# Прочее
# ---------------------------------------------------------------------------
DB_PATH = BASE_DIR / "news_bot.sqlite3"
LOG_PATH = BASE_DIR / "bot.log"
LOG_LEVEL = logging.INFO
JACCARD_THRESHOLD = 0.8                      # порог схожести заголовков для дедупликации
TELEGRAM_MAX_MESSAGE_LEN = 3900              # лимит Telegram — 4096, оставляем запас
HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 news-analyst-bot/1.0"
)

# Таймзона и хелперы времени (важно: сервер может быть в UTC)
MSK = ZoneInfo(TIMEZONE)
MSK_FALLBACK = timezone(timedelta(hours=3), name="MSK")


def now_msk() -> datetime:
    """Текущее время в МСК (aware datetime)."""
    try:
        return datetime.now(MSK)
    except Exception:  # pragma: no cover — на случай отсутствия tzdata в системе
        return datetime.now(MSK_FALLBACK)


def to_msk(value: datetime) -> datetime:
    """Приводит datetime к МСК.

    Naive-datetime считается UTC (именно так его отдают published_parsed из feedparser).
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    try:
        return value.astimezone(MSK)
    except Exception:  # pragma: no cover
        return value.astimezone(MSK_FALLBACK)
