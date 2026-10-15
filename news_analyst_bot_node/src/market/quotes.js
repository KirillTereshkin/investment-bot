/**
 * Реальные рыночные данные: ЦБ РФ (курсы валют, ключевая ставка) и MOEX ISS (IMOEX, цены).
 * Порт market/quotes.py.
 *
 * Логика по Части 1 ТЗ:
 * 1. пробуем живой запрос к источнику (timeout config.MOEX_ISS_TIMEOUT_SEC,
 *    config.MOEX_ISS_RETRIES повторов с паузой config.MOEX_ISS_RETRY_DELAY_SEC);
 * 2. если источник упал — берём последнее значение из SQLite (market_snapshots);
 * 3. если и в базе пусто — fallback из config.js + WARNING в лог.
 *
 * Ключевая ставка кэшируется на config.CBR_KEY_RATE_CACHE_HOURS (24 ч): меняется 8 раз в год.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { FetchError, requestWithRetry, responseBytes } from '../http.js';
import * as db from '../storage/db.js';

const logger = getLogger('market.quotes');

export { FetchError };

const HEADERS = {
  'User-Agent': config.HTTP_USER_AGENT,
  Accept: 'application/json, application/xml, text/xml, text/html, */*',
};

// Имена источников в source_status (JSON в market_snapshots.source_status)
export const SOURCE_CBR_RATES = 'cbr_rates';
export const SOURCE_MOEX_INDEX = 'moex_index';
export const SOURCE_KEY_RATE = 'key_rate';

// Сколько секунд держать один снимок в памяти процесса (за прогон данные берутся один раз)
export const SNAPSHOT_CACHE_TTL_SEC = 60;

/** Число из строки/числа: «14,00», «1 234,5», «-0.92%» → float. */
export function toFloat(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value)
    .replace(/\u00a0/g, '')
    .replace(/ /g, '')
    .replace(/%/g, '')
    .trim()
    .replace(/,/g, '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})/;

/** Дата ЦБ РФ «15.10.2026» → МСК-момент времени (иначе null). */
export function parseCbrDate(value) {
  if (!value) return null;
  const match = DATE_RE.exec(String(value));
  if (!match) return null;
  const [, day, month, year] = match;
  const dayNumber = Number(day);
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  const parsed = config.mskWallDate(Number(year), monthNumber, dayNumber);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = config.mskParts(parsed);
  if (parts.day !== dayNumber || parts.month !== monthNumber || parts.year !== Number(year)) return null;
  return parsed;
}

/** Декодирует тело ответа: UTF-8, затем windows-1251 (XML ЦБ РФ отдаёт в cp1251). */
export function decodeStrict(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (raw.length === 0) throw new FetchError('empty_response');
  for (const encoding of ['utf-8', 'windows-1251']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(raw);
    } catch {
      /* пробуем следующую кодировку */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(raw);
}

/** GET с повторами. Бросает FetchError с короткой причиной (timeout/http_500/...). */
export async function httpGet(url, { retries = null, timeoutSec = null, fetchImpl } = {}) {
  return requestWithRetry(url, {
    headers: HEADERS,
    retries: retries === null || retries === undefined ? config.MOEX_ISS_RETRIES : retries,
    timeoutSec: timeoutSec === null || timeoutSec === undefined ? config.MOEX_ISS_TIMEOUT_SEC : timeoutSec,
    retryDelaySec: config.MOEX_ISS_RETRY_DELAY_SEC,
    label: url,
    fetchImpl,
  });
}

/** MOEX ISS-блок {columns, data} → список объектов. */
export function blockRows(block) {
  if (!block || typeof block !== 'object') return [];
  const columns = block.columns || [];
  return (block.data || []).map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );
}

/** Первая строка блока MOEX ISS. */
export function firstRow(block) {
  const rows = blockRows(block);
  return rows.length ? rows[0] : {};
}

/** Курсы USD/RUB, CNY/RUB, EUR/RUB с cbr-xml-daily.ru (зеркало официального XML ЦБ). */
export async function fetchCbrRates(options = {}) {
  const response = await httpGet(config.CBR_DAILY_URL, options);
  let payload;
  try {
    payload = JSON.parse(decodeStrict(await responseBytes(response)));
  } catch (exc) {
    throw new FetchError('parse_error', exc && exc.message ? exc.message : String(exc));
  }

  const valute = payload ? payload.Valute : null;
  if (!valute || typeof valute !== 'object') throw new FetchError('parse_error');

  const rates = {};
  for (const [code, key] of [['USD', 'usdrub'], ['CNY', 'cnyrub'], ['EUR', 'eurrub']]) {
    const entry = valute[code];
    if (!entry || typeof entry !== 'object') continue;
    const nominal = toFloat(entry.Nominal) || 1.0;
    const value = toFloat(entry.Value);
    if (value === null || !nominal) continue;
    rates[key] = Math.round((value / nominal) * 10000) / 10000;
  }

  if (Object.keys(rates).length === 0) throw new FetchError('parse_error');
  logger.info(
    'ЦБ РФ: курсы получены — USD/RUB %s, CNY/RUB %s, EUR/RUB %s',
    rates.usdrub,
    rates.cnyrub,
    rates.eurrub,
  );
  return rates;
}

/**
 * IMOEX с MOEX ISS (ключ не нужен, задержка ~15 минут).
 *
 * Значение — колонка CURRENTVALUE. Для изменения проверяются LASTCHANGEPRCNT
 * (так в ТЗ, эта колонка есть у акций) и LASTCHANGEPRC (фактическое имя у индекса).
 */
export async function fetchMoexIndex(options = {}) {
  const response = await httpGet(`${config.MOEX_ISS_INDEX_URL}?iss.meta=off`, options);
  let payload;
  try {
    payload = JSON.parse(decodeStrict(await responseBytes(response)));
  } catch (exc) {
    throw new FetchError('parse_error', exc && exc.message ? exc.message : String(exc));
  }

  const row = firstRow(payload ? payload.marketdata : null);
  let value = toFloat(row.CURRENTVALUE);
  if (value === null) value = toFloat(row.LASTVALUE);
  if (value === null) throw new FetchError('parse_error');

  let change = null;
  for (const column of ['LASTCHANGEPRCNT', 'LASTCHANGEPRC', 'LASTCHANGETOOPENPRC']) {
    change = toFloat(row[column]);
    if (change !== null) break;
  }

  logger.info('MOEX ISS: IMOEX=%s (%s%% за сутки)', value, change);
  return { moex_value: value, moex_change: change === null ? 0.0 : change };
}

/**
 * Текущая цена тикера с MOEX ISS: сначала акции (TQBR), затем фонды (TQTF).
 *
 * null означает «цену узнать не удалось» — идея сохраняется, но не проверяется.
 * TODO(инструменты): ОФЗ, фьючерсы и валютные пары (CNY/RUB) на этих бордах не торгуются,
 * для них нужны рынки bonds/forts/currency — отдельная доработка.
 */
export async function fetchTickerPrice(ticker, options = {}) {
  const symbol = String(ticker || '').trim().toUpperCase();
  if (!symbol) return null;

  for (const board of config.MOEX_TICKER_BOARDS) {
    const url = `${config.MOEX_ISS_SHARES_URL.replace('{board}', board).replace('{ticker}', symbol)}?iss.meta=off`;
    let payload;
    try {
      const response = await httpGet(url, options);
      payload = JSON.parse(decodeStrict(await responseBytes(response)));
    } catch (exc) {
      if (exc instanceof FetchError) {
        logger.warning('MOEX ISS: цена %s недоступна (%s)', symbol, exc.reason || exc.message);
      } else {
        logger.warning('MOEX ISS: ответ по %s не является JSON', symbol);
      }
      return null;
    }

    const row = firstRow(payload ? payload.marketdata : null);
    let price = toFloat(row.LAST);
    if (price === null) price = toFloat(row.LCURRENTPRICE);
    if (price === null) price = toFloat(row.MARKETPRICE);
    if (price !== null) {
      logger.info('MOEX ISS: цена %s (%s) = %s', symbol, board, price);
      return price;
    }
  }

  logger.warning('MOEX ISS: цена %s не найдена на бордах %s', symbol, config.MOEX_TICKER_BOARDS);
  return null;
}

const TICKER_TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * Достаёт тикер MOEX из названия инструмента от модели.
 *
 * «SBER» → SBER, «GAZP (ао)» → GAZP, «ОФЗ 26238» → null, «CNY/RUB» → null
 * (ОФЗ и валютные пары проверяются другим рынком, см. TODO в fetch_ticker_price).
 */
export function extractTicker(instrument) {
  const text = String(instrument || '').trim().toUpperCase();
  if (!text || text.includes('/')) return null;
  const token = (text.split(/[\s,;:()[\]{}]+/)[0] || '').replace(/^[.,!?—\-+]+/, '').replace(/[.,!?—\-+]+$/, '');
  return TICKER_TOKEN_RE.test(token) ? token : null;
}

// ---------------------------------------------------------------------------
// Ключевая ставка ЦБ РФ: XML-эндпоинт (резерв) и HTML-таблица (рабочий)
// ---------------------------------------------------------------------------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** Текст вложенного узла (строки, объект с #text, список узлов). */
function xmlText(node, name) {
  if (!node || typeof node !== 'object') return null;
  const value = node[name];
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? xmlText({ [name]: value[0] }, name) : null;
  if (typeof value === 'object') {
    const inner = value['#text'];
    return inner === null || inner === undefined ? null : inner;
  }
  return value;
}

/** Обход всех элементов дерева (аналог ElementTree.iter) в порядке документа. */
function* walkXml(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkXml(item);
    return;
  }
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') continue;
    yield* walkXml(value);
  }
}

/**
 * Ключевая ставка из XML ЦБ РФ.
 *
 * Ожидаемая схема (https://www.cbr.ru/scripts/XML_key_rate.asp):
 *     <ValCurs ...><Record Date="15.10.2026" Rate="14.00"/>...</ValCurs>
 * Парсер терпим к двум вариантам записи значения: атрибуты Date/Rate и вложенные
 * узлы <Date>/<Rate>, и берёт запись с самой свежей датой.
 *
 * TODO(ставка): проверено 15.10.2026 — XML_key_rate.asp отдаёт HTML-страницу вместо XML,
 * поэтому рабочей остаётся HTML-таблица (parseKeyRateHtml). Код XML-ветки сохранён:
 * как только ЦБ вернёт XML, ставка снова пойдёт из него без правок.
 */
export function parseKeyRateXml(text) {
  const raw = String(text || '').trim();
  if (!raw || XMLValidator.validate(raw) !== true) {
    logger.warning('Ключевая ставка: XML не разобран (ответ не XML)');
    return null;
  }

  let root;
  try {
    root = xmlParser.parse(raw);
  } catch {
    logger.warning('Ключевая ставка: XML не разобран (ответ не XML)');
    return null;
  }

  const dated = [];
  const undated = [];
  for (const element of walkXml(root)) {
    let rate = toFloat(element['@_Rate']);
    if (rate === null) rate = toFloat(xmlText(element, 'Rate'));
    if (rate === null) continue;
    const date = parseCbrDate(element['@_Date'] ?? xmlText(element, 'Date'));
    if (date === null) undated.push(rate);
    else dated.push([date, rate]);
  }

  if (dated.length) {
    let best = dated[0];
    for (const pair of dated) {
      if (pair[0].getTime() > best[0].getTime()) best = pair;
    }
    return best[1];
  }
  return undated.length ? undated[undated.length - 1] : null;
}

const KEY_RATE_DATE_FULL_RE = /^\d{2}\.\d{2}\.\d{4}$/;

/**
 * Ключевая ставка из HTML-таблицы https://www.cbr.ru/hd_base/KeyRate/.
 *
 * Фактическая структура строки: <tr><td>15.10.2026</td><td>14,00</td></tr>,
 * первая строка таблицы — текущая ставка.
 */
export function parseKeyRateHtml(text) {
  const source = String(text || '');
  for (const rowMatch of source.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(
        cellMatch[1]
          .replace(/<[^>]+>/g, ' ')
          .replace('&nbsp;', ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    if (cells.length < 2 || !KEY_RATE_DATE_FULL_RE.test(cells[0])) continue;
    const rate = toFloat(cells[1]);
    if (rate !== null) return rate;
  }
  return null;
}

/**
 * Ключевая ставка ЦБ РФ: сначала XML-эндпоинт, затем HTML-таблица.
 *
 * Возвращает [ставка, имя сработавшего источника] — [number|null, 'xml' | 'html' | ''].
 */
export async function fetchKeyRate(options = {}) {
  const sources = [
    ['xml', config.CBR_KEY_RATE_URL, parseKeyRateXml],
    ['html', config.CBR_KEY_RATE_HTML_URL, parseKeyRateHtml],
  ];
  for (const [source, url, parser] of sources) {
    let text;
    try {
      text = decodeStrict(await responseBytes(await httpGet(url, options)));
    } catch (exc) {
      logger.warning('Ключевая ставка (%s): источник недоступен (%s)', source, exc.reason || exc.message);
      continue;
    }
    const rate = parser(text);
    if (rate === null) {
      logger.warning('Ключевая ставка (%s): ответ не разобран (%s)', source, url);
      continue;
    }
    logger.info('Ключевая ставка: %s%% (источник %s)', rate, source);
    return [rate, source];
  }
  return [null, ''];
}

// ---------------------------------------------------------------------------
// Снимок рынка: живой опрос → SQLite → config fallback
// ---------------------------------------------------------------------------
/** Результат опроса источников; ошибки не бросаются наружу, а собираются здесь. */
export class LiveQuotes {
  constructor({
    rates = null,
    ratesError = null,
    moex = null,
    moexError = null,
    keyRate = null,
    keyRateSource = null,
    keyRateError = null,
  } = {}) {
    this.rates = rates;
    this.rates_error = ratesError;
    this.moex = moex;
    this.moex_error = moexError;
    this.key_rate = keyRate;
    this.key_rate_source = keyRateSource;
    this.key_rate_error = keyRateError;
  }
}

/** Python-подобный repr словаря — для читаемой строки в логе. */
function dictRepr(mapping) {
  const parts = Object.entries(mapping).map(([key, value]) => `'${key}': '${value}'`);
  return `{${parts.join(', ')}}`;
}

/** Снимок рыночного контекста: значения + откуда они взяты. */
export class MarketSnapshot {
  constructor({
    capturedAt,
    usdrub = null,
    cnyrub = null,
    eurrub = null,
    moexValue = null,
    moexChange = null,
    keyRate = null,
    sourceStatus = null,
    staleValues = null,
    fallbackValues = null,
  } = {}) {
    this.captured_at = capturedAt;
    this.usdrub = usdrub;
    this.cnyrub = cnyrub;
    this.eurrub = eurrub;
    this.moex_value = moexValue;
    this.moex_change = moexChange;
    this.key_rate = keyRate;
    this.source_status = sourceStatus || {};
    this.stale_values = staleValues || []; // взято из SQLite (источник упал)
    this.fallback_values = fallbackValues || []; // взято из config.js
  }

  /** Значение по ключу с подстановкой fallback из config.js. */
  value(key) {
    return this.asPromptDict()[key];
  }

  /** Числа для промпта и payload: null всегда заменяется fallback'ом. */
  asPromptDict() {
    return {
      key_rate: this.key_rate === null ? config.KEY_RATE : this.key_rate,
      moex_value: this.moex_value === null ? config.MOEX_VALUE : this.moex_value,
      moex_change: this.moex_change === null ? config.MOEX_CHANGE : this.moex_change,
      usdrub: this.usdrub === null ? config.USDRUB : this.usdrub,
      cnyrub: this.cnyrub === null ? config.CNYRUB : this.cnyrub,
      eurrub: this.eurrub === null ? config.EURRUB : this.eurrub,
    };
  }

  /** Строка для market_snapshots и JSON в runs.market_snapshot. */
  asRow() {
    const values = this.asPromptDict();
    return {
      captured_at: db.isoSeconds(this.captured_at),
      usdrub: values.usdrub,
      cnyrub: values.cnyrub,
      eurrub: values.eurrub,
      moex_value: values.moex_value,
      moex_change_pct: values.moex_change,
      key_rate: values.key_rate,
      source_status: this.source_status,
      stale_values: this.stale_values,
      fallback_values: this.fallback_values,
    };
  }

  /** Строка для лога: значения и статусы источников. */
  logLine() {
    const values = this.asPromptDict();
    return (
      `IMOEX=${values.moex_value} (${values.moex_change}%), ` +
      `USD/RUB=${values.usdrub}, CNY/RUB=${values.cnyrub}, EUR/RUB=${values.eurrub}, ` +
      `ставка=${values.key_rate}% | источники: ${dictRepr(this.source_status)}`
    );
  }
}

/** Опрашивает все источники, гася ошибки: прогон не должен падать из-за котировок. */
export async function fetchLiveQuotes(options = {}) {
  const live = new LiveQuotes();

  try {
    live.rates = await fetchCbrRates(options);
  } catch (exc) {
    if (exc instanceof FetchError) {
      live.rates_error = exc.reason;
      logger.warning('ЦБ РФ: курсы валют недоступны (%s)', exc.reason);
    } else {
      live.rates_error = 'unknown_error';
      logger.exception('ЦБ РФ: непредвиденная ошибка при получении курсов: %s', exc);
    }
  }

  try {
    live.moex = await fetchMoexIndex(options);
  } catch (exc) {
    if (exc instanceof FetchError) {
      live.moex_error = exc.reason;
      logger.warning('MOEX ISS: индекс недоступен (%s)', exc.reason);
    } else {
      live.moex_error = 'unknown_error';
      logger.exception('MOEX ISS: непредвиденная ошибка при получении индекса: %s', exc);
    }
  }

  try {
    [live.key_rate, live.key_rate_source] = await fetchKeyRate(options);
  } catch (exc) {
    live.key_rate_error = 'unknown_error';
    logger.exception('ЦБ РФ: непредвиденная ошибка при получении ключевой ставки: %s', exc);
  }
  if (live.key_rate === null && live.key_rate_error === null) {
    live.key_rate_error = 'unavailable';
  }

  return live;
}

// Пары «поле снимка → колонка market_snapshots»
const RATES_FIELDS = [
  ['usdrub', 'usdrub'],
  ['cnyrub', 'cnyrub'],
  ['eurrub', 'eurrub'],
];
const INDEX_FIELDS = [
  ['moex_value', 'moex_value'],
  ['moex_change', 'moex_change_pct'],
];

/** Последний снимок из SQLite (или null, если база пуста/недоступна). */
function lastSnapshotRow() {
  try {
    return db.getLastMarketSnapshot();
  } catch (exc) {
    logger.warning('SQLite: не удалось прочитать market_snapshots (%s)', exc.message);
    return null;
  }
}

/** Добивает пустые значения последним снимком из SQLite (Часть 1, п. 2). */
function fillFromPrevious(snapshot, previous) {
  if (!previous) return;
  for (const [attr, column] of [...RATES_FIELDS, ...INDEX_FIELDS]) {
    if (snapshot[attr] !== null && snapshot[attr] !== undefined) continue;
    const value = toFloat(previous[column]);
    if (value === null) continue;
    snapshot[attr] = value;
    snapshot.stale_values.push(attr);
    logger.warning('Котировки: %s недоступно из API — используем последнее значение из SQLite (%s)', attr, value);
  }
}

/** Последний рубеж: значения из config.js + WARNING в лог (Часть 1, п. 3). */
function fillFromConfig(snapshot) {
  const fallbacks = {
    usdrub: config.USDRUB,
    cnyrub: config.CNYRUB,
    eurrub: config.EURRUB,
    moex_value: config.MOEX_VALUE,
    moex_change: config.MOEX_CHANGE,
  };
  for (const [attr, value] of Object.entries(fallbacks)) {
    if (snapshot[attr] !== null && snapshot[attr] !== undefined) continue;
    snapshot[attr] = Number(value);
    snapshot.fallback_values.push(attr);
    logger.warning('Котировки: %s недоступно ни в API, ни в SQLite — fallback config (%s)', attr, value);
  }
}

/** source_status прошлого снимка из SQLite (JSON-строка или уже словарь). */
function previousSourceStatus(previous) {
  if (!previous) return {};
  const raw = previous.source_status;
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [String(key), String(value)]));
  }
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), String(value)]));
    }
  }
  return {};
}

/**
 * Ключевая ставка: кэш 24 ч в SQLite → живой запрос → просроченный кэш → config.
 *
 * Кэш считается доверенным только если в прошлом снимке ставка пришла из живого
 * источника (source_status «ok...»/«cache»), а не была fallback-значением config:
 * иначе одна неудачная попытка заморозила бы fallback на сутки.
 */
function resolveKeyRate(snapshot, previous, live) {
  const previousStatus = previousSourceStatus(previous)[SOURCE_KEY_RATE] || '';
  const cachedValue = previous ? toFloat(previous.key_rate) : null;
  const cachedAt = previous ? db.parseIso(previous.captured_at) : null;
  const cacheTrusted = previousStatus.startsWith('ok') || previousStatus === 'cache';

  if (cacheTrusted && cachedValue !== null && cachedAt !== null) {
    const ageHours = (snapshot.captured_at.getTime() - cachedAt.getTime()) / 3600000;
    if (ageHours <= config.CBR_KEY_RATE_CACHE_HOURS) {
      snapshot.key_rate = cachedValue;
      snapshot.source_status[SOURCE_KEY_RATE] = 'cache';
      logger.info(
        'Ключевая ставка из кэша SQLite: %s%% (обновлено %s, %s ч назад)',
        cachedValue,
        config.strftimeMsk(cachedAt, '%d.%m.%Y %H:%M'),
        ageHours.toFixed(1),
      );
      return;
    }
  }

  if (live.key_rate !== null && live.key_rate !== undefined) {
    snapshot.key_rate = live.key_rate;
    snapshot.source_status[SOURCE_KEY_RATE] = live.key_rate_source ? `ok:${live.key_rate_source}` : 'ok';
    return;
  }

  if (cacheTrusted && cachedValue !== null) {
    snapshot.key_rate = cachedValue;
    snapshot.source_status[SOURCE_KEY_RATE] = 'stale_cache';
    snapshot.stale_values.push('key_rate');
    logger.warning(
      'Ключевая ставка: источники недоступны (%s) — берём просроченный кэш из SQLite (%s)',
      live.key_rate_error,
      cachedValue,
    );
    return;
  }

  snapshot.key_rate = Number(config.KEY_RATE);
  snapshot.fallback_values.push('key_rate');
  snapshot.source_status[SOURCE_KEY_RATE] = `error:${live.key_rate_error || 'unknown_error'}`;
  logger.warning(
    'Ключевая ставка: источники недоступны (%s) и в SQLite нет доверенного значения — ' +
      'fallback config.KEY_RATE=%s%%',
    live.key_rate_error,
    snapshot.key_rate,
  );
}

/** Пишет снимок в market_snapshots; ошибка БД не должна ронять анализ. */
function safeSave(snapshot) {
  const row = snapshot.asRow();
  try {
    db.saveMarketSnapshot({
      capturedAt: snapshot.captured_at,
      usdrub: row.usdrub,
      cnyrub: row.cnyrub,
      eurrub: row.eurrub,
      moexValue: row.moex_value,
      moexChangePct: row.moex_change_pct,
      keyRate: row.key_rate,
      sourceStatus: snapshot.source_status,
    });
  } catch (exc) {
    logger.warning('SQLite: не удалось сохранить снимок рынка (%s)', exc.message);
  }
}

/**
 * Собирает снимок рынка по цепочке: живой источник → SQLite → config fallback.
 *
 * fetchLive подменяется в тестах; по умолчанию — реальный опрос ЦБ РФ и MOEX ISS.
 */
export async function buildSnapshot({ fetchLive = null, save = true, options = {} } = {}) {
  const fetcher = fetchLive || (() => fetchLiveQuotes(options));
  const snapshot = new MarketSnapshot({ capturedAt: config.nowMsk() });
  const previous = lastSnapshotRow();

  let live;
  try {
    live = (await fetcher()) || new LiveQuotes();
  } catch (exc) {
    logger.exception('Котировки: непредвиденная ошибка опроса источников: %s', exc);
    live = new LiveQuotes({
      ratesError: 'unknown_error',
      moexError: 'unknown_error',
      keyRateError: 'unknown_error',
    });
  }

  if (live.rates) {
    snapshot.usdrub = live.rates.usdrub === undefined ? null : live.rates.usdrub;
    snapshot.cnyrub = live.rates.cnyrub === undefined ? null : live.rates.cnyrub;
    snapshot.eurrub = live.rates.eurrub === undefined ? null : live.rates.eurrub;
    snapshot.source_status[SOURCE_CBR_RATES] = 'ok';
  } else {
    snapshot.source_status[SOURCE_CBR_RATES] = `error:${live.rates_error || 'unknown_error'}`;
  }

  if (live.moex) {
    snapshot.moex_value = live.moex.moex_value === undefined ? null : live.moex.moex_value;
    snapshot.moex_change = live.moex.moex_change === undefined ? null : live.moex.moex_change;
    snapshot.source_status[SOURCE_MOEX_INDEX] = 'ok';
  } else {
    snapshot.source_status[SOURCE_MOEX_INDEX] = `error:${live.moex_error || 'unknown_error'}`;
  }

  fillFromPrevious(snapshot, previous);
  resolveKeyRate(snapshot, previous, live);
  fillFromConfig(snapshot);

  if (save) safeSave(snapshot);

  logger.info('Снимок рынка: %s', snapshot.logLine());
  if (snapshot.fallback_values.length) {
    logger.warning('Котировки: использованы fallback-значения из config: %s', snapshot.fallback_values);
  }
  return snapshot;
}

let cachedSnapshot = null;

/**
 * Снимок рынка с коротким кэшем в памяти процесса (SNAPSHOT_CACHE_TTL_SEC).
 *
 * За один прогон анализ обращается к котировкам несколько раз — сеть дёргаем один раз.
 */
export async function getSnapshot(force = false, options = {}) {
  if (!force && cachedSnapshot !== null) {
    const age = (config.nowMsk().getTime() - cachedSnapshot.captured_at.getTime()) / 1000;
    if (age < SNAPSHOT_CACHE_TTL_SEC) return cachedSnapshot;
  }
  cachedSnapshot = await buildSnapshot(options);
  return cachedSnapshot;
}

/** Сбрасывает кэш снимка в памяти процесса (нужно тестам и ручным проверкам). */
export function resetCache() {
  cachedSnapshot = null;
}






