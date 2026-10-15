/**
 * Конфигурация проекта (порт config.py).
 *
 * Все секреты читаются только из .env (образец — .env.example).
 * Модуль не содержит тяжёлых зависимостей: его импортируют все остальные модули.
 */

import path from 'node:path';
import dotenv from 'dotenv';

import { getLogger } from './logger.js';

const logger = getLogger('config');

/** Корень проекта (папка, в которой лежат main.js, .env и база). */
export const BASE_DIR = path.resolve(import.meta.dirname, '..');

// Читаем .env рядом с package.json
dotenv.config({ path: path.join(BASE_DIR, '.env'), quiet: true });

function envStr(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

function envInt(name) {
  const raw = envStr(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    logger.error('Переменная %s должна быть целым числом, получено: %r', name, raw);
    return null;
  }
  return value;
}

function envFloat(name) {
  const raw = envStr(name);
  if (raw === null) return null;
  const value = Number.parseFloat(raw.replace(',', '.'));
  if (Number.isNaN(value)) {
    logger.error('Переменная %s должна быть числом, получено: %r', name, raw);
    return null;
  }
  return value;
}

function envHours(name, fallback) {
  const raw = envStr(name);
  if (raw === null) return fallback;
  const hours = raw
    .split(',')
    .map((chunk) => Number.parseInt(chunk.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);
  return hours.length ? Array.from(new Set(hours)).sort((a, b) => a - b) : fallback;
}

function intOr(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

function floatOr(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
export const TELEGRAM_BOT_TOKEN = envStr('TELEGRAM_BOT_TOKEN');
export const TELEGRAM_CHAT_ID = envInt('TELEGRAM_CHAT_ID');

// ---------------------------------------------------------------------------
// DeepSeek (OpenAI-совместимый API)
// ---------------------------------------------------------------------------
export const DEEPSEEK_API_KEY = envStr('DEEPSEEK_API_KEY');
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-chat';
export const DEEPSEEK_TEMPERATURE = 0.3;
export const DEEPSEEK_MAX_TOKENS = 1000;
export const DEEPSEEK_TIMEOUT_SEC = 60;
export const DEEPSEEK_RETRIES = 2; // число ПОВТОРНЫХ попыток (итого попыток = 3)
export const DEEPSEEK_RETRY_DELAY_SEC = 5;

// ---------------------------------------------------------------------------
// Расписание
// ---------------------------------------------------------------------------
export const ANALYSIS_HOURS = envHours('ANALYSIS_HOURS', [10, 12, 14, 16, 18, 20]); // МСК
export const TIMEZONE = envStr('TIMEZONE') || 'Europe/Moscow';
export const NEWS_WINDOW_MINUTES = intOr(envInt('NEWS_WINDOW_MINUTES'), 120); // окно = интервал расписания
export const MAX_DIGEST_LINES = intOr(envInt('MAX_DIGEST_LINES'), 25);
export const SOURCE_TIMEOUT_SEC = intOr(envInt('SOURCE_TIMEOUT_SEC'), 10);
export const SOURCE_RETRIES = intOr(envInt('SOURCE_RETRIES'), 2); // число ПОВТОРНЫХ попыток
export const SOURCE_RETRY_DELAY_SEC = intOr(envInt('SOURCE_RETRY_DELAY_SEC'), 3);

// ---------------------------------------------------------------------------
// Котировки (market/quotes.js)
// ---------------------------------------------------------------------------
// Индекс MOEX (IMOEX) и цены тикеров берутся с MOEX ISS (без ключа, задержка ~15 мин).
export const MOEX_ISS_BASE_URL = 'https://iss.moex.com/iss';
export const MOEX_ISS_INDEX_URL =
  'https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX.json';
export const MOEX_ISS_SHARES_URL =
  'https://iss.moex.com/iss/engines/stock/markets/shares/boards/{board}/securities/{ticker}.json';
export const MOEX_TICKER_BOARDS = ['TQBR', 'TQTF']; // акции, затем фонды/ETF
export const MOEX_ISS_TIMEOUT_SEC = intOr(envInt('MOEX_ISS_TIMEOUT_SEC'), 10);
export const MOEX_ISS_RETRIES = intOr(envInt('MOEX_ISS_RETRIES'), 2); // число ПОВТОРНЫХ попыток
export const MOEX_ISS_RETRY_DELAY_SEC = intOr(envInt('MOEX_ISS_RETRY_DELAY_SEC'), 3);

// Курсы ЦБ РФ (JSON-зеркало официального XML ЦБ, кодировка UTF-8)
export const CBR_DAILY_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
// Ключевая ставка ЦБ РФ: XML-эндпоинт + HTML-страница-резерв
export const CBR_KEY_RATE_URL = 'https://www.cbr.ru/scripts/XML_key_rate.asp';
export const CBR_KEY_RATE_HTML_URL = 'https://www.cbr.ru/hd_base/KeyRate/';
export const CBR_KEY_RATE_CACHE_HOURS = intOr(envInt('CBR_KEY_RATE_CACHE_HOURS'), 24);
// ---------------------------------------------------------------------------
// Tinkoff Invest (только чтение, Часть 4)
// ---------------------------------------------------------------------------
// Токен read-only: не может выставлять или отменять ордера. Только через .env.
export const TINKOFF_INVEST_TOKEN = envStr('TINKOFF_INVEST_TOKEN');
export const TINKOFF_ACCOUNT_ID = envStr('TINKOFF_ACCOUNT_ID'); // необязательно: иначе первый брокерский
// Транспорт: rest — REST T-Invest API обычным fetch (по умолчанию, без лишних
// зависимостей), sdk — gRPC-библиотека tinkoff-investments, если она установлена вручную.
export const TINKOFF_TRANSPORT = (envStr('TINKOFF_TRANSPORT') || 'rest').toLowerCase();
// Хосты REST: основной (T-Bank) + резервный (Tinkoff). Перебираются при сетевом сбое.
export const TINKOFF_API_HOST = (
  envStr('TINKOFF_API_HOST') || 'https://invest-public-api.tbank.ru'
).replace(/\/+$/, '');
export const TINKOFF_API_BACKUP_HOSTS = (envStr('TINKOFF_API_BACKUP_HOSTS') || 'https://invest-public-api.tinkoff.ru')
  .split(',')
  .map((host) => host.trim().replace(/\/+$/, ''))
  .filter((host) => host.length > 0);
export const TINKOFF_API_BASE_URLS = [TINKOFF_API_HOST, ...TINKOFF_API_BACKUP_HOSTS];
export const TINKOFF_POSITIONS_CACHE_TTL_SEC = intOr(envInt('TINKOFF_POSITIONS_CACHE_TTL_SEC'), 300); // 5 минут
export const TINKOFF_FIGI_CACHE_TTL_SEC = 604800; // FIGI→тикер практически не меняется (7 суток)
export const TINKOFF_RETRIES = intOr(envInt('TINKOFF_RETRIES'), 2); // число ПОВТОРНЫХ попыток
export const TINKOFF_TIMEOUT_SEC = intOr(envInt('TINKOFF_TIMEOUT_SEC'), 15);
export const TINKOFF_RETRY_DELAY_SEC = intOr(envInt('TINKOFF_RETRY_DELAY_SEC'), 3);

// ---------------------------------------------------------------------------
// Прогнозы (Часть 3)
// ---------------------------------------------------------------------------
export const PREDICTION_CHECK_HOUR = intOr(envInt('PREDICTION_CHECK_HOUR'), 21); // ежедневная проверка идей, МСК
export const PREDICTION_CHECK_MINUTE = intOr(envInt('PREDICTION_CHECK_MINUTE'), 0);
export const PREDICTION_DEFAULT_HORIZON_DAYS = intOr(envInt('PREDICTION_DEFAULT_HORIZON_DAYS'), 30);
export const PREDICTION_FLAT_THRESHOLD_PCT = floatOr(envFloat('PREDICTION_FLAT_THRESHOLD_PCT'), 1.0);
export const PREDICTION_ACCURACY_WINDOW_DAYS = intOr(envInt('PREDICTION_ACCURACY_WINDOW_DAYS'), 30);
export const PREDICTION_TOP_TICKERS = intOr(envInt('PREDICTION_TOP_TICKERS'), 5);

// ---------------------------------------------------------------------------
// Fallback котировок (если API недоступен и в SQLite нет прошлых значений)
// ---------------------------------------------------------------------------
export const KEY_RATE = 16.0;
export const MOEX_VALUE = 3200.0;
export const MOEX_CHANGE = 0.0;
export const USDRUB = 92.0;
export const CNYRUB = 12.5;
export const EURRUB = 93.0;

// ---------------------------------------------------------------------------
// Прочее
// ---------------------------------------------------------------------------
// Пути можно переопределить через окружение — это нужно smoke_test.js, чтобы не
// писать в рабочую базу (в Python-версии тест подменял config.DB_PATH в рантайме).
export const DB_PATH = envStr('DB_PATH') || path.join(BASE_DIR, 'news_bot.sqlite3');
export const LOG_PATH = envStr('LOG_PATH') || path.join(BASE_DIR, 'bot.log');
export const LOG_LEVEL = envStr('LOG_LEVEL') || 'info';
export const LOG_MAX_BYTES = 5_000_000;
export const LOG_BACKUPS = 3;
export const JACCARD_THRESHOLD = 0.8; // порог схожести заголовков для дедупликации
export const TELEGRAM_MAX_MESSAGE_LEN = 3900; // лимит Telegram — 4096, оставляем запас
export const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 news-analyst-bot/1.0';

// ---------------------------------------------------------------------------
// Таймзона и хелперы времени (важно: сервер может быть в UTC)
// ---------------------------------------------------------------------------
const MSK_FALLBACK_OFFSET_MINUTES = 180;
const WEEKDAY_NAMES = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

let tzFormatter = null;

function formatter() {
  if (!tzFormatter) {
    tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return tzFormatter;
}

function partMap(date) {
  const map = {};
  for (const part of formatter().formatToParts(date)) map[part.type] = part.value;
  return map;
}

/** Смещение таймзоны проекта относительно UTC в минутах (МСК = +180). */
export function tzOffsetMinutes(date = new Date()) {
  try {
    const map = partMap(date);
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour) % 24,
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return MSK_FALLBACK_OFFSET_MINUTES;
  }
}

/** Компоненты местного времени (МСК) для момента date. */
export function mskParts(date = new Date()) {
  const map = partMap(date);
  const parts = {};
  for (const field of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    parts[field] = Number(map[field]);
  }
  parts.hour = parts.hour % 24;
  const weekday = localWeekdayIndex(date); // 0 — понедельник, как datetime.weekday()
  parts.weekday = weekday;
  parts.weekdayName = WEEKDAY_NAMES[weekday];
  return parts;
}

function localWeekdayIndex(date) {
  const map = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  const sundayBased = new Date(`${map.year}-${map.month}-${map.day}T00:00:00Z`).getUTCDay(); // 0 — вс
  return (sundayBased + 6) % 7;
}

/** Текущее время в МСК. Момент времени абсолютен — таймзона нужна для форматирования. */
export function nowMsk() {
  return new Date();
}

/** Приводит дату к моменту времени: числа трактуются как epoch-секунды (naive = UTC). */
export function toMsk(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'number') return new Date(value * 1000);
  return new Date(value);
}

function pad(value, width) {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0');
}

/** ISO-время в МСК с секундной точностью: «2026-10-15T14:00:00+03:00». */
export function mskIso(date) {
  if (!date) return null;
  const parts = mskParts(date);
  const offset = tzOffsetMinutes(date);
  const sign = offset < 0 ? '-' : '+';
  const offsetText = `${sign}${pad(Math.floor(Math.abs(offset) / 60), 2)}:${pad(Math.abs(offset) % 60, 2)}`;
  return (
    `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}` +
    `T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}${offsetText}`
  );
}

/** Разбирает ISO-время из БД/промпта (null при мусоре). */
export function parseIso(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Собирает момент времени из «настенных» компонентов МСК (месяц 1..12). */
export function mskWallDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = new Date(asUtc - tzOffsetMinutes(new Date(asUtc)) * 60000);
  // Уточняем смещение по итоговому моменту — важно на границах перехода времени.
  instant = new Date(asUtc - tzOffsetMinutes(instant) * 60000);
  return instant;
}

/** Мини-аналог strftime для хелперов проекта (%Y %m %d %H %M %S %y). */
export function strftimeMsk(date, pattern) {
  const parts = mskParts(date);
  const map = {
    '%Y': pad(parts.year, 4),
    '%y': pad(parts.year % 100, 2),
    '%m': pad(parts.month, 2),
    '%d': pad(parts.day, 2),
    '%H': pad(parts.hour, 2),
    '%M': pad(parts.minute, 2),
    '%S': pad(parts.second, 2),
    '%w': String(parts.weekday),
    '%A': parts.weekdayName,
    '%%': '%',
  };
  return String(pattern).replace(/%%|%[YymdHMSwA]/g, (token) => map[token] ?? token);
}

export function formatHhmm(date) {
  return strftimeMsk(date, '%H:%M');
}

