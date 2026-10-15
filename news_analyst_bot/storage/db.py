"""Работа с SQLite: схема таблиц и запросы к ним.

Стандартная библиотека sqlite3, соединение открывается на каждую операцию
(это безопасно при работе из потоков планировщика и хендлеров aiogram).

Схема вынесена в storage/migrations.py: создание таблиц + добавление новых колонок
к существующей базе.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Iterable

import config
from storage import migrations

logger = logging.getLogger(__name__)

# Обратная совместимость: раньше DDL таблицы runs лежал прямо здесь.
SCHEMA = migrations.CREATE_RUNS


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Создаёт и дополняет схему. Вызывается на каждом старте, безопасно повторно."""
    with _connect() as conn:
        added = migrations.apply(conn)
    suffix = f" (миграции: {', '.join(added)})" if added else ""
    logger.info("SQLite готова: %s%s", config.DB_PATH, suffix)



def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def iso_seconds(value: datetime | None) -> str | None:
    """ISO-время без микросекунд — сравнение строк в SQLite становится однозначным."""
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    """Разбирает ISO-время из БД (None при мусоре)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


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
    tinkoff_status: str | None = None,
    market_snapshot: Any = None,
) -> int:
    """Сохраняет один прогон анализа и возвращает его id.

    tinkoff_status — строка статуса портфеля (Часть 4), market_snapshot — снимок
    котировок прогона (Часть 1). Оба поля необязательные.
    """
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO runs (
                started_at, finished_at, sources_status, deepseek_status,
                deepseek_tokens, deepseek_duration_ms, digest, raw_response,
                parsed_json, signal_present, tinkoff_status, market_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                tinkoff_status,
                _dumps(market_snapshot),
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


# ---------------------------------------------------------------------------
# Часть 1: снимки рынка (market_snapshots)
# ---------------------------------------------------------------------------
def save_market_snapshot(
    *,
    captured_at: datetime,
    usdrub: float | None,
    cnyrub: float | None,
    eurrub: float | None,
    moex_value: float | None,
    moex_change_pct: float | None,
    key_rate: float | None,
    source_status: Any,
) -> int:
    """Сохраняет снимок котировок и возвращает его id."""
    with _connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO market_snapshots (
                captured_at, usdrub, cnyrub, eurrub, moex_value,
                moex_change_pct, key_rate, source_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                iso_seconds(captured_at),
                usdrub,
                cnyrub,
                eurrub,
                moex_value,
                moex_change_pct,
                key_rate,
                _dumps(source_status),
            ),
        )
        snapshot_id = int(cursor.lastrowid or 0)
    logger.info(
        "Снимок рынка сохранён, id=%s: IMOEX=%s, USD/RUB=%s, ставка=%s%%",
        snapshot_id, moex_value, usdrub, key_rate,
    )
    return snapshot_id


def get_last_market_snapshot() -> dict[str, Any] | None:
    """Последний снимок рынка — источник fallback'ов, если API недоступно."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM market_snapshots ORDER BY id DESC LIMIT 1").fetchone()
    return _row_to_dict(row)


# ---------------------------------------------------------------------------
# Часть 4: универсальный кэш (FIGI→тикер, снимок портфеля Tinkoff)
# ---------------------------------------------------------------------------
def cache_get(key: str, ttl_sec: int | None = None) -> Any:
    """Значение из кэша (JSON) или None.

    Если задан ttl_sec и запись старше — возвращает None (запись остаётся в базе
    до следующего обновления, чтобы было видно историю последнего успешного ответа).
    """
    with _connect() as conn:
        row = conn.execute("SELECT value, updated_at FROM cache WHERE key = ?", (key,)).fetchone()
    if row is None:
        return None
    if ttl_sec is not None:
        updated_at = parse_iso(row["updated_at"])
        if updated_at is None or (config.now_msk() - updated_at).total_seconds() > ttl_sec:
            return None
    try:
        return json.loads(row["value"]) if row["value"] else None
    except (TypeError, ValueError):
        logger.warning("Кэш %s содержит не-JSON, игнорируем", key)
        return None


def cache_set(key: str, value: Any) -> None:
    """Кладёт значение в кэш (JSON)."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (key, _dumps(value), iso_seconds(config.now_msk())),
        )


def cache_delete(key: str) -> None:
    """Удаляет запись кэша (используется при принудительном обновлении портфеля)."""
    with _connect() as conn:
        conn.execute("DELETE FROM cache WHERE key = ?", (key,))


# ---------------------------------------------------------------------------
# Часть 3: предсказания и их проверка (predictions)
# ---------------------------------------------------------------------------
def save_predictions(run_id: int | None, created_at: datetime, items: list[dict[str, Any]]) -> int:
    """Сохраняет идеи прогона как предсказания.

    Каждый элемент items: ticker, direction, confidence, horizon, entry_price,
    check_at (datetime | None), instrument.
    """
    if not items:
        return 0

    rows = []
    for item in items:
        check_at = item.get("check_at")
        rows.append(
            (
                run_id,
                iso_seconds(created_at),
                str(item.get("ticker") or "").upper(),
                str(item.get("direction") or "").lower(),
                str(item.get("confidence") or "") or None,
                str(item.get("horizon") or "") or None,
                item.get("entry_price"),
                iso_seconds(check_at) if isinstance(check_at, datetime) else check_at,
                str(item.get("instrument") or "") or None,
            )
        )

    with _connect() as conn:
        conn.executemany(
            """
            INSERT INTO predictions (
                run_id, created_at, ticker, direction, confidence,
                horizon, entry_price, check_at, instrument
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    logger.info("Предсказания сохранены: %s записей (run_id=%s)", len(rows), run_id)
    return len(rows)


def get_predictions_due(now: datetime, limit: int = 100) -> list[dict[str, Any]]:
    """Идеи, у которых наступило время проверки.

    Условие: check_at <= now и фактический результат ещё не записан.
    Идеи «наблюдать» тоже проходят проверку (заполняют realized_direction), но
    остаются с hit = NULL и потому не считаются ни попаданием, ни промахом.
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM predictions
            WHERE check_at IS NOT NULL AND check_at <= ? AND realized_direction IS NULL
            ORDER BY check_at ASC
            LIMIT ?
            """,
            (iso_seconds(now), limit),
        ).fetchall()
    return [dict(row) for row in rows]


def update_prediction_result(
    prediction_id: int,
    *,
    price_at_check: float | None,
    realized_direction: str,
    hit: int | None,
) -> None:
    """Записывает результат проверки идеи."""
    with _connect() as conn:
        conn.execute(
            """
            UPDATE predictions
            SET price_at_check = ?, realized_direction = ?, hit = ?
            WHERE id = ?
            """,
            (price_at_check, realized_direction, hit, prediction_id),
        )
    logger.info(
        "Идея id=%s проверена: цена=%s, факт=%s, попадание=%s",
        prediction_id, price_at_check, realized_direction, hit,
    )


def get_predictions_since(since: datetime) -> list[dict[str, Any]]:
    """Предсказания, созданные не раньше указанного времени."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM predictions WHERE created_at >= ? ORDER BY id DESC",
            (iso_seconds(since),),
        ).fetchall()
    return [dict(row) for row in rows]


def count_pending_predictions() -> int:
    """Сколько идей ждут проверки (по всей базе, без привязки к окну)."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS total FROM predictions WHERE realized_direction IS NULL"
        ).fetchone()
    return int(row["total"]) if row else 0


def get_prediction_stats(days: int | None = None) -> dict[str, Any]:
    """Статистика отработки идей за последние N дней — для команды /accuracy.

    * total          — все идеи за период;
    * evaluated      — проверенные идеи с направлением (лонг/шорт): hit = 0 или 1;
    * hit            — из них удачных;
    * watchlisted    — идеи «наблюдать»: проверены, но в точность не входят;
    * pending        — ждут проверки (по всей базе);
    * no_entry_price — идеи без цены входа (проверить нельзя);
    * by_confidence  — разбивка по уверенности;
    * by_ticker      — разбивка по тикерам (сортировка по числу проверенных).
    """
    window_days = config.PREDICTION_ACCURACY_WINDOW_DAYS if days is None else days
    since = config.now_msk() - timedelta(days=window_days)
    rows = get_predictions_since(since)

    stats: dict[str, Any] = {
        "days": window_days,
        "since": since,
        "total": len(rows),
        "evaluated": 0,
        "hit": 0,
        "accuracy": None,
        "watchlisted": 0,
        "pending": count_pending_predictions(),
        "no_entry_price": 0,
        "by_confidence": {},
        "by_ticker": [],
    }

    confidence_buckets: dict[str, dict[str, int]] = {}
    ticker_buckets: dict[str, dict[str, int]] = {}

    for row in rows:
        confidence = str(row.get("confidence") or "").strip() or "не указана"
        ticker = str(row.get("ticker") or "—").strip().upper() or "—"
        confidence_buckets.setdefault(confidence, {"total": 0, "evaluated": 0, "hit": 0})["total"] += 1
        ticker_buckets.setdefault(ticker, {"total": 0, "evaluated": 0, "hit": 0})["total"] += 1

        if row.get("realized_direction") is None:
            if row.get("entry_price") is None:
                stats["no_entry_price"] += 1
            continue

        if row.get("hit") is None:      # «наблюдать» — отработано, но не hit/miss
            stats["watchlisted"] += 1
            continue

        stats["evaluated"] += 1
        confidence_buckets[confidence]["evaluated"] += 1
        ticker_buckets[ticker]["evaluated"] += 1
        if int(row.get("hit") or 0) == 1:
            stats["hit"] += 1
            confidence_buckets[confidence]["hit"] += 1
            ticker_buckets[ticker]["hit"] += 1

    if stats["evaluated"]:
        stats["accuracy"] = stats["hit"] / stats["evaluated"] * 100

    for buckets in (confidence_buckets, ticker_buckets):
        for bucket in buckets.values():
            bucket["accuracy"] = (
                bucket["hit"] / bucket["evaluated"] * 100 if bucket["evaluated"] else None
            )

    stats["by_confidence"] = confidence_buckets
    stats["by_ticker"] = sorted(
        ({"ticker": ticker, **bucket} for ticker, bucket in ticker_buckets.items() if bucket["evaluated"]),
        key=lambda item: (-item["evaluated"], item["ticker"]),
    )[: config.PREDICTION_TOP_TICKERS]

    return stats

