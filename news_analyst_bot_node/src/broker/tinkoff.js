/**
 * Tinkoff Invest API: счета и открытые позиции — только чтение (Часть 4).
 * Порт broker/tinkoff.py.
 *
 * Жёсткие ограничения:
 * * вызываются исключительно read-only методы (UsersService/GetAccounts,
 *   OperationsService/GetPortfolio, InstrumentsService/GetInstrumentBy) —
 *   postOrder / cancelOrder / sandbox в коде отсутствуют;
 * * токен только из .env (config.TINKOFF_INVEST_TOKEN), никаких хардкодов;
 * * по умолчанию работа идёт через REST T-Invest API глобальным fetch:
 *   дополнительных библиотек не требуется; gRPC-SDK остаётся опциональным
 *   (TINKOFF_TRANSPORT=sdk, если он установлен вручную);
 * * нет токена / API недоступен / сеть отвалилась — бот продолжает работать без
 *   блока «По вашим позициям»;
 * * публичные функции никогда не бросают исключений — наружу отдаётся
 *   PortfolioSnapshot со статусом (для строки «💼 Tinkoff: ...» в Telegram и для лога).
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { FetchError, delay, requestOnce, responseText } from '../http.js';
import * as db from '../storage/db.js';

const logger = getLogger('broker.tinkoff');

// Статусы портфеля (идут в текст сообщения и в runs.tinkoff_status)
export const STATUS_OK = 'ok';
export const STATUS_NO_TOKEN = 'no_token';
export const STATUS_LIBRARY_MISSING = 'library_missing';
export const STATUS_TOKEN_EXPIRED = 'token_expired';
export const STATUS_TIMEOUT = 'timeout';
export const STATUS_RATE_LIMITED = 'rate_limited';
export const STATUS_ERROR = 'error';

// Код ошибки API «токен неактуален»: живёт 3 месяца с последнего использования
export const TOKEN_EXPIRED_CODE = '40003';

// HTTP-коды REST, при которых запрос имеет смысл повторить
export const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

export const CACHE_KEY_PORTFOLIO = 'tinkoff_portfolio';
export const CACHE_KEY_FIGI_MAP = 'tinkoff_figi_ticker';

// REST-метод: POST {host}/rest/tinkoff.public.invest.api.contract.v1.<Service>/<Method>
export const REST_API_PREFIX = '/rest/tinkoff.public.invest.api.contract.v1.';
export const REST_USERS_SERVICE = 'UsersService';
export const REST_OPERATIONS_SERVICE = 'OperationsService';
export const REST_INSTRUMENTS_SERVICE = 'InstrumentsService';
export const REST_ID_TYPE_FIGI = 'INSTRUMENT_ID_TYPE_FIGI';
export const REST_ID_TYPE_UID = 'INSTRUMENT_ID_TYPE_UID';

export const INSTRUMENT_TYPE_TITLES = {
  share: 'акция',
  currency: 'валюта',
  bond: 'облигация',
  etf: 'фонд',
  futures: 'фьючерс',
};

export const MONEY_SIGNS = { rub: '₽', usd: '$', eur: '€', cny: '¥' };

/** API недоступен (нет токена/библиотеки/сеть) — наружу превращается в статус. */
export class TinkoffUnavailable extends Error {
  constructor(status, reason) {
    super(reason);
    this.name = 'TinkoffUnavailable';
    this.status = status;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Разбор ответов API (работает и с объектами SDK, и со словарями REST)
// ---------------------------------------------------------------------------
/**
 * Поле из объекта (REST: camelCase или snake_case) по списку имён.
 *
 * Имена перебираются по порядку — один и тот же код читает ответы gRPC-gateway
 * (`totalPortfolioValue`) и объекты SDK (`total_portfolio_value`).
 * Возвращается первое значение, отличное от null/undefined (0 и '' — значения).
 */
export function field(source, names, defaultValue = null) {
  if (source === null || source === undefined) return defaultValue;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (source !== null && source !== undefined) {
      const value = source[name];
      if (value !== undefined && value !== null) return value;
    }
  }
  return defaultValue;
}

/** number из числа или строки («100» — так int64 приходит в proto3-JSON). */
export function safeFloat(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Quotation/MoneyValue (объект SDK или dict REST) → number (units + nano / 1e9).
 *
 * Отрицательные значения приходят как units < 0 и nano < 0, поэтому обычная
 * сумма работает: -1 + (-500 000 000 / 1e9) = -1.5.
 */
export function quotationToFloat(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return safeFloat(value);
  const units = field(value, 'units');
  const nano = field(value, 'nano');
  if (units === null && nano === null) return null;
  return (safeFloat(units) ?? 0.0) + (safeFloat(nano) ?? 0.0) / 1_000_000_000;
}

/** 100.0 → «100», 12.5 → «12.5». */
export function formatQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** 45 230 ₽ — разряды через пробел. */
export function formatMoney(value, currency = 'RUB') {
  const number = value === null || value === undefined ? null : safeFloat(value);
  if (number === null) return '—';
  const sign = MONEY_SIGNS[String(currency).toLowerCase()] || '';
  const text = Math.round(number).toLocaleString('en-US').replace(/,/g, ' ');
  return sign ? `${text} ${sign}` : text;
}

/** Открытая позиция в портфеле. */
export class Position {
  constructor({
    figi = '',
    ticker = '',
    name = '',
    instrumentType = '',
    /** синоним для чтения из кэша Python-бота (snake_case) */
    instrument_type: instrumentTypeSnake = undefined,
    quantity = 0.0,
    averagePrice = null,
    average_price: averagePriceSnake = undefined,
    currentPrice = null,
    current_price: currentPriceSnake = undefined,
    currency = 'rub',
  } = {}) {
    this.figi = String(figi || '');
    this.ticker = String(ticker || '');
    this.name = String(name || '');
    this.instrumentType = String(instrumentTypeSnake ?? instrumentType ?? '');
    this.quantity = safeFloat(quantity) ?? 0.0;
    this.averagePrice = quotationToFloat(averagePriceSnake ?? averagePrice);
    this.currentPrice = quotationToFloat(currentPriceSnake ?? currentPrice);
    this.currency = String(currency || 'rub').toLowerCase();
  }

  /** Изменение позиции в процентах от средней цены. */
  get pnlPct() {
    if (!this.averagePrice || this.currentPrice === null) return null;
    return ((this.currentPrice - this.averagePrice) / this.averagePrice) * 100;
  }

  /** Текущая стоимость позиции. */
  get value() {
    if (this.currentPrice === null) return null;
    return this.currentPrice * this.quantity;
  }

  /** Человекочитаемый тип инструмента. */
  get typeTitle() {
    return INSTRUMENT_TYPE_TITLES[this.instrumentType] || this.instrumentType || 'инструмент';
  }

  /**
   * Строка для блока «Мои открытые позиции» в промпте DeepSeek.
   *
   * Формат как в ТЗ: «SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)».
   */
  asPromptLine() {
    let line = `${this.ticker}: ${formatQuantity(this.quantity)} шт`;
    if (this.averagePrice !== null) line += `, средняя ${this.averagePrice.toFixed(2)} ₽`;
    if (this.currentPrice !== null) line += `, текущая ${this.currentPrice.toFixed(2)} ₽`;
    const pnl = this.pnlPct;
    if (pnl !== null) line += ` (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)`;
    return line;
  }

  /** Строка для команды /portfolio. */
  asTelegramLine() {
    let line = `• <b>${this.ticker}</b> — ${formatQuantity(this.quantity)} шт`;
    if (this.averagePrice !== null) line += `, средняя ${this.averagePrice.toFixed(2)} ₽`;
    if (this.currentPrice !== null) line += ` → ${this.currentPrice.toFixed(2)} ₽`;
    const pnl = this.pnlPct;
    if (pnl !== null) line += ` (${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)`;
    return line;
  }

  /** Словарь для таблицы cache — ключи как в asdict(Position) Python-версии. */
  toCacheDict() {
    return {
      figi: this.figi,
      ticker: this.ticker,
      name: this.name,
      instrument_type: this.instrumentType,
      quantity: this.quantity,
      average_price: this.averagePrice,
      current_price: this.currentPrice,
      currency: this.currency,
    };
  }
}

/** «1 позиция / 2 позиции / 5 позиций». */
export function pluralPositions(count) {
  if ([11, 12, 13, 14].includes(count % 100)) return 'позиций';
  const tail = count % 10;
  if (tail === 1) return 'позиция';
  if ([2, 3, 4].includes(tail)) return 'позиции';
  return 'позиций';
}

/** Снимок портфеля: позиции + статус. Исключения не бросает никогда. */
export class PortfolioSnapshot {
  constructor({ positions = [], totalValue = null, accountId = null, status = STATUS_NO_TOKEN, error = null } = {}) {
    this.positions = Array.isArray(positions) ? positions : [];
    this.totalValue = totalValue === null || totalValue === undefined ? null : safeFloat(totalValue);
    this.accountId = accountId ? String(accountId) : null;
    this.status = status;
    this.error = error;
  }

  get ok() {
    return this.status === STATUS_OK;
  }

  /** Строка статуса для сообщения анализа (формат из Части 4/5). */
  statusText() {
    if (this.status === STATUS_OK) {
      const count = this.positions.length;
      return `💼 Tinkoff: ok | ${count} ${pluralPositions(count)}, ${formatMoney(this.totalValue)}`;
    }
    if (this.status === STATUS_NO_TOKEN) {
      return '💼 Tinkoff: ⏭️ не настроен — TINKOFF_INVEST_TOKEN не задан';
    }
    if (this.status === STATUS_LIBRARY_MISSING) {
      return (
        '💼 Tinkoff: ⏭️ SDK не установлен — он нужен только для ' +
        'TINKOFF_TRANSPORT=sdk (по умолчанию работает REST)'
      );
    }
    if (this.status === STATUS_TOKEN_EXPIRED) {
      return '💼 Tinkoff: ❌ токен истёк, обновите TINKOFF_INVEST_TOKEN';
    }
    if (this.status === STATUS_TIMEOUT) {
      return '💼 Tinkoff: ❌ timeout — прогноз без учёта позиций';
    }
    if (this.status === STATUS_RATE_LIMITED) {
      return '💼 Tinkoff: ⏳ лимит запросов к API (429) — прогноз без учёта позиций';
    }
    return `💼 Tinkoff: ❌ ошибка — ${this.error || 'неизвестная'} — прогноз без учёта позиций`;
  }

  /** Блок «Мои открытые позиции» для промпта. Пусто, если позиций нет. */
  promptText() {
    if (!this.ok || this.positions.length === 0) return '';
    const lines = ['Мои открытые позиции:'];
    for (const position of this.positions) lines.push(`- ${position.asPromptLine()}`);
    if (this.totalValue !== null) {
      lines.push('');
      lines.push(`Общая стоимость портфеля: ${formatMoney(this.totalValue)}`);
    }
    return lines.join('\n');
  }

  /** JSON для таблицы cache (ключи как в Python-версии). */
  asCachePayload() {
    return {
      positions: this.positions.map((position) => position.toCacheDict()),
      total_value: this.totalValue,
      account_id: this.accountId,
    };
  }

  /** Восстанавливает снимок из кэша SQLite (null, если данные битые). */
  static fromCachePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const positions = [];
    for (const item of payload.positions || []) {
      if (!item || typeof item !== 'object') continue;
      try {
        positions.push(new Position(item));
      } catch (exc) {
        logger.warning('Tinkoff: некорректная запись в кэше позиций, пропускаем (%s)', exc.message);
      }
    }
    const totalValue = safeFloat(payload.total_value ?? payload.totalValue);
    const accountId = payload.account_id ?? payload.accountId;
    return new PortfolioSnapshot({
      positions,
      totalValue,
      accountId: accountId ? String(accountId) : null,
      status: STATUS_OK,
    });
  }
}

// ---------------------------------------------------------------------------
// Счета
// ---------------------------------------------------------------------------
/** Счёт клиента (UsersService/GetAccounts). */
export class AccountInfo {
  constructor({ id = '', type = '', name = '', status = '', accessLevel = '' } = {}) {
    this.id = String(id || '');
    this.type = String(type || '');
    this.name = String(name || '');
    this.status = String(status || '');
    this.accessLevel = String(accessLevel || '');
  }
}

/** Ответ API → AccountInfo (null, если в записи нет идентификатора). */
export function parseAccount(raw) {
  const accountId = String(field(raw, 'id', '') || '');
  if (!accountId) return null;
  return new AccountInfo({
    id: accountId,
    type: field(raw, 'type', '') || '',
    name: field(raw, 'name', '') || '',
    status: field(raw, 'status', '') || '',
    accessLevel: field(raw, ['accessLevel', 'access_level'], '') || '',
  });
}

/** Аккаунт для портфеля: TINKOFF_ACCOUNT_ID → первый брокерский → первый открытый (Часть 4). */
export function pickAccount(accounts, preferred = null) {
  if (!accounts || accounts.length === 0) {
    throw new TinkoffUnavailable(STATUS_ERROR, 'нет доступных счетов');
  }

  if (preferred) {
    for (const account of accounts) {
      if (account.id === String(preferred)) return account;
    }
    logger.warning('Tinkoff: TINKOFF_ACCOUNT_ID=%s не найден — берём первый брокерский', preferred);
  }

  const opened = accounts.filter((account) => account.status.toUpperCase().includes('OPEN'));
  const candidates = opened.length ? opened : accounts;
  // Тип «TINKOFF» — в новых версиях API/SDK, FULL access — в старых
  for (const account of candidates) {
    if (account.type.toUpperCase() === 'ACCOUNT_TYPE_TINKOFF') return account;
  }
  for (const account of candidates) {
    if (account.type.toUpperCase().includes('TINKOFF')) return account;
  }
  for (const account of candidates) {
    if (account.accessLevel.toUpperCase().includes('FULL')) return account;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Транспорт 1 (по умолчанию): REST T-Invest API — глобальный fetch, без библиотек
// ---------------------------------------------------------------------------
/**
 * REST T-Invest API (gRPC-gateway) поверх fetch.
 *
 * Эндпоинты `POST {host}/rest/tinkoff.public.invest.api.contract.v1.<Service>/<Method>`
 * живы на обоих контурах (invest-public-api.tbank.ru и invest-public-api.tinkoff.ru):
 * на неверный токен отвечают `401 {"code":16,"description":"40003"}`.
 * Ответы — proto3-JSON: int64 (`units`) приходят строками, имена полей camelCase,
 * на вход принимаются и snake_case.
 */
export class RestTransport {
  constructor(token, baseUrls = null, { fetchImpl } = {}) {
    this.name = 'rest';
    this._token = token;
    const urls = typeof baseUrls === 'string' ? [baseUrls] : baseUrls || config.TINKOFF_API_BASE_URLS;
    this._baseUrls = (urls || [])
      .filter((url) => url)
      .map((url) => String(url).replace(/\/+$/, ''));
    this._fetchImpl = fetchImpl;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': config.HTTP_USER_AGENT,
    };
  }

  /** У REST-транспорта нет отдельного соединения — нужен только fetch. */
  async open() {
    return this;
  }

  /** POST read-only метода: таймаут, повторы, переключение на резервный хост. */
  async _call(service, method, payload) {
    const attempts = config.TINKOFF_RETRIES + 1;
    let lastStatus = STATUS_ERROR;
    let lastReason = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      for (const base of [...this._baseUrls]) {
        const url = `${base}${REST_API_PREFIX}${service}/${method}`;
        let response;
        try {
          response = await requestOnce(url, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(payload),
            timeoutMs: config.TINKOFF_TIMEOUT_SEC * 1000,
            fetchImpl: this._fetchImpl,
          });
        } catch (exc) {
          if (exc instanceof FetchError && exc.reason === 'timeout') {
            lastStatus = STATUS_TIMEOUT;
            lastReason = `timeout: ${exc.message}`;
            logger.warning('Tinkoff REST: %s — %s', method, lastReason);
            continue;
          }
          lastStatus = STATUS_ERROR;
          lastReason = `${base}: ${exc.message}`;
          logger.warning('Tinkoff REST: хост %s недоступен (%s) — пробую резервный', base, exc.message);
          this._demote(base);
          continue;
        }

        const text = await responseText(response);
        const body = this._parseJson(text);

        if (response.status === 200) {
          return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        }

        const error = this._httpError(response.status, body, text);
        if (!RETRYABLE_HTTP_CODES.has(response.status)) {
          throw error; // 400/401/403/404 — повторять бессмысленно
        }
        // Последняя ошибка запоминается вместе со статусом: после исчерпания
        // повторов наружу уходит именно она (429 → rate_limited, 5xx → error)
        lastStatus = error.status;
        lastReason = error.reason;
        logger.warning('Tinkoff REST: %s — HTTP %s: %s', method, response.status, error.reason);
      }

      if (attempt < attempts) {
        logger.warning(
          'Tinkoff REST: попытка %s/%s неудачна (%s), повтор через %s сек',
          attempt,
          attempts,
          lastReason,
          config.TINKOFF_RETRY_DELAY_SEC,
        );
        await delay(config.TINKOFF_RETRY_DELAY_SEC * 1000);
      }
    }

    throw new TinkoffUnavailable(lastStatus, lastReason || 'неизвестная ошибка REST API');
  }

  /** Тело ответа → объект (некорректный JSON превращается в понятный статус). */
  _parseJson(text) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (exc) {
      throw new TinkoffUnavailable(STATUS_ERROR, `некорректный JSON от API: ${exc.message}`);
    }
  }

  /** HTTP-ошибка REST → статус: 401/403/40003 — токен, 429 — лимит, 5xx — сбой сервиса. */
  _httpError(status, body, text) {
    let description = '';
    let message = '';
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      description = String(body.description ?? body.code ?? '');
      message = String(body.message ?? '');
    }
    if (!message) message = String(text ?? '').slice(0, 200);

    const lowered = message.toLowerCase();
    if (status === 429 || lowered.includes('resource_exhausted')) {
      return new TinkoffUnavailable(STATUS_RATE_LIMITED, 'слишком много запросов к API (429)');
    }
    if (description === TOKEN_EXPIRED_CODE || message === TOKEN_EXPIRED_CODE || lowered.includes('token is not active')) {
      return new TinkoffUnavailable(STATUS_TOKEN_EXPIRED, 'токен истёк (40003)');
    }
    if (status === 401 || status === 403) {
      return new TinkoffUnavailable(STATUS_TOKEN_EXPIRED, `токен не принят: ${message || status}`);
    }
    if (status >= 500) {
      return new TinkoffUnavailable(STATUS_ERROR, `HTTP ${status} — сервис недоступен`);
    }
    return new TinkoffUnavailable(STATUS_ERROR, `HTTP ${status}: ${message || description || 'ошибка API'}`);
  }

  /** Сбойный хост — в конец списка, чтобы следующий запрос ушёл на резервный. */
  _demote(base) {
    const index = this._baseUrls.indexOf(base);
    if (index >= 0 && this._baseUrls.length > 1) {
      this._baseUrls.splice(index, 1);
      this._baseUrls.push(base);
    }
  }

  // --------------------------------------------------------------- read-only
  /** UsersService/GetAccounts — список счетов клиента. */
  async accounts() {
    const response = await this._call(REST_USERS_SERVICE, 'GetAccounts', {});
    return [...(field(response, 'accounts', []) || [])];
  }

  /** OperationsService/GetPortfolio — позиции по счёту в рублях. */
  async portfolio(accountId) {
    return this._call(REST_OPERATIONS_SERVICE, 'GetPortfolio', { accountId, currency: 'RUB' });
  }

  /** InstrumentsService/GetInstrumentBy — тикер и название по FIGI/UID. */
  async instrument({ figi, uid }) {
    const response = await this._call(REST_INSTRUMENTS_SERVICE, 'GetInstrumentBy', {
      idType: figi ? REST_ID_TYPE_FIGI : REST_ID_TYPE_UID,
      id: figi || uid,
    });
    return field(response, 'instrument', {}) || {};
  }

  /** У REST-транспорта нет своего соединения — закрывать нечего. */
  close() {}
}

// ---------------------------------------------------------------------------
// Транспорт 2 (опция): gRPC-SDK, если он установлен вручную (npm i tinkoff-investments)
// ---------------------------------------------------------------------------
/**
 * Опциональный транспорт через сторонний SDK.
 *
 * В Python-версии это пакет `tinkoff-investments` (удалён с PyPI). В Node-версии
 * аналога в зависимостях нет, поэтому режим TINKOFF_TRANSPORT=sdk нужен тем, у
 * кого такой пакет установлен отдельно: если он не найден — статус library_missing,
 * бот продолжает работать без блока «По вашим позициям».
 */
export class SdkTransport {
  constructor(token) {
    this.name = 'sdk';
    this._token = token;
    this._sdk = null;
  }

  /** Ленивая загрузка SDK (пакета в зависимостях проекта нет — ищем в node_modules). */
  async _loadSdk() {
    try {
      return await import('tinkoff-investments');
    } catch (exc) {
      throw new TinkoffUnavailable(
        STATUS_LIBRARY_MISSING,
        `нет библиотеки tinkoff-investments (${exc.message})`,
      );
    }
  }

  async open() {
    this._sdk = await this._loadSdk();
    return this;
  }

  /** Открытый SDK-клиент (иначе — понятный статус вместо TypeError). */
  _api() {
    if (this._sdk === null) {
      throw new TinkoffUnavailable(STATUS_ERROR, 'SDK-клиент не инициализирован');
    }
    return this._sdk;
  }

  /** Вызов метода SDK с таймаутом и повторами (config.TINKOFF_RETRIES + 1 попыток). */
  async _call(method, ...args) {
    const attempts = config.TINKOFF_RETRIES + 1;
    let lastExc = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = method(...args);
        return result && typeof result.then === 'function' ? await result : result;
      } catch (exc) {
        lastExc = exc;
      }

      if (attempt < attempts) {
        logger.warning(
          'Tinkoff: попытка %s/%s неудачна (%s), повтор через %s сек',
          attempt,
          attempts,
          lastExc && lastExc.message ? lastExc.message : lastExc,
          config.TINKOFF_RETRY_DELAY_SEC,
        );
        await delay(config.TINKOFF_RETRY_DELAY_SEC * 1000);
      }
    }

    throw classifyError(lastExc);
  }

  // --------------------------------------------------------------- read-only
  /** Счета клиента. */
  async accounts() {
    const api = this._api();
    const response = await this._call((options) => api.users.getAccounts(options), {
      timeout: config.TINKOFF_TIMEOUT_SEC,
    });
    return [...(field(response, ['accounts'], []) || [])];
  }

  /** Позиции по счёту. */
  async portfolio(accountId) {
    const api = this._api();
    return this._call((options) => api.operations.getPortfolio(options), {
      accountId,
      timeout: config.TINKOFF_TIMEOUT_SEC,
    });
  }

  /** Инструмент по FIGI/UID. */
  async instrument({ figi, uid }) {
    const api = this._api();
    const idType = figi ? REST_ID_TYPE_FIGI : REST_ID_TYPE_UID;
    const response = await this._call((options) => api.instruments.getInstrumentBy(options), {
      idType,
      id: figi || uid,
      timeout: config.TINKOFF_TIMEOUT_SEC,
    });
    return field(response, ['instrument'], null);
  }

  /** Закрывает gRPC-канал SDK. */
  close() {
    const sdk = this._sdk;
    this._sdk = null;
    if (sdk && typeof sdk.close === 'function') {
      try {
        sdk.close();
      } catch (exc) {
        logger.debug('Tinkoff SDK: ошибка при закрытии клиента (%s)', exc.message);
      }
    }
  }
}

/** Исключение SDK/сети → статус для Telegram и лога. */
export function classifyError(exc) {
  const text = String((exc && exc.message) || exc || '');
  const code = String((exc && exc.code) || '');
  const lowered = text.toLowerCase();
  if (
    text.includes(TOKEN_EXPIRED_CODE) ||
    code.includes(TOKEN_EXPIRED_CODE) ||
    lowered.includes('token is not active')
  ) {
    return new TinkoffUnavailable(STATUS_TOKEN_EXPIRED, 'токен истёк (40003)');
  }
  if (lowered.includes('timeout') || lowered.includes('deadline') || lowered.includes('timed out')) {
    return new TinkoffUnavailable(STATUS_TIMEOUT, 'timeout');
  }
  if (lowered.includes('unauthenticated') || lowered.includes('permission denied')) {
    return new TinkoffUnavailable(STATUS_TOKEN_EXPIRED, text || 'токен не принят');
  }
  if (lowered.includes('resource exhausted')) {
    return new TinkoffUnavailable(STATUS_RATE_LIMITED, 'слишком много запросов к API');
  }
  return new TinkoffUnavailable(STATUS_ERROR, text || (exc && exc.name) || 'неизвестная ошибка');
}

// ---------------------------------------------------------------------------
// Клиент: транспорт + кэш в SQLite + статусы
// ---------------------------------------------------------------------------
/** Транспорт по config.TINKOFF_TRANSPORT: rest (по умолчанию) или sdk. */
export function buildTransport(token) {
  const mode = String(config.TINKOFF_TRANSPORT || 'rest').trim().toLowerCase();
  if (mode === 'sdk') return new SdkTransport(token);
  if (mode !== 'rest') {
    logger.info('Tinkoff: неизвестное значение TINKOFF_TRANSPORT=%s — использую REST', mode);
  }
  return new RestTransport(token);
}

/** Read-only клиент Tinkoff Invest с кэшем позиций и маппинга FIGI→тикер в SQLite. */
export class TinkoffPortfolioClient {
  constructor(token = undefined, transport = null) {
    this._token = token === undefined ? config.TINKOFF_INVEST_TOKEN : token;
    this._transport = transport;
  }

  get token() {
    return this._token;
  }

  /** Транспорт API (создаётся лениво); имя транспорта идёт в лог. */
  get transport() {
    if (this._transport === null || this._transport === undefined) {
      this._transport = buildTransport(this._token || '');
    }
    return this._transport;
  }

  // ------------------------------------------------------------ портфель
  /** Снимок портфеля. Никогда не бросает исключений — только статус. */
  async getPortfolioSnapshot({ force = false } = {}) {
    if (!this._token) {
      logger.warning('Tinkoff: TINKOFF_INVEST_TOKEN не задан — работаем без позиций');
      return new PortfolioSnapshot({ status: STATUS_NO_TOKEN });
    }

    if (!force) {
      const cached = this._cachedPortfolio();
      if (cached !== null) return cached;
    }

    let snapshot;
    try {
      snapshot = await this._fetchPortfolio();
    } catch (exc) {
      if (exc instanceof TinkoffUnavailable) {
        logger.warning('Tinkoff: %s (%s) — прогноз без учёта позиций', exc.status, exc.reason);
        return new PortfolioSnapshot({ status: exc.status, error: exc.reason });
      }
      throw exc;
    }

    this._saveCache(snapshot);
    return snapshot;
  }

  /** Позиции из кэша SQLite, если запись свежее config.TINKOFF_POSITIONS_CACHE_TTL_SEC. */
  _cachedPortfolio() {
    let payload;
    try {
      payload = db.cacheGet(CACHE_KEY_PORTFOLIO, config.TINKOFF_POSITIONS_CACHE_TTL_SEC);
    } catch (exc) {
      logger.warning('Tinkoff: кэш позиций недоступен (%s)', exc.message);
      return null;
    }
    const snapshot = PortfolioSnapshot.fromCachePayload(payload);
    if (snapshot === null) return null;
    logger.info('Tinkoff: позиции из кэша SQLite (%s шт)', snapshot.positions.length);
    return snapshot;
  }

  /** Кэширует успешный снимок позиций (TTL — 5 минут). */
  _saveCache(snapshot) {
    try {
      db.cacheSet(CACHE_KEY_PORTFOLIO, snapshot.asCachePayload());
    } catch (exc) {
      logger.warning('Tinkoff: не удалось закэшировать позиции (%s)', exc.message);
    }
  }

  /** Счета → портфель → (при необходимости) инструменты. Только read-only методы. */
  async _fetchPortfolio() {
    const transport = this.transport;
    const positions = [];
    let accountId = '';
    let totalValue = null;

    try {
      await transport.open();
      const parsed = (await transport.accounts()).map((raw) => parseAccount(raw));
      const account = pickAccount(
        parsed.filter((item) => item !== null),
        config.TINKOFF_ACCOUNT_ID,
      );
      accountId = account.id;
      const portfolio = await transport.portfolio(accountId);
      for (const raw of field(portfolio, 'positions', []) || []) {
        const position = await this._parsePosition(raw, transport);
        if (position !== null) positions.push(position);
      }
      totalValue = this._totalValue(portfolio, positions);
    } catch (exc) {
      if (exc instanceof TinkoffUnavailable) throw exc;
      throw classifyError(exc);
    } finally {
      transport.close();
    }

    logger.info(
      'Tinkoff: портфель получен (%s) — счет %s, позиций %s, стоимость %s',
      transport.name,
      accountId,
      positions.length,
      totalValue,
    );
    return new PortfolioSnapshot({ positions, totalValue, accountId, status: STATUS_OK });
  }

  /** Стоимость портфеля: totalPortfolioValue из API → сумма позиций. */
  _totalValue(portfolio, positions) {
    const apiTotal = quotationToFloat(
      field(portfolio, [
        'totalPortfolioValue',
        'total_portfolio_value',
        'totalAmountPortfolio',
        'total_amount_portfolio',
      ]),
    );
    if (apiTotal !== null) return apiTotal;
    const values = positions.map((position) => position.value).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }

  /** Позиция API → Position. Тикер берётся из позиции, иначе по FIGI/UID через API. */
  async _parsePosition(raw, transport) {
    const figi = String(field(raw, 'figi', '') || '');
    const instrumentUid = String(field(raw, ['instrumentUid', 'instrument_uid'], '') || '');
    if (!figi && !instrumentUid) {
      logger.warning('Tinkoff: позиция без FIGI и UID — пропущена');
      return null;
    }

    const instrumentType = String(field(raw, ['instrumentType', 'instrument_type'], '') || '');
    const quantity = quotationToFloat(field(raw, 'quantity')) ?? 0.0;
    if (quantity === 0) {
      logger.debug('Tinkoff: нулевая позиция %s — пропущена', figi || instrumentUid);
      return null;
    }

    let ticker = String(field(raw, 'ticker', '') || '');
    let name = String(field(raw, 'name', '') || '');
    if (ticker) {
      this._rememberInstrument(figi || instrumentUid, ticker, name);
    } else {
      [ticker, name] = await this._resolveTicker(transport, { figi, uid: instrumentUid });
    }
    if (!ticker) {
      logger.warning(
        'Tinkoff: тикер не определён (figi=%s, uid=%s, тип=%s) — позиция пропущена',
        figi || '—',
        instrumentUid || '—',
        instrumentType || '—',
      );
      return null;
    }

    const average = field(raw, ['averagePositionPrice', 'average_position_price']);
    const currency = String(field(average, 'currency', '') || 'rub').toLowerCase();

    return new Position({
      figi: figi || instrumentUid,
      ticker,
      name,
      instrumentType,
      quantity,
      averagePrice: quotationToFloat(average),
      currentPrice: quotationToFloat(field(raw, ['currentPrice', 'current_price'])),
      currency,
    });
  }

  /**
   * Тикер и название инструмента по FIGI/UID; маппинг кэшируется в SQLite.
   *
   * В ТЗ описан путь «PortfolioPosition → FIGI → тикер»: у REST-ответа тикер
   * чаще уже есть в позиции, но для старых версий/типов инструментов он
   * запрашивается отдельно и запоминается на TINKOFF_FIGI_CACHE_TTL_SEC.
   */
  async _resolveTicker(transport, { figi, uid }) {
    const key = figi || uid;
    if (!key) return ['', ''];
    const mapping = this._figiMap();
    const cached = mapping[key];
    if (cached && typeof cached === 'object' && cached.ticker) {
      return [String(cached.ticker), String(cached.name || '')];
    }

    const instrument = await transport.instrument({ figi, uid });
    const ticker = String(field(instrument, 'ticker', '') || '');
    const name = String(field(instrument, 'name', '') || '');
    if (!ticker) return ['', ''];
    this._rememberInstrument(key, ticker, name);
    return [ticker, name];
  }

  /** Сохраняет FIGI/UID → тикер в кэш SQLite (TTL — TINKOFF_FIGI_CACHE_TTL_SEC). */
  _rememberInstrument(key, ticker, name = '') {
    if (!key || !ticker) return;
    const mapping = this._figiMap();
    const current = mapping[key];
    if (current && typeof current === 'object' && current.ticker === ticker && current.name === name) {
      return;
    }
    mapping[key] = { ticker, name };
    try {
      db.cacheSet(CACHE_KEY_FIGI_MAP, mapping);
    } catch (exc) {
      logger.warning('Tinkoff: не удалось закэшировать FIGI→тикер (%s)', exc.message);
    }
  }

  /** Кэш FIGI→тикер из SQLite (пустой словарь, если кэша нет или он протух). */
  _figiMap() {
    let cached;
    try {
      cached = db.cacheGet(CACHE_KEY_FIGI_MAP, config.TINKOFF_FIGI_CACHE_TTL_SEC);
    } catch (exc) {
      logger.warning('Tinkoff: кэш FIGI недоступен (%s)', exc.message);
      return {};
    }
    return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
  }
}

// ---------------------------------------------------------------------------
// Публичный API модуля (то, что вызывают scheduler/jobs.js, bot/handlers.js)
// ---------------------------------------------------------------------------
let _client = null;

/** Единый клиент на процесс (пересоздаётся при смене токена в config). */
export function getClient() {
  if (_client === null || _client.token !== config.TINKOFF_INVEST_TOKEN) {
    _client = new TinkoffPortfolioClient();
  }
  return _client;
}

/** Сбрасывает закэшированный клиент (тесты, смена токена в .env). */
export function resetClient() {
  _client = null;
}

/** Снимок портфеля для планировщика и команды /portfolio. Исключений не бросает. */
export async function getPortfolioSnapshot(options = {}) {
  const force = typeof options === 'boolean' ? options : Boolean(options && options.force);
  return getClient().getPortfolioSnapshot({ force });
}

/** Имя из ТЗ — полный алиас getPortfolioSnapshot(). */
export async function getPortfolio() {
  return getPortfolioSnapshot();
}
