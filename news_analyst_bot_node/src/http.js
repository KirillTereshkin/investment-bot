/**
 * HTTP-слой: GET/POST с таймаутом, повторами и декодированием кодировок.
 *
 * Аналог requests + ручных retry-циклов из collector.py / quotes.py / tinkoff.py.
 * Использует глобальный fetch (Node 18+), лишних зависимостей нет.
 * fetchImpl можно подменить в тестах.
 */

import * as config from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger('http');

/** Ошибка сети/HTTP с причиной в том же виде, что в Python: timeout | http_500 | ... */
export class FetchError extends Error {
  constructor(reason, message = '') {
    super(message || reason);
    this.name = 'FetchError';
    this.reason = reason;
  }
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Один запрос без повторов. Бросает FetchError('timeout' | 'connection_error'). */
export async function requestOnce(url, { method = 'GET', headers, body, timeoutMs, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new FetchError('connection_error', 'fetch недоступен в этой версии Node.js');
  }
  try {
    return await doFetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (exc) {
    if (exc && (exc.name === 'TimeoutError' || exc.name === 'AbortError')) {
      throw new FetchError('timeout');
    }
    if (exc instanceof FetchError) throw exc;
    throw new FetchError('connection_error', exc && exc.message ? exc.message : String(exc));
  }
}

/**
 * Запрос с повторами. Возвращает готовый Response (успешный статус 2xx/3xx).
 * Бросает FetchError с причиной последней неудачи.
 */
export async function requestWithRetry(url, options = {}) {
  const {
    retries = config.MOEX_ISS_RETRIES,
    retryDelaySec = config.MOEX_ISS_RETRY_DELAY_SEC,
    timeoutSec = config.MOEX_ISS_TIMEOUT_SEC,
    label = url,
    logPrefix = '',
    ...rest
  } = options;

  const attempts = Math.max(1, Number(retries) + 1);
  let reason = 'unknown_error';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await requestOnce(url, { ...rest, timeoutMs: timeoutSec * 1000 });
      if (response.status >= 400) {
        reason = `http_${response.status}`;
      } else {
        return response;
      }
    } catch (exc) {
      reason = exc instanceof FetchError ? exc.reason : 'unknown_error';
      logger.debug('HTTP %s: попытка %s/%s — %s', label, attempt, attempts, exc.message);
    }
    if (attempt < attempts) {
      logger.debug(
        '%s%s: попытка %s/%s не удалась (%s), повтор через %s сек',
        logPrefix,
        label,
        attempt,
        attempts,
        reason,
        retryDelaySec,
      );
      await delay(retryDelaySec * 1000);
    }
  }

  throw new FetchError(reason);
}

/**
 * Декодирует тело ответа: UTF-8, при мусоре — windows-1251 (ЦБ РФ отдаёт cp1251).
 *
 * Кодировка ищется в заголовке Content-Type, затем в самом теле (XML-декларация
 * `<?xml ... encoding="..."?>` или `<meta charset=...>`), затем перебираются
 * utf-8 и windows-1251.
 */
export function decodeBuffer(buffer, contentType = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  const candidates = [];

  const declared = /charset=\s*"?([\w-]+)"?/i.exec(String(contentType));
  if (declared) candidates.push(declared[1].toLowerCase());

  const sniffed = sniffDeclaredEncoding(bytes);
  if (sniffed) candidates.push(sniffed);

  candidates.push('utf-8', 'windows-1251');

  const tried = new Set();
  for (const encoding of candidates) {
    if (tried.has(encoding)) continue;
    tried.add(encoding);
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      /* кодировка не поддерживается — пробуем следующую */
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Кодировка из пролога документа (латиница в первых байтах всегда читается). */
function sniffDeclaredEncoding(bytes) {
  const head = Buffer.from(bytes.slice(0, 2048)).toString('latin1');
  const xml = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  if (xml) return xml[1].toLowerCase();
  const meta = /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : null;
}

/** Тело ответа в виде байтов (нужно для XML с кодировками и для картинок). */
export async function responseBytes(response) {
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function responseText(response) {
  const buffer = await response.arrayBuffer();
  return decodeBuffer(buffer, response.headers.get('content-type') || '');
}

export async function responseJson(response) {
  const text = await responseText(response);
  return JSON.parse(text);
}

export async function httpGet(url, options = {}) {
  return requestWithRetry(url, { method: 'GET', ...options, body: undefined });
}

export async function httpPost(url, body, options = {}) {
  return requestWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  });
}

export function userAgentHeaders(extra = {}) {
  return {
    'User-Agent': config.HTTP_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    ...extra,
  };
}
