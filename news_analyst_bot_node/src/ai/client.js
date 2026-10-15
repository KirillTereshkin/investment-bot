/**
 * Клиент DeepSeek (OpenAI-совместимый API, порт ai/client.py).
 *
 * Особенности:
 * * вместо официального SDK — обычный fetch на {base_url}/chat/completions;
 * * собственный retry (config.DEEPSEEK_RETRIES повторов с задержкой config.DEEPSEEK_RETRY_DELAY_SEC);
 * * наружу никогда не бросает исключения — возвращает DeepSeekResult со статусом.
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';
import { FetchError, delay, requestOnce } from '../http.js';
import * as prompts from './prompts.js';

const logger = getLogger('ai.client');

/** Ошибка разбора JSON от модели (аналог json.JSONDecodeError + ValueError). */
export class JsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonError';
  }
}

/** Ошибка HTTP-ответа DeepSeek с короткой причиной (auth_error | rate_limit | http_500). */
export class DeepSeekApiError extends Error {
  constructor(reason, message = '') {
    super(message || reason);
    this.name = 'DeepSeekApiError';
    this.reason = reason;
  }
}

/** Результат вызова DeepSeek. */
export class DeepSeekResult {
  constructor({
    status,
    parsed = null,
    rawResponse = null,
    tokens = null,
    durationMs = null,
    error = null,
    attempts = 0,
    meta = null,
  }) {
    this.status = status; // "ok" | "error:<reason>"
    this.parsed = parsed;
    this.raw_response = rawResponse;
    this.tokens = tokens;
    this.duration_ms = durationMs;
    this.error = error; // короткая причина ошибки
    this.attempts = attempts;
    this.meta = meta || {};
  }

  get ok() {
    return this.status === 'ok';
  }
}

/** Достаёт JSON из ответа модели (в т.ч. если он обёрнут в ```json ... ```). */
export function extractJson(text) {
  if (!text) throw new JsonError('пустой ответ модели');
  let cleaned = String(text).trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^`+/, '').replace(/`+$/, '');
    if (cleaned.toLowerCase().startsWith('json')) cleaned = cleaned.slice(4);
    cleaned = cleaned.trim();
  }
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new JsonError('в ответе нет JSON-объекта');
    data = JSON.parse(cleaned.slice(start, end + 1));
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new JsonError('JSON верхнего уровня должен быть объектом');
  }
  return data;
}

/** Короткий машиночитаемый код ошибки для отчёта в Telegram и БД. */
export function describeError(exc) {
  if (exc instanceof FetchError) {
    if (exc.reason === 'timeout') return 'timeout';
    if (typeof exc.reason === 'string' && exc.reason.startsWith('http_')) return exc.reason;
    return 'connection_error';
  }
  if (exc instanceof DeepSeekApiError) return exc.reason;
  if (exc instanceof JsonError || exc instanceof SyntaxError) return 'invalid_json';
  return 'unknown_error';
}

/** Причина ошибки по HTTP-статусу ответа DeepSeek (как в исключениях SDK openai). */
function reasonByStatus(status) {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limit';
  return `http_${status}`;
}

/** Обёртка над HTTP API DeepSeek с ручным retry. */
export class DeepSeekClient {
  constructor({ fetchImpl = null, timeoutSec = null } = {}) {
    this._fetchImpl = fetchImpl;
    this._timeoutSec = timeoutSec === null ? config.DEEPSEEK_TIMEOUT_SEC : timeoutSec;
  }

  /** Закрывает клиента (у fetch-реализации закрывать нечего, метод — для совместимости). */
  async close() {
    this._fetchImpl = null;
  }

  /** Один запрос к API. Возвращает (текст ответа, токены, длительность мс). */
  async callApi(userPrompt) {
    const url = `${config.DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
    const started = Date.now();
    const response = await requestOnce(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: config.DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: prompts.SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: config.DEEPSEEK_TEMPERATURE,
        max_tokens: config.DEEPSEEK_MAX_TOKENS,
        response_format: { type: 'json_object' },
      }),
      timeoutMs: this._timeoutSec * 1000,
      fetchImpl: this._fetchImpl || undefined,
    });

    if (response.status >= 400) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        /* тело недоступно — не мешает обработке статуса */
      }
      throw new DeepSeekApiError(reasonByStatus(response.status), `HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (exc) {
      throw new JsonError(`ответ API не является JSON: ${exc.message}`);
    }
    const durationMs = Date.now() - started;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = choices.length ? choices[0].message?.content || '' : '';
    const tokens = payload.usage ? (payload.usage.total_tokens ?? null) : null;
    return { content, tokens, durationMs };
  }

  /**
   * Отправляет дайджест в DeepSeek и возвращает разобранный прогноз.
   *
   * cnyrub/eurrub — дополнительные курсы ЦБ (Часть 1), portfolioText — блок
   * открытых позиций Tinkoff (Часть 4). Оба параметра необязательные.
   */
  async analyze({
    digest,
    windowStart,
    windowEnd,
    keyRate,
    moexValue,
    moexChange,
    usdrub,
    cnyrub = null,
    eurrub = null,
    portfolioText = '',
  } = {}) {
    if (!config.DEEPSEEK_API_KEY) {
      logger.error('DEEPSEEK_API_KEY не задан — вызов DeepSeek невозможен');
      return new DeepSeekResult({ status: 'error:no_api_key', error: 'no_api_key' });
    }

    const userPrompt = prompts.buildUserPrompt({
      windowStart,
      windowEnd,
      digest,
      keyRate,
      moexValue,
      moexChange,
      usdrub,
      cnyrub,
      eurrub,
      portfolioText,
    });

    const attempts = config.DEEPSEEK_RETRIES + 1;
    let lastError = 'unknown_error';
    let lastDuration = null;
    let lastRaw = null;
    let tokens = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let raw = null;
      let lastCallOk = false;
      try {
        const outcome = await this.callApi(userPrompt);
        raw = outcome.content;
        tokens = outcome.tokens;
        lastDuration = outcome.durationMs;
        lastCallOk = true;
      } catch (exc) {
        lastError = describeError(exc);
        logger.warning('DeepSeek: попытка %s/%s — ошибка API (%s): %s', attempt, attempts, lastError, exc.message);
      }

      if (lastCallOk) {
        lastRaw = raw;
        try {
          const parsed = extractJson(raw);
          logger.info('DeepSeek: ok, попытка %s/%s, токенов %s, %s мс', attempt, attempts, tokens, lastDuration);
          return new DeepSeekResult({
            status: 'ok',
            parsed,
            rawResponse: raw,
            tokens,
            durationMs: lastDuration,
            attempts: attempt,
          });
        } catch (exc) {
          lastError = 'invalid_json';
          logger.warning('DeepSeek: попытка %s/%s — не удалось разобрать JSON (%s)', attempt, attempts, exc.message);
        }
      }

      if (attempt < attempts) {
        await delay(config.DEEPSEEK_RETRY_DELAY_SEC * 1000);
      }
    }

    logger.error('DeepSeek: все %s попыток неуспешны, последняя причина — %s', attempts, lastError);
    return new DeepSeekResult({
      status: `error:${lastError}`,
      error: lastError,
      rawResponse: lastRaw,
      tokens,
      durationMs: lastDuration,
      attempts,
    });
  }
}

/** Клиент по умолчанию (как DeepSeekClient() без аргументов в Python). */
export function createClient(options = {}) {
  return new DeepSeekClient(options);
}

