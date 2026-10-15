"""Горизонт идеи → дата проверки, а также оценка фактического результата (Часть 3).

Модуль намеренно без зависимостей от сети и БД: только чистая логика, которую
проверяет смоук-тест.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

import config

logger = logging.getLogger(__name__)

# «2-8 недель» → берём нижнюю границу диапазона (2 недели), как требует ТЗ
_RANGE_RE = re.compile(r"(\d+)\s*[-–—]\s*(\d+)\s*([а-я]+)", re.IGNORECASE)
_SINGLE_RE = re.compile(r"(\d+)\s*([а-я]+)", re.IGNORECASE)

# Первые буквы единицы измерения → сколько это дней
DAYS_PER_UNIT = {
    "дн": 1,
    "день": 1,
    "сут": 1,
    "нед": 7,
    "мес": 30,
    "год": 365,
    "лет": 365,
}

DIRECTION_LONG = "лонг"
DIRECTION_SHORT = "шорт"
DIRECTION_WATCH = "наблюдать"

RISE = "рост"
FALL = "падение"
FLAT = "боковик"


def _normalize(text: str | None) -> str:
    """lowercase, «ё» → «е», неразрывные пробелы — обычными."""
    if not text:
        return ""
    return str(text).lower().replace("ё", "е").replace("\u00a0", " ").strip()


def _unit_days(unit: str) -> int | None:
    """Дней в единице измерения по её началу («недель», «месяцев» → «нед»/«мес»)."""
    unit = unit.strip()
    for prefix, days in DAYS_PER_UNIT.items():
        if unit.startswith(prefix):
            return days
    return None


def parse_horizon_days(horizon: str | None, default: int | None = None) -> int:
    """Сколько дней ждать проверки идеи.

    «2-8 недель» → 14 (нижняя граница диапазона), «4 недели» → 28, «1 месяц» → 30,
    «3 месяца» → 90. Если горизонт не распознан — config.PREDICTION_DEFAULT_HORIZON_DAYS.
    """
    fallback = config.PREDICTION_DEFAULT_HORIZON_DAYS if default is None else default
    text = _normalize(horizon)
    if not text:
        return fallback

    match = _RANGE_RE.search(text)
    if match:
        days = _unit_days(match.group(3))
        if days:
            return max(1, min(int(match.group(1)), int(match.group(2))) * days)

    match = _SINGLE_RE.search(text)
    if match:
        days = _unit_days(match.group(2))
        if days:
            return max(1, int(match.group(1)) * days)

    logger.warning("Горизонт %r не распознан — используем %s дней", horizon, fallback)
    return fallback


def compute_check_at(
    created_at: datetime,
    horizon: str | None,
    default_days: int | None = None,
) -> datetime:
    """Дата проверки идеи: created_at + горизонт (нижняя граница)."""
    return created_at + timedelta(days=parse_horizon_days(horizon, default_days))


def classify_move(
    entry_price: float | None,
    price_at_check: float | None,
    threshold_pct: float | None = None,
) -> str | None:
    """Фактическое движение цены за период: «рост» / «падение» / «боковик».

    Порог «боковика» — config.PREDICTION_FLAT_THRESHOLD_PCT (±1% по умолчанию).
    None означает «сравнить не с чем» (нет цены входа или текущей цены).
    """
    if entry_price is None or price_at_check is None or entry_price <= 0:
        return None
    threshold = config.PREDICTION_FLAT_THRESHOLD_PCT if threshold_pct is None else threshold_pct
    change_pct = (price_at_check - entry_price) / entry_price * 100
    if change_pct > threshold:
        return RISE
    if change_pct < -threshold:
        return FALL
    return FLAT


def normalize_direction(direction: str | None) -> str:
    """Направление идеи в каноничном виде: «лонг»/«шорт»/«наблюдать».

    Всё непонятное (пустое значение, «hold», «смотреть») считается «наблюдать»:
    такие идеи проверяются, но не идут в точность.
    """
    text = _normalize(direction)
    if text in (DIRECTION_LONG, DIRECTION_SHORT):
        return text
    return DIRECTION_WATCH


def is_hit(direction: str | None, realized_direction: str | None) -> int | None:
    """Сбылась ли идея: 1 — да, 0 — нет, None — не считается («наблюдать»/нет данных)."""
    normalized = _normalize(direction)
    if normalized not in (DIRECTION_LONG, DIRECTION_SHORT) or not realized_direction:
        return None
    if normalized == DIRECTION_LONG:
        return 1 if realized_direction == RISE else 0
    return 1 if realized_direction == FALL else 0


def move_pct(entry_price: float | None, price_at_check: float | None) -> float | None:
    """Изменение цены в процентах (для отчётов: +2.4 / -3.9)."""
    if entry_price is None or price_at_check is None or entry_price <= 0:
        return None
    return (price_at_check - entry_price) / entry_price * 100
