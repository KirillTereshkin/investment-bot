"""Миграции схемы SQLite: создание таблиц и добавление новых колонок.

Модуль идемпотентный: вызывается при каждом старте (storage.db.init_db) и молча
пропускает то, что уже сделано. Так база, созданная прежними версиями бота,
дополняется новыми колонками без ручных действий и без потери данных.

Таблицы:
* runs               — прогоны анализа (была и раньше, добавлены колонки tinkoff_status / market_snapshot);
* market_snapshots    — котировки MOEX/ЦБ на момент прогона (Часть 1);
* predictions         — идеи и результат их проверки (Часть 3);
* cache               — универсальный кэш: FIGI→тикер и снимок портфеля Tinkoff (Часть 4).
"""

from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger(__name__)

CREATE_RUNS = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    sources_status TEXT,
    deepseek_status TEXT,
    deepseek_tokens INTEGER,
    deepseek_duration_ms INTEGER,
    digest TEXT,
    raw_response TEXT,
    parsed_json TEXT,
    signal_present INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
"""

CREATE_MARKET_SNAPSHOTS = """
CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    usdrub REAL,
    cnyrub REAL,
    eurrub REAL,
    moex_value REAL,
    moex_change_pct REAL,
    key_rate REAL,
    source_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_captured_at ON market_snapshots(captured_at);
"""

CREATE_PREDICTIONS = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    created_at TEXT NOT NULL,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence TEXT,
    horizon TEXT,
    entry_price REAL,
    check_at TEXT,
    price_at_check REAL,
    realized_direction TEXT,
    hit INTEGER,
    instrument TEXT
);
CREATE INDEX IF NOT EXISTS idx_predictions_check_at ON predictions(check_at);
CREATE INDEX IF NOT EXISTS idx_predictions_created_at ON predictions(created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_run_id ON predictions(run_id);
"""

CREATE_CACHE = """
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
);
"""

# Новые колонки существующих таблиц: имя → тип. Добавляются через ALTER TABLE,
# если колонки ещё нет (SQLite не поддерживает ADD COLUMN IF NOT EXISTS).
COLUMN_MIGRATIONS: dict[str, dict[str, str]] = {
    "runs": {
        "tinkoff_status": "TEXT",      # строка статуса портфеля Tinkoff для /last
        "market_snapshot": "TEXT",     # JSON снимка котировок (Часть 1)
    },
    "predictions": {
        "instrument": "TEXT",          # человекочитаемое имя инструмента из идеи
    },
}


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Колонки существующей таблицы (пустое множество, если таблицы нет)."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row[1]) for row in rows}


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> list[str]:
    """Добавляет отсутствующие колонки. Возвращает список добавленных."""
    existing = _table_columns(conn, table)
    if not existing:
        return []
    added: list[str] = []
    for name, column_type in columns.items():
        if name in existing:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {column_type}")
        added.append(name)
    return added


def apply(conn: sqlite3.Connection) -> list[str]:
    """Применяет все миграции. Возвращает список добавленных колонок (для лога)."""
    conn.executescript(CREATE_RUNS)
    conn.executescript(CREATE_MARKET_SNAPSHOTS)
    conn.executescript(CREATE_PREDICTIONS)
    conn.executescript(CREATE_CACHE)

    added: list[str] = []
    for table, columns in COLUMN_MIGRATIONS.items():
        for name in _ensure_columns(conn, table, columns):
            added.append(f"{table}.{name}")
            logger.info("Миграция SQLite: добавлена колонка %s.%s", table, name)
    return added
