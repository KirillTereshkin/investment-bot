/**
 * Сбор новостей из RSS-источников (порт news/collector.py).
 *
 * Каждый источник обрабатывается независимо: падение одного не роняет job.
 * Возвращаемая по источнику структура:
 *     {
 *         source: "RBC Economics",
 *         url: "...",
 *         status: "ok" | "empty" | "error",
 *         reason: "timeout" | "http_500" | "parse_error" | null,
 *         count: 8,
 *         items: [...]
 *     }
 *
 * Вместо feedparser используется fast-xml-parser: XML разбирается «как есть»,
 * даты приводятся к МСК вручную.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { FetchError, delay, decodeBuffer, requestOnce, responseBytes } from '../http.js';

const logger = getLogger('news.collector');

// RSS-источники по российскому рынку
// Проверено 15.10.2026: www.rbc.ru/rss/economics и www.rbc.ru/rss/finance отдают 404,
// вместо них используются rssexport.rbc.ru (общая лента RBC) и официальная лента ЦБ РФ.
// Рабочие альтернативы при необходимости: https://www.vedomosti.ru/rss/news,
// https://lenta.ru/rss/news, https://www.banki.ru/xml/news.rss.
export const SOURCES = [
  { name: 'RBC News', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss' },
  { name: 'CBR', url: 'https://www.cbr.ru/rss/RssNews' },
  { name: 'TASS', url: 'https://tass.ru/rss/v2.xml' },
  { name: 'Interfax', url: 'https://www.interfax.ru/rss.asp' },
  { name: 'Kommersant', url: 'https://www.kommersant.ru/RSS/news.xml' },
  { name: 'Investing.com', url: 'https://ru.investing.com/rss/news_25.rss' },
];

export const HEADERS = {
  'User-Agent': config.HTTP_USER_AGENT,
  Accept: 'application/rss+xml, application/xml, text/xml, */*',
};

const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/gu;
const SENTENCE_RE = /[.!?…]\s+/u;

// Допуск для «новостей из будущего» — некоторые RSS отдают дату с завышением
export const FUTURE_TOLERANCE_SEC = 900;
// Длина обрезки первого предложения summary в дайджесте
export const SUMMARY_LIMIT = 220;

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  deg: '°',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
};

/** html.unescape: числовые и именованные сущности (неизвестные оставляем как есть). */
export function unescapeHtml(raw) {
  return String(raw).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const known = HTML_ENTITIES[body.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/** Убирает HTML-теги, HTML-сущности и лишние пробелы. */
export function cleanText(raw) {
  if (!raw) return '';
  const text = String(raw).replace(TAG_RE, ' ');
  return unescapeHtml(text).replace(WHITESPACE_RE, ' ').trim();
}

/** Обрезка по КОДОВЫМ ТОЧКАМ (как срез строки в Python). */
function sliceChars(text, limit) {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

/** Первое предложение summary (или обрезок, если предложения нет). */
export function firstSentence(text, limit = SUMMARY_LIMIT) {
  const cleaned = cleanText(text);
  if (!cleaned) return '';
  const match = SENTENCE_RE.exec(cleaned);
  // Разделитель — сам знак из [.!?…], поэтому срез идёт до позиции пробелов
  let sentence = (match ? cleaned.slice(0, match.index + 1) : cleaned).trim();
  if (Array.from(sentence).length > limit) sentence = `${sliceChars(sentence, limit - 1).trimEnd()}…`;
  return sentence;
}
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Именованные таймзоны, которые встречаются в RSS (часы относительно UTC)
const TZ_OFFSETS = {
  ut: 0, utc: 0, gmt: 0, z: 0, wet: 0,
  est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7,
  cet: 1, cest: 2, met: 1, mest: 2, eet: 2, eest: 3, bst: 1, msk: 3, msd: 4,
};

function zoneOffsetMinutes(zone) {
  const text = String(zone || '').trim();
  if (!text) return 0;
  if (text === 'Z' || text === 'z') return 0;
  const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (numeric) {
    const sign = numeric[1] === '-' ? -1 : 1;
    return sign * (Number(numeric[2]) * 60 + Number(numeric[3]));
  }
  const hours = TZ_OFFSETS[text.toLowerCase()];
  return hours === undefined ? 0 : hours * 60;
}

/**
 * Дата публикации в UNIX-секундах (UTC) или null.
 *
 * Поддерживаются ISO 8601 и RFC 822/1123 — как это делает feedparser.
 * Дата без таймзоны считается UTC.
 */
export function parseFeedDate(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (iso) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', zone] = iso;
    const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (Number.isNaN(asUtc)) return null;
    return Math.floor((asUtc - zoneOffsetMinutes(zone) * 60000) / 1000);
  }

  const rfc = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[\s,]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|[A-Za-z]{1,5}))?/.exec(text);
  if (rfc) {
    const [, day, monthName, yearText, hour, minute, second = '0', zone] = rfc;
    const month = MONTHS[monthName.toLowerCase()];
    if (month === undefined) return null;
    let year = Number(yearText);
    if (yearText.length <= 2) year += year >= 70 ? 1900 : 2000;
    const asUtc = Date.UTC(year, month, Number(day), Number(hour), Number(minute), Number(second));
    if (Number.isNaN(asUtc)) return null;
    return Math.floor((asUtc - zoneOffsetMinutes(zone) * 60000) / 1000);
  }

  return null;
}

/** XML → объект; htmlEntities нужны для CDATA-описаний (как feedparser). */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
});

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function localName(key) {
  const text = String(key);
  const colon = text.indexOf(':');
  return colon === -1 ? text : text.slice(colon + 1);
}

function pickRaw(container, keys) {
  for (const key of keys) {
    if (container[key] !== undefined && container[key] !== null) return container[key];
  }
  return null;
}



/** Текст значения: строки, числа, объекты со #text, вложенные узлы. */
function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (typeof value['#text'] === 'string') return value['#text'];
    const parts = [];
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith('@_')) continue;
      const text = textOf(nested);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }
  return '';
}

function pickText(container, keys) {
  for (const key of keys) {
    const text = textOf(container[key]);
    if (text) return text;
  }
  return '';
}

/** Корень фида: channel (RSS), rdf:RDF, feed (Atom) — с учётом префиксов namespace. */
function findRoot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith('?'));
  for (const [key, value] of entries) {
    if (localName(key) === 'rss' && value && typeof value === 'object' && value.channel) return value.channel;
  }
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const name = localName(key).toLowerCase();
    if (name === 'rdf') return value; // item'ы лежат на верхнем уровне RDF
    if (name === 'feed' || name === 'channel') return value;
  }
  return parsed;
}

/**
 * Отбирает записи фида, попадающие в окно.
 * Возвращает [items, сколько записей без даты].
 */
export function parseEntries(entries, windowStartTs, windowEndTs) {
  const items = [];
  let undated = 0;
  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    const title = cleanText(pickText(entry, ['title', 'dc:title']));
    if (!title) continue;
    const publishedTs = parseFeedDate(
      pickText(entry, ['pubDate', 'pubdate', 'published', 'updated', 'dc:date', 'date']),
    );
    if (publishedTs === null) {
      // Новости без даты не берём: иначе они повторялись бы в каждом окне
      undated += 1;
      continue;
    }
    if (publishedTs < windowStartTs || publishedTs > windowEndTs + FUTURE_TOLERANCE_SEC) continue;
    items.push({
      title,
      summary: cleanText(pickText(entry, ['summary', 'description', 'content:encoded', 'content'])),
      link: entryLink(entry),
      published: config.mskIso(new Date(publishedTs * 1000)),
      published_ts: publishedTs,
    });
  }
  return [items, undated];
}

/** Результат по источнику в едином формате. */
function sourceResult(name, url, status, reason, items) {
  return { source: name, url, status, reason, count: items.length, items };
}

/** Разбирает скачанный фид и формирует результат по источнику. */
export function parseFeed(name, url, bytes, windowStartTs, windowEndTs) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  // Пустое тело при коде 200 — это ошибка источника, а не «новостей нет»
  if (raw.length === 0 || !raw.some((byte) => byte > 32)) {
    logger.error('Источник %s: пустой ответ', name);
    return sourceResult(name, url, 'error', 'empty_response', []);
  }

  const text = decodeBuffer(raw, '');
  let parsed;
  try {
    parsed = xmlParser.parse(text);
  } catch (exc) {
    logger.error('Источник %s: ошибка парсинга XML: %s', name, exc && exc.message ? exc.message : exc);
    return sourceResult(name, url, 'error', 'parse_error', []);
  }

  let validation = true;
  try {
    validation = XMLValidator.validate(text, { allowBooleanAttributes: true });
  } catch (exc) {
    validation = { err: { msg: String(exc && exc.message ? exc.message : exc) } };
  }

  const entries = findEntries(findRoot(parsed));
  if (validation !== true && entries.length === 0) {
    logger.error('Источник %s: сломанный XML (%s)', name, validation.err ? validation.err.msg : 'unknown');
    return sourceResult(name, url, 'error', 'parse_error', []);
  }
  if (validation !== true) {
    logger.warning('Источник %s: XML с замечаниями, записи прочитаны (%s)', name, validation.err ? validation.err.msg : '?');
  }

  const [items, undated] = parseEntries(entries, windowStartTs, windowEndTs);
  for (const item of items) {
    item.source = name;
    item.source_url = url;
  }
  if (undated) {
    logger.info('Источник %s: пропущено %s записей без даты публикации', name, undated);
  }

  const status = items.length ? 'ok' : 'empty';
  logger.info('Источник %s: %s, новостей в окне — %s', name, status, items.length);
  return sourceResult(name, url, status, null, items);
}


/**
 * Скачивает и разбирает один источник.
 *
 * При падении делает config.SOURCE_RETRIES повторов с задержкой
 * config.SOURCE_RETRY_DELAY_SEC секунд. Исключения наружу не пробрасываются.
 */
export async function fetchSource(source, windowStartTs, windowEndTs, options = {}) {
  const { fetchImpl } = options;
  const name = source.name;
  const url = source.url;
  const attempts = config.SOURCE_RETRIES + 1;
  let reason = 'unknown_error';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null;
    try {
      response = await requestOnce(url, {
        headers: HEADERS,
        timeoutMs: config.SOURCE_TIMEOUT_SEC * 1000,
        fetchImpl,
      });
    } catch (exc) {
      reason = exc instanceof FetchError ? exc.reason : 'unknown_error';
      if (reason === 'connection_error') {
        logger.warning('Источник %s: сетевая ошибка (%s)', name, exc.message);
      } else if (reason === 'timeout') {
        logger.warning('Источник %s: таймаут %s сек', name, config.SOURCE_TIMEOUT_SEC);
      } else {
        logger.error('Источник %s: непредвиденная ошибка: %s', name, exc.message);
      }
    }

    if (response) {
      if (response.status >= 400) {
        reason = `http_${response.status}`;
      } else {
        return parseFeed(name, url, await responseBytes(response), windowStartTs, windowEndTs);
      }
    }

    if (attempt < attempts) {
      logger.warning(
        'Источник %s: попытка %s/%s не удалась (%s), повтор через %s сек',
        name,
        attempt,
        attempts,
        reason,
        config.SOURCE_RETRY_DELAY_SEC,
      );
      await delay(config.SOURCE_RETRY_DELAY_SEC * 1000);
    }
  }

  logger.error('Источник %s: данные не получены после %s попыток (%s)', name, attempts, reason);
  return sourceResult(name, url, 'error', reason, []);
}

/**
 * Собирает все источники.
 *
 * Возвращает [статусы источников, плоский список новостей]. Новости идут
 * в порядке обхода источников, каждый item содержит ключ "source".
 */
export async function collectAll(windowStart, windowEnd, options = {}) {
  const windowStartTs = windowStart.getTime() / 1000;
  const windowEndTs = windowEnd.getTime() / 1000;
  logger.info(
    'Сбор новостей за окно %s — %s МСК',
    config.formatHhmm(windowStart),
    config.formatHhmm(windowEnd),
  );

  const results = [];
  const allItems = [];
  for (const source of SOURCES) {
    const result = await fetchSource(source, windowStartTs, windowEndTs, options);
    results.push(result);
    allItems.push(...result.items);
  }

  const okCount = results.filter((item) => item.status === 'ok').length;
  logger.info(
    'Сбор завершён: %s/%s источников с новостями, всего новостей — %s',
    okCount,
    results.length,
    allItems.length,
  );
  return [results, allItems];
}

/**
 * Собирает дайджест «источник | заголовок | первое предложение summary».
 *
 * Строки берутся round-robin по источникам, чтобы в дайджест попали все
 * источники, а не только первый. Всего не более config.MAX_DIGEST_LINES строк.
 */
export function buildDigest(items, maxLines = null) {
  const limit = maxLines === null || maxLines === undefined ? config.MAX_DIGEST_LINES : maxLines;
  if (!items || items.length === 0) return '';

  const groups = new Map();
  for (const item of items) {
    const name = String((item && item.source) || 'unknown');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const order = [...groups.keys()];

  const lines = [];
  let index = 0;
  while (lines.length < limit) {
    let added = false;
    for (const name of order) {
      const bucket = groups.get(name);
      if (index >= bucket.length) continue;
      const item = bucket[index];
      const summary = firstSentence(item.summary || '');
      let line = `${name} | ${String(item.title || '').trim()}`;
      if (summary) line += ` | ${summary}`;
      lines.push(line);
      added = true;
      if (lines.length >= limit) break;
    }
    if (!added) break;
    index += 1;
  }

  return lines.join('\n');
}

/** Список записей фида (item/entry) с любым namespace-префиксом. */
function findEntries(root) {
  if (!root || typeof root !== 'object') return [];
  for (const [key, value] of Object.entries(root)) {
    if (key === '#text' || key.startsWith('@_') || key.startsWith('?')) continue;
    const name = localName(key).toLowerCase();
    if (name === 'item' || name === 'entry') return asArray(value);
  }
  return [];
}

/** Ссылка записи: RSS <link>…</link> или Atom <link rel="alternate" href="…"/>. */
function entryLink(entry) {
  for (const candidate of asArray(entry.link)) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && candidate['@_href']) {
      const rel = candidate['@_rel'];
      if (rel === undefined || rel === 'alternate') return String(candidate['@_href']).trim();
    }
  }
  for (const candidate of asArray(pickRaw(entry, ['guid', 'id', 'dc:identifier']))) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) return candidate.trim();
  }
  return '';
}
