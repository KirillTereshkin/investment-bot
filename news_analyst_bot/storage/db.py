"""Работа с SQLite: схема таблицы runs и запросы к ней.

Стандартная библиотека sqlite3, соединение открывается на каждую операцию
(это безопасно при работе из потоков планировщика и хендлеров aiogram).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Iterable

import config

logger = logging.getLogger(__name__)

SCHEMA = """
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


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Создаёт таблицу и индекс, если их ещё нет."""
    with _connect() as conn:
        conn.executescript(SCHEMA)
    logger.info("SQLite готова: %s", config.DB_PATH)


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def save_run(
    *,
    started_at: datetime,
    finished_at: datetime | None,
    sources_status: Any,
    deepseek_status: str,
    deepseek_tokens: int | None,
    deepseek_duration_ms: int | None,
    digest: str,
    raw_response: str | None,
    parsed_json: Any,
    signal_present: bool,
) -> int:
    """Сохраняет один прогон анализа и возвращает его id."""
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO runs (
                started_at, finished_at, sources_status, deepseek_status,
                deepseek_tokens, deepseek_duration_ms, digest, raw_response,
                parsed_json, signal_present
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                started_at.isoformat(),
                finished_at.isoformat() if finished_at else None,
                _dumps(sources_status),
                deepseek_status,
                deepseek_tokens,
                deepseek_duration_ms,
                digest,
                raw_response,
                _dumps(parsed_json),
                1 if signal_present else 0,
            ),
        )
        run_id = int(cursor.lastrowid or 0)
    logger.info("Прогон сохранён в SQLite, id=%s, deepseek_status=%s", run_id, deepseek_status)
    return run_id


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def get_last_run() -> dict[str, Any] | None:
    """Последний прогон (или None, если база пуста)."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    return _row_to_dict(row)


def get_runs_since(since: datetime) -> list[dict[str, Any]]:
    """Прогоны, начатые не раньше указанного времени."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM runs WHERE started_at >= ? ORDER BY id DESC", (since.isoformat(),)
        ).fetchall()
    return [dict(row) for row in rows]


def _parse_sources_status(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def get_stats(days: int = 7) -> dict[str, Any]:
    """Сводка за последние N дней.

    Возвращает: всего прогнозов, «сигналов нет», ошибок DeepSeek, пропусков
    (пустой дайджест), падений источников и разбивку падений по источникам.
    """
    since = config.now_msk() - timedelta(days=days)
    rows = get_runs_since(since)

    stats: dict[str, Any] = {
        "days": days,
        "since": since,
        "total_runs": len(rows),
        "no_signal": 0,
        "with_ideas": 0,
        "deepseek_errors": 0,
        "deepseek_skipped": 0,
        "source_failures": 0,
        "failed_sources": {},
        "degraded_runs": 0,   # прогоны, где упало больше половины источников
    }

    for row in rows:
        deepseek_status = (row.get("deepseek_status") or "").strip()
        if deepseek_status == "ok":
            if row.get("signal_present"):
                stats["with_ideas"] += 1
            else:
                stats["no_signal"] += 1
        elif deepseek_status == "skipped":
            stats["deepseek_skipped"] += 1
        else:
            stats["deepseek_errors"] += 1

        sources: Iterable[dict[str, Any]] = _parse_sources_status(row.get("sources_status"))
        failed: list[str] = []
        total_sources = 0
        for source in sources:
            total_sources += 1
            if source.get("status") == "error":
                failed.append(str(source.get("source", "unknown")))
        stats["source_failures"] += len(failed)
        for name in failed:
            stats["failed_sources"][name] = stats["failed_sources"].get(name, 0) + 1
        if total_sources and len(failed) > total_sources / 2:
            stats["degraded_runs"] += 1

    return stats
