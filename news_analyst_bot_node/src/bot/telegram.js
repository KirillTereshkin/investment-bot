/**
 * Минимальный клиент Telegram Bot API — замена aiogram Bot из Python-версии.
 *
 * Реализованы только нужные боту методы: getMe, sendMessage (HTML) и getUpdates
 * для long polling. Иерархия ошибок повторяет aiogram:
 *
 *   TelegramBadRequest <: TelegramApiError <: TelegramError
 *   TelegramNetworkError <: TelegramApiError   (в aiogram он тоже подкласс APIError)
 *
 * Поэтому notifier.send_message ловит TelegramBadRequest (повтор без разметки)
 * и TelegramAPIError (запись в лог) точно так же, как в Python.
 */

import * as config from '../config.js';
import { getLogger } from '../logger.js';

const logger = getLogger('bot.telegram');

export const API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_SEC = 30;
/** Запас над timeout long polling: сервер держит запрос timeout секунд. */
const POLL_TIMEOUT_MARGIN_SEC = 15;

export class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

export class TelegramApiError extends TelegramError {
  constructor(method, message, { errorCode = null, description = '', retryAfter = null } = {}) {
    super(`Telegram ${method}: ${message}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.error_code = errorCode;
    this.description = description;
    this.retry_after = retryAfter;
  }
}

/** HTTP 400 от Bot API (частая причина — невалидная HTML-разметка). */
export class TelegramBadRequest extends TelegramApiError {
  constructor(method, message, options = {}) {
    super(method, message, options);
    this.name = 'TelegramBadRequest';
  }
}

/** Сетевой сбой или таймаут (аналог aiogram.TelegramNetworkError). */
export class TelegramNetworkError extends TelegramApiError {
  constructor(method, message) {
    super(method, message);
    this.name = 'TelegramNetworkError';
  }
}

export class TelegramBot {
  constructor(token = null, { apiBase = API_BASE, timeoutSec = DEFAULT_TIMEOUT_SEC, fetchImpl = null } = {}) {
    this.token = token || config.TELEGRAM_BOT_TOKEN || '';
    this.apiBase = String(apiBase).replace(/\/+$/, '');
    this.timeoutSec = Number(timeoutSec) || DEFAULT_TIMEOUT_SEC;
    this.fetchImpl = fetchImpl;
  }

  get url() {
    return `${this.apiBase}/bot${this.token}`;
  }

  /** Вызов метода Bot API. Бросает подклассы TelegramApiError. */
  async callMethod(method, payload = {}, { timeoutSec = null } = {}) {
    if (!this.token) {
      throw new TelegramApiError(method, 'TELEGRAM_BOT_TOKEN не задан');
    }
    const doFetch = this.fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new TelegramNetworkError(method, 'fetch недоступен в этой версии Node.js');
    }

    const seconds = Number(timeoutSec) || this.timeoutSec;
    let response;
    try {
      response = await doFetch(`${this.url}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(seconds * 1000),
      });
    } catch (exc) {
      const reason =
        exc && (exc.name === 'TimeoutError' || exc.name === 'AbortError')
          ? 'timeout'
          : (exc && exc.message) || String(exc);
      logger.debug('Telegram %s: запрос не выполнен (%s)', method, reason);
      throw new TelegramNetworkError(method, reason);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (data && data.ok) return data.result;

    const description = (data && data.description) || `HTTP ${response.status}`;
    const errorCode = (data && data.error_code) || response.status;
    const retryAfter = (data && data.parameters && data.parameters.retry_after) || null;
    const options = { errorCode, description, retryAfter };
    if (errorCode === 400) throw new TelegramBadRequest(method, description, options);
    throw new TelegramApiError(method, description, options);
  }

  /**
   * Профиль бота — заодно проверка токена при старте (main.py: await bot.get_me()).
   *
   * Как aiogram, запоминаем username: handlers.addressedToAnotherBot сверяет с ним
   * упоминание «/now@news_analyst_bot».
   */
  async getMe() {
    const me = await this.callMethod('getMe');
    this.profile = me;
    if (me && me.username) this.username = String(me.username);
    return me;
  }

  /**
   * Отправка сообщения в чат.
   *
   * parseMode по умолчанию null — как в aiogram, где Bot.send_message без
   * parse_mode отправляет плоский текст: разметку включает явно только
   * notifier.sendMessage ('HTML'), а повтор после TelegramBadRequest — нет.
   */
  async sendMessage(chatId, text, { parseMode = null, disableWebPagePreview = true } = {}) {
    const payload = { chat_id: chatId, text };
    if (parseMode) payload.parse_mode = parseMode;
    if (disableWebPagePreview) payload.disable_web_page_preview = true;
    return this.callMethod('sendMessage', payload);
  }

  /** Long polling: ждём обновления timeoutSec секунд, возвращаем список updates. */
  async getUpdates(offset = null, { timeoutSec = 25, allowedUpdates = null, limit = null } = {}) {
    const payload = { timeout: timeoutSec };
    if (offset !== null && offset !== undefined) payload.offset = offset;
    if (limit !== null && limit !== undefined) payload.limit = limit;
    if (allowedUpdates) payload.allowed_updates = allowedUpdates;
    return this.callMethod('getUpdates', payload, { timeoutSec: timeoutSec + POLL_TIMEOUT_MARGIN_SEC });
  }

  /** Закрытие сессии: в Node соединения держит fetch, закрывать нечего. */
  async close() {
    /* симметрия с aiogram Bot.session.close() */
  }
}

/** Бот из переменных окружения (как Bot(token=config.TELEGRAM_BOT_TOKEN)). */
export function createBot(options = {}) {
  return new TelegramBot(options.token || config.TELEGRAM_BOT_TOKEN, options);
}
