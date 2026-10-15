/**
 * Логирование: stdout + файл bot.log с ротацией.
 *
 * Аналог связки logging + RotatingFileHandler из main.py:
 * формат «%(asctime)s | %(levelname)-8s | %(name)s | %(message)s»,
 * 5 МБ на файл, 3 бэкапа (bot.log.1 … bot.log.3).
 *
 * Модуль не тянет config.js (иначе получился бы цикл импортов): значения
 * уровня и пути приходят через configure_logging() из main.js.
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// Подписи как в Python: levelname шириной 8 символов (INFO, WARNING, ERROR).
const LEVEL_LABELS = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

const DEFAULT_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'bot.log');
const DEFAULT_TIMEZONE = 'Europe/Moscow';

/**
 * Путь к файлу лога по умолчанию: переменная окружения LOG_PATH (как в config.js),
 * иначе bot.log в корне проекта. Нужна тестам, чтобы они не писали в рабочий лог;
 * configureLogging({ file }) из main.js всё равно имеет приоритет.
 */
function initialFilePath() {
  const fromEnv = (process.env.LOG_PATH || '').trim();
  if (!fromEnv) return DEFAULT_FILE;
  try {
    return path.resolve(fromEnv);
  } catch {
    return DEFAULT_FILE;
  }
}

let minLevel = LEVELS.info;
let timezone = process.env.TIMEZONE || DEFAULT_TIMEZONE;
let filePath = initialFilePath();
let maxBytes = 5_000_000;
let backupCount = 3;
let fileBytes = null;
let fileEnabled = true;
let warnedAboutFile = false;

let stampFormatter = null;

function buildFormatter() {
  stampFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function timestamp() {
  try {
    if (!stampFormatter) buildFormatter();
    const map = {};
    for (const part of stampFormatter.formatToParts(new Date())) map[part.type] = part.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  } catch {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
}

/** Поддержка уровней «info», «warning», «40» — как logging.getLevelName наоборот. */
export function levelFromName(name) {
  if (name === undefined || name === null || name === '') return null;
  const text = String(name).trim().toLowerCase();
  if (LEVELS[text]) return LEVELS[text];
  if (text === 'warning') return LEVELS.warn;
  if (text === 'fatal' || text === 'critical') return LEVELS.error;
  const numeric = Number.parseInt(text, 10);
  if (!Number.isNaN(numeric)) {
    if (numeric <= LEVELS.debug) return LEVELS.debug;
    if (numeric <= LEVELS.info) return LEVELS.info;
    if (numeric <= LEVELS.warn) return LEVELS.warn;
    return LEVELS.error;
  }
  return null;
}

export function configureLogging({ level, file, maxFileBytes, backups, tz } = {}) {
  const parsedLevel = levelFromName(level);
  if (parsedLevel !== null) minLevel = parsedLevel;
  if (tz) {
    timezone = tz;
    stampFormatter = null;
  }
  if (file) {
    filePath = file;
    fileBytes = null;
    fileEnabled = true;
    warnedAboutFile = false;
  }
  if (Number.isFinite(maxFileBytes) && maxFileBytes > 0) maxBytes = maxFileBytes;
  if (Number.isFinite(backups) && backups >= 0) backupCount = backups;
}

function ensureFileState() {
  if (fileBytes !== null) return;
  try {
    fileBytes = fs.statSync(filePath).size;
  } catch {
    fileBytes = 0;
  }
}

function rotateIfNeeded(nextLength) {
  ensureFileState();
  if (fileBytes + nextLength <= maxBytes) return;
  // Как RotatingFileHandler: bot.log.1 → bot.log.2 … затем bot.log → bot.log.1
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    try {
      fs.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
    } catch {
      /* файла нет — это нормально */
    }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* файла нет — это нормально */
  }
  fileBytes = 0;
}

function writeToFile(line) {
  if (!fileEnabled) return;
  const payload = `${line}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  try {
    rotateIfNeeded(bytes);
    fs.appendFileSync(filePath, payload, 'utf8');
    fileBytes = (fileBytes ?? 0) + bytes;
  } catch (exc) {
    fileEnabled = false;
    if (!warnedAboutFile) {
      warnedAboutFile = true;
      process.stderr.write(`Не удалось открыть файл лога ${filePath}: ${exc.message}\n`);
    }
  }
}

/** Подставляет аргументы в «%s»-строку как logging; иначе склеивает через пробел. */
export function formatMessage(message, args) {
  if (!args || args.length === 0) return String(message);
  const text = String(message);
  // Как logging: %[флаги][ширина][.точность][sdrf]
  const spec = /%[-+ 0]*(\d+)?(?:\.(\d+))?[sdrf]/;
  if (!spec.test(text)) return [text, ...args.map((arg) => stringify(arg))].join(' ');
  let index = 0;
  // Как logging: «%s%%» → «значение%» (двойной процент схлопывается)
  return text
    .replace(/%([-+ 0]*)(\d+)?(?:\.(\d+))?([sdrf])/g, (match, flags, width, precision, kind) => {
      if (index >= args.length) return match;
      const value = args[index++];
      let rendered = kind === 'd' ? formatInteger(value) : kind === 'f' ? formatFloat(value, precision) : stringify(value);
      if (width) rendered = padRendered(rendered, Number(width), flags);
      return rendered;
    })
    .replace(/%%/g, '%');
}

/** %d — как в logging: целое (float усекается). */
function formatInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return stringify(value);
}

/** %f — как в logging: precision по умолчанию 6 знаков. */
function formatFloat(value, precision) {
  const num = Number(value);
  if (!Number.isFinite(num)) return stringify(value);
  return num.toFixed(precision === undefined ? 6 : Number(precision));
}

/** %10s / %-10s / %010d — выравнивание по ширине. */
function padRendered(rendered, width, flags = '') {
  if (!Number.isFinite(width) || rendered.length >= width) return rendered;
  if (flags.includes('-')) return rendered.padEnd(width);
  if (flags.includes('0')) return rendered.padStart(width, '0');
  return rendered.padStart(width);
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(level, name, message, args) {
  const line = `${timestamp()} | ${LEVEL_LABELS[level].padEnd(8)} | ${name} | ${formatMessage(message, args)}`;
  // Как StreamHandler(sys.stdout) в main.py: весь лог идёт в stdout.
  process.stdout.write(`${line}\n`);
  writeToFile(line);
}

/** Логгер в стиле logging.getLogger(__name__). */
export function getLogger(name) {
  return {
    name,
    level: minLevel,
    debug: (message, ...args) => {
      if (minLevel <= LEVELS.debug) log('debug', name, message, args);
    },
    info: (message, ...args) => {
      if (minLevel <= LEVELS.info) log('info', name, message, args);
    },
    warning: (message, ...args) => {
      if (minLevel <= LEVELS.warn) log('warn', name, message, args);
    },
    error: (message, ...args) => {
      if (minLevel <= LEVELS.error) log('error', name, message, args);
    },
    exception: (message, ...args) => log('error', name, message, args),
  };
}

export function closeLogging() {
  /* sync-запись: закрывать нечего, функция для симметрии с Python */
}
