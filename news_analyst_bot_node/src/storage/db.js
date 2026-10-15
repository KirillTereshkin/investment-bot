/**
 * Работа с SQLite: схема таблиц и запросы к ним.
 *
 * В Python-версии использовался stdlib sqlite3 с соединением на каждую операцию.
 * Здесь — встроенный модуль node:sqlite (DatabaseSync, синхронный API) и одно
 * соединение на процесс: Node однопоточный, поэтому «на каждую операцию» не нужно.
 * Схема БД, имена таблиц/колонок и формат времени (МСК-ISO с секундной точностью)
 * полностью совместимы с базой Python-версии.
 *
 * Требуется флаг запуска --experimental-sqlite (см. npm start).
 */

import { createRequire } from 'node:module';

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import * as migrations from './migrations.js';

const logger = getLogger('storage.db');
const require = createRequire(import.meta.url);

// Обратная совместимость: раньше DDL таблицы runs лежал прямо здесь.
export const SCHEMA = migrations.CREATE_RUNS;

let connection = null;

function openConnection() {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (exc) {
    throw new Error(
      'Модуль node:sqlite недоступен. Запускайте бота командой `npm start` ' +
        '(или `node --experimental-sqlite main.js`) — нужен Node.js 22.5+. ' +
        `Причина: ${exc.message}`,
    );
  }
  const { DatabaseSync } = sqlite;
  try {
    return new DatabaseSync(config.DB_PATH, { timeout: 30000 });
  } catch {
    return new DatabaseSync(config.DB_PATH);
  }
}

/** Соединение с базой (открывается лениво, одно на процесс). */
export function getDb() {
  if (connection === null) connection = openConnection();
  return connection;
}

export function closeDb() {
  if (connection !== null) {
    try {
      connection.close();
    } catch {
      /* уже закрыто */
    }
    connection = null;
  }
}

export function initDb() {
  const added = migrations.apply(getDb());
  const suffix = added.length ? ` (миграции: ${added.join(', ')})` : '';
  logger.info('SQLite готова: %s%s', config.DB_PATH, suffix);
}

function dumps(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function bool01(value) {
  return value ? 1 : 0;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** ISO-время без миллисекунд — сравнение строк в SQLite становится однозначным. */
export function isoSeconds(value) {
  if (value === null || value === undefined) return null;
  return config.mskIso(value);
}

export function parseIso(value) {
  return config.parseIso(value);
}

function rowToDict(row) {
  if (row === null || row === undefined) return null;
  return { ...row };
}

function rowsToDicts(rows) {
  return rows.map((row) => ({ ...row }));
}

export function saveRun({
  startedAt,
  finishedAt = null,
  sourcesStatus = null,
  deepseekStatus,
  deepseekTokens = null,
  deepseekDurationMs = null,
  digest = '',
  rawResponse = null,
  parsedJson = null,
  signalPresent = false,
  tinkoffStatus = null,
  marketSnapshot = null,
} = {}) {
  const info = getDb()
    .prepare(
      `INSERT INTO runs (
                started_at, finished_at, sources_status, deepseek_status,
                deepseek_tokens, deepseek_duration_ms, digest, raw_response,
                parsed_json, signal_present, tinkoff_status, market_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      isoSeconds(startedAt),
      isoSeconds(finishedAt),
      dumps(sourcesStatus),
      deepseekStatus,
      asNumber(deepseekTokens),
      asNumber(deepseekDurationMs),
      digest,
      rawResponse,
      dumps(parsedJson),
      bool01(signalPresent),
      tinkoffStatus,
      dumps(marketSnapshot),
    );
  const runId = Number(info.lastInsertRowid || 0);
  logger.info('Прогон сохранён в SQLite, id=%s, deepseek_status=%s', runId, deepseekStatus);
  return runId;
}

export function getLastRun() {
  const row = getDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  return rowToDict(row);
}

export function getRunsSince(since) {
  const rows = getDb()
    .prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY id DESC')
    .all(isoSeconds(since));
  return rowsToDicts(rows);
}

export function parseSourcesStatus(raw) {
  if (!raw) return [];
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function getStats(days = 7) {
  const since = new Date(config.nowMsk().getTime() - days * 86400000);
  const rows = getRunsSince(since);

  const stats = {
    days,
    since,
    total_runs: rows.length,
    no_signal: 0,
    with_ideas: 0,
    deepseek_errors: 0,
    deepseek_skipped: 0,
    source_failures: 0,
    failed_sources: {},
    degraded_runs: 0, // прогоны, где упало больше половины источников
  };

  for (const row of rows) {
    const deepseekStatus = String(row.deepseek_status || '').trim();
    if (deepseekStatus === 'ok') {
      if (row.signal_present) stats.with_ideas += 1;
      else stats.no_signal += 1;
    } else if (deepseekStatus === 'skipped') {
      stats.deepseek_skipped += 1;
    } else {
      stats.deepseek_errors += 1;
    }

    const sources = parseSourcesStatus(row.sources_status);
    const failed = [];
    let totalSources = 0;
    for (const source of sources) {
      totalSources += 1;
      if (source && source.status === 'error') failed.push(String(source.source || 'unknown'));
    }
    stats.source_failures += failed.length;
    for (const name of failed) {
      stats.failed_sources[name] = (stats.failed_sources[name] || 0) + 1;
    }
    if (totalSources && failed.length > totalSources / 2) stats.degraded_runs += 1;
  }
  return stats;
}



// ---------------------------------------------------------------------------
// Часть 1: снимки рынка (market_snapshots)
// ---------------------------------------------------------------------------
export function saveMarketSnapshot({
  capturedAt,
  usdrub = null,
  cnyrub = null,
  eurrub = null,
  moexValue = null,
  moexChangePct = null,
  keyRate = null,
  sourceStatus = null,
} = {}) {
  const info = getDb()
    .prepare(
      `INSERT INTO market_snapshots (
                captured_at, usdrub, cnyrub, eurrub, moex_value,
                moex_change_pct, key_rate, source_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      isoSeconds(capturedAt),
      usdrub,
      cnyrub,
      eurrub,
      moexValue,
      moexChangePct,
      keyRate,
      dumps(sourceStatus),
    );
  const snapshotId = Number(info.lastInsertRowid || 0);
  logger.info(
    'Снимок рынка сохранён, id=%s: IMOEX=%s, USD/RUB=%s, ставка=%s%%',
    snapshotId,
    moexValue,
    usdrub,
    keyRate,
  );
  return snapshotId;
}

/** Последний снимок рынка — источник fallback'ов, если API недоступно. */
export function getLastMarketSnapshot() {
  const row = getDb().prepare('SELECT * FROM market_snapshots ORDER BY id DESC LIMIT 1').get();
  return rowToDict(row);
}

// ---------------------------------------------------------------------------
// Часть 4: универсальный кэш (FIGI→тикер, снимок портфеля Tinkoff)
// ---------------------------------------------------------------------------
/**
 * Значение из кэша (JSON) или null.
 *
 * Если задан ttlSec и запись старше — возвращает null (запись остаётся в базе
 * до следующего обновления, чтобы было видно историю последнего успешного ответа).
 */
export function cacheGet(key, ttlSec = null) {
  const row = getDb().prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key);
  if (row === null || row === undefined) return null;
  if (ttlSec !== null && ttlSec !== undefined) {
    const updatedAt = parseIso(row.updated_at);
    if (updatedAt === null || (config.nowMsk().getTime() - updatedAt.getTime()) / 1000 > ttlSec) {
      return null;
    }
  }
  if (!row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    logger.warning('Кэш %s содержит не-JSON, игнорируем', key);
    return null;
  }
}

/** Кладёт значение в кэш (JSON). */
export function cacheSet(key, value) {
  getDb()
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, dumps(value), isoSeconds(config.nowMsk()));
}

/** Удаляет запись кэша (используется при принудительном обновлении портфеля). */
export function cacheDelete(key) {
  getDb().prepare('DELETE FROM cache WHERE key = ?').run(key);
}

// ---------------------------------------------------------------------------
// Часть 3: предсказания и их проверка (predictions)
// ---------------------------------------------------------------------------
/**
 * Сохраняет идеи прогона как предсказания.
 *
 * Каждый элемент items: ticker, direction, confidence, horizon, entryPrice,
 * checkAt (Date | null), instrument.
 */
export function savePredictions(runId, createdAt, items) {
  if (!items || items.length === 0) return 0;

  const rows = items.map((item) => {
    const checkAt = item.checkAt ?? item.check_at ?? null;
    return [
      runId,
      isoSeconds(createdAt),
      String(item.ticker || '').toUpperCase(),
      String(item.direction || '').toLowerCase(),
      String(item.confidence || '') || null,
      String(item.horizon || '') || null,
      item.entryPrice ?? item.entry_price ?? null,
      checkAt instanceof Date ? isoSeconds(checkAt) : (checkAt ?? null),
      String(item.instrument || '') || null,
    ];
  });

  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO predictions (
                run_id, created_at, ticker, direction, confidence,
                horizon, entry_price, check_at, instrument
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const row of rows) statement.run(...row);
    db.exec('COMMIT');
  } catch (exc) {
    db.exec('ROLLBACK');
    throw exc;
  }
  logger.info('Предсказания сохранены: %s записей (run_id=%s)', rows.length, runId);
  return rows.length;
}

/**
 * Идеи, у которых наступило время проверки.
 *
 * Условие: check_at <= now и фактический результат ещё не записан.
 * Идеи «наблюдать» тоже проходят проверку (заполняют realized_direction), но
 * остаются с hit = NULL и потому не считаются ни попаданием, ни промахом.
 */
export function getPredictionsDue(now, limit = 100) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM predictions
            WHERE check_at IS NOT NULL AND check_at <= ? AND realized_direction IS NULL
            ORDER BY check_at ASC
            LIMIT ?`,
    )
    .all(isoSeconds(now), limit);
  return rowsToDicts(rows);
}

/** Записывает результат проверки идеи. */
export function updatePredictionResult(predictionId, { priceAtCheck = null, realizedDirection, hit = null } = {}) {
  getDb()
    .prepare(
      `UPDATE predictions
            SET price_at_check = ?, realized_direction = ?, hit = ?
            WHERE id = ?`,
    )
    .run(priceAtCheck, realizedDirection, hit, predictionId);
  logger.info(
    'Идея id=%s проверена: цена=%s, факт=%s, попадание=%s',
    predictionId,
    priceAtCheck,
    realizedDirection,
    hit,
  );
}

/** Предсказания, созданные не раньше указанного времени. */
export function getPredictionsSince(since) {
  const rows = getDb()
    .prepare('SELECT * FROM predictions WHERE created_at >= ? ORDER BY id DESC')
    .all(isoSeconds(since));
  return rowsToDicts(rows);
}

/** Сколько идей ждут проверки (по всей базе, без привязки к окну). */
export function countPendingPredictions() {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total FROM predictions WHERE realized_direction IS NULL')
    .get();
  return row ? Number(row.total) : 0;
}

/**
 * Статистика отработки идей за последние N дней — для команды /accuracy.
 *
 * * total          — все идеи за период;
 * * evaluated      — проверенные идеи с направлением (лонг/шорт): hit = 0 или 1;
 * * hit            — из них удачных;
 * * watchlisted    — идеи «наблюдать»: проверены, но в точность не входят;
 * * pending        — ждут проверки (по всей базе);
 * * no_entry_price — идеи без цены входа (проверить нельзя);
 * * by_confidence  — разбивка по уверенности;
 * * by_ticker      — разбивка по тикерам (сортировка по числу проверенных).
 */
export function getPredictionStats(days = null) {
  const windowDays = days === null || days === undefined ? config.PREDICTION_ACCURACY_WINDOW_DAYS : days;
  const since = new Date(config.nowMsk().getTime() - windowDays * 86400000);
  const rows = getPredictionsSince(since);

  const stats = {
    days: windowDays,
    since,
    total: rows.length,
    evaluated: 0,
    hit: 0,
    accuracy: null,
    watchlisted: 0,
    pending: countPendingPredictions(),
    no_entry_price: 0,
    by_confidence: {},
    by_ticker: [],
  };

  const confidenceBuckets = {};
  const tickerBuckets = {};

  for (const row of rows) {
    const confidence = String(row.confidence || '').trim() || 'не указана';
    const ticker = String(row.ticker || '—').trim().toUpperCase() || '—';
    confidenceBuckets[confidence] = confidenceBuckets[confidence] || { total: 0, evaluated: 0, hit: 0 };
    tickerBuckets[ticker] = tickerBuckets[ticker] || { total: 0, evaluated: 0, hit: 0 };
    confidenceBuckets[confidence].total += 1;
    tickerBuckets[ticker].total += 1;

    if (row.realized_direction === null || row.realized_direction === undefined) {
      if (row.entry_price === null || row.entry_price === undefined) stats.no_entry_price += 1;
      continue;
    }

    if (row.hit === null || row.hit === undefined) {
      // «наблюдать» — отработано, но не hit/miss
      stats.watchlisted += 1;
      continue;
    }

    stats.evaluated += 1;
    confidenceBuckets[confidence].evaluated += 1;
    tickerBuckets[ticker].evaluated += 1;
    if (Number(row.hit || 0) === 1) {
      stats.hit += 1;
      confidenceBuckets[confidence].hit += 1;
      tickerBuckets[ticker].hit += 1;
    }
  }

  if (stats.evaluated) stats.accuracy = (stats.hit / stats.evaluated) * 100;

  for (const buckets of [confidenceBuckets, tickerBuckets]) {
    for (const bucket of Object.values(buckets)) {
      bucket.accuracy = bucket.evaluated ? (bucket.hit / bucket.evaluated) * 100 : null;
    }
  }

  stats.by_confidence = confidenceBuckets;
  stats.by_ticker = Object.entries(tickerBuckets)
    .filter(([, bucket]) => bucket.evaluated)
    .map(([ticker, bucket]) => ({ ticker, ...bucket }))
    .sort((a, b) => (b.evaluated - a.evaluated) || a.ticker.localeCompare(b.ticker))
    .slice(0, config.PREDICTION_TOP_TICKERS);

  return stats;
}

