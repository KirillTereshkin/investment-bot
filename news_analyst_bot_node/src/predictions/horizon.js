/**
 * Горизонт идеи → дата проверки, а также оценка фактического результата (Часть 3).
 *
 * Модуль намеренно без зависимостей от сети и БД: только чистая логика, которую
 * проверяет смоук-тест.
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';

const logger = getLogger('predictions.horizon');

// «2-8 недель» → берём нижнюю границу диапазона (2 недели), как требует ТЗ
const RANGE_RE = /(\d+)\s*[-–—]\s*(\d+)\s*([а-я]+)/i;
const SINGLE_RE = /(\d+)\s*([а-я]+)/i;

// Первые буквы единицы измерения → сколько это дней
export const DAYS_PER_UNIT = {
  дн: 1,
  день: 1,
  сут: 1,
  нед: 7,
  мес: 30,
  год: 365,
  лет: 365,
};

export const DIRECTION_LONG = 'лонг';
export const DIRECTION_SHORT = 'шорт';
export const DIRECTION_WATCH = 'наблюдать';

export const RISE = 'рост';
export const FALL = 'падение';
export const FLAT = 'боковик';

/** lowercase, «ё» → «е», неразрывные пробелы — обычными. */
function normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/ё/g, 'е').replace(/\u00a0/g, ' ').trim();
}

/** Дней в единице измерения по её началу («недель», «месяцев» → «нед»/«мес»). */
function unitDays(unit) {
  const text = String(unit).trim();
  for (const [prefix, days] of Object.entries(DAYS_PER_UNIT)) {
    if (text.startsWith(prefix)) return days;
  }
  return null;
}

/**
 * Сколько дней ждать проверки идеи.
 *
 * «2-8 недель» → 14 (нижняя граница диапазона), «4 недели» → 28, «1 месяц» → 30,
 * «3 месяца» → 90. Если горизонт не распознан — config.PREDICTION_DEFAULT_HORIZON_DAYS.
 */
export function parseHorizonDays(horizon, fallback = null) {
  const defaultDays = fallback === null || fallback === undefined
    ? config.PREDICTION_DEFAULT_HORIZON_DAYS
    : fallback;
  const text = normalize(horizon);
  if (!text) return defaultDays;

  const range = RANGE_RE.exec(text);
  if (range) {
    const days = unitDays(range[3]);
    if (days) {
      const low = Math.min(Number.parseInt(range[1], 10), Number.parseInt(range[2], 10));
      return Math.max(1, low * days);
    }
  }

  const single = SINGLE_RE.exec(text);
  if (single) {
    const days = unitDays(single[2]);
    if (days) return Math.max(1, Number.parseInt(single[1], 10) * days);
  }

  logger.warning('Горизонт %r не распознан — используем %s дней', horizon, defaultDays);
  return defaultDays;
}

/** Дата проверки идеи: created_at + горизонт (нижняя граница). */
export function computeCheckAt(createdAt, horizon, defaultDays = null) {
  const days = parseHorizonDays(horizon, defaultDays);
  return new Date(createdAt.getTime() + days * 86400000);
}

/**
 * Фактическое движение цены за период: «рост» / «падение» / «боковик».
 *
 * Порог «боковика» — config.PREDICTION_FLAT_THRESHOLD_PCT (±1% по умолчанию).
 * null означает «сравнить не с чем» (нет цены входа или текущей цены).
 */
export function classifyMove(entryPrice, priceAtCheck, thresholdPct = null) {
  if (entryPrice === null || entryPrice === undefined) return null;
  if (priceAtCheck === null || priceAtCheck === undefined) return null;
  if (!(entryPrice > 0)) return null;
  const threshold = thresholdPct === null || thresholdPct === undefined
    ? config.PREDICTION_FLAT_THRESHOLD_PCT
    : thresholdPct;
  const changePct = ((priceAtCheck - entryPrice) / entryPrice) * 100;
  if (changePct > threshold) return RISE;
  if (changePct < -threshold) return FALL;
  return FLAT;
}

/**
 * Направление идеи в каноничном виде: «лонг»/«шорт»/«наблюдать».
 *
 * Всё непонятное (пустое значение, «hold», «смотреть») считается «наблюдать»:
 * такие идеи проверяются, но не идут в точность.
 */
export function normalizeDirection(direction) {
  const text = normalize(direction);
  if (text === DIRECTION_LONG || text === DIRECTION_SHORT) return text;
  return DIRECTION_WATCH;
}

/** Сбылась ли идея: 1 — да, 0 — нет, null — не считается («наблюдать»/нет данных). */
export function isHit(direction, realizedDirection) {
  const normalized = normalize(direction);
  if (normalized !== DIRECTION_LONG && normalized !== DIRECTION_SHORT) return null;
  if (!realizedDirection) return null;
  if (normalized === DIRECTION_LONG) return realizedDirection === RISE ? 1 : 0;
  return realizedDirection === FALL ? 1 : 0;
}

/** Изменение цены в процентах (для отчётов: +2.4 / -3.9). */
export function movePct(entryPrice, priceAtCheck) {
  if (entryPrice === null || entryPrice === undefined) return null;
  if (priceAtCheck === null || priceAtCheck === undefined) return null;
  if (!(entryPrice > 0)) return null;
  return ((priceAtCheck - entryPrice) / entryPrice) * 100;
}
