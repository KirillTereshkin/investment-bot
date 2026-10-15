/**
 * Миграции схемы SQLite: создание таблиц и добавление новых колонок.
 *
 * Модуль идемпотентный: вызывается при каждом старте (storage.db.initDb) и молча
 * пропускает то, что уже сделано. Так база, созданная прежними версиями бота
 * (в том числе Python-версией), дополняется новыми колонками без потери данных.
 *
 * Таблицы:
 * * runs            — прогоны анализа (плюс колонки tinkoff_status / market_snapshot);
 * * market_snapshots — котировки MOEX/ЦБ на момент прогона (Часть 1);
 * * predictions     — идеи и результат их проверки (Часть 3);
 * * cache           — универсальный кэш: FIGI→тикер и снимок портфеля Tinkoff (Часть 4).
 */

import { getLogger } from '../logger.js';

const logger = getLogger('storage.migrations');

export const CREATE_RUNS = `
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
`;

export const CREATE_MARKET_SNAPSHOTS = `
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
`;

export const CREATE_PREDICTIONS = `
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
`;

export const CREATE_CACHE = `
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
);
`;

// Новые колонки существующих таблиц: имя → тип. Добавляются через ALTER TABLE,
// если колонки ещё нет (SQLite не поддерживает ADD COLUMN IF NOT EXISTS).
export const COLUMN_MIGRATIONS = {
  runs: {
    tinkoff_status: 'TEXT', // строка статуса портфеля Tinkoff для /last
    market_snapshot: 'TEXT', // JSON снимка котировок (Часть 1)
  },
  predictions: {
    instrument: 'TEXT', // человекочитаемое имя инструмента из идеи
  },
};

/** Колонки существующей таблицы (пустое множество, если таблицы нет). */
function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

/** Добавляет отсутствующие колонки. Возвращает список добавленных. */
function ensureColumns(db, table, columns) {
  const existing = tableColumns(db, table);
  if (existing.size === 0) return [];
  const added = [];
  for (const [name, columnType] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${columnType}`);
    added.push(name);
  }
  return added;
}

/** Применяет все миграции. Возвращает список добавленных колонок (для лога). */
export function apply(db) {
  db.exec(CREATE_RUNS);
  db.exec(CREATE_MARKET_SNAPSHOTS);
  db.exec(CREATE_PREDICTIONS);
  db.exec(CREATE_CACHE);

  const added = [];
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    for (const name of ensureColumns(db, table, columns)) {
      added.push(`${table}.${name}`);
      logger.info('Миграция SQLite: добавлена колонка %s.%s', table, name);
    }
  }
  return added;
}
