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
# Котировки
# ---------------------------------------------------------------------------
# TODO(котировки): ЭТО ЗАГЛУШКИ. Здесь должен быть реальный источник данных,
# например MOEX ISS (https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json)
# и курс USD/RUB с ЦБ РФ (https://www.cbr-xml-daily.ru/daily_json.js) или с MOEX.
# Заменить константы ниже на функцию get_market_snapshot() -> dict в scheduler/jobs.py
# (там же помечено отдельным TODO).
KEY_RATE = 16.0
MOEX_VALUE = 3200.0
MOEX_CHANGE = 0.0
USDRUB = 92.0

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
