/**
 * Точка входа проекта: логирование, БД, бот, планировщик (порт main.py).
 *
 * Запуск: npm start
 *   node --experimental-sqlite --disable-warning=ExperimentalWarning main.js
 *
 * Отличия от Python-версии ровно два, оба вынужденные:
 *   * aiogram заменён на src/bot/telegram.js (long polling своими руками), поэтому
 *     dispatcher.start_polling(bot) превратился в startPolling();
 *   * SignalExit не существует — validate_config бросает ConfigError, а обработчик
 *     в конце файла печатает текст и завершает процесс с кодом 1.
 */

import { pathToFileURL } from 'node:url';

import * as config from './src/config.js';
import { configureLogging, getLogger } from './src/logger.js';
import * as notifier from './src/bot/notifier.js';
import { handleUpdate } from './src/bot/handlers.js';
import { createBot } from './src/bot/telegram.js';
import { nextRunTime, scheduleHuman, setupScheduler } from './src/scheduler/jobs.js';
import * as db from './src/storage/db.js';

const logger = getLogger('news_analyst_bot');

/** Пауза между неудачными запросами long polling (сек). */
export const POLL_BACKOFF_SEC = 5;
/** Таймаут long polling: в aiogram start_polling по умолчанию 10 секунд. */
export const POLLING_TIMEOUT_SEC = 10;
/** Лимит обновлений за один getUpdates (значение по умолчанию у Bot API). */
export const POLLING_LIMIT = 100;

/**
 * Аналог SystemExit с текстом (main.py: raise SystemExit(...) в validate_config).
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Логи уровня LOG_LEVEL в stdout и в файл bot.log (с ротацией 5 МБ × 3).
 *
 * Шумные логгеры сторонних библиотек гасить не нужно: aiogram, httpx, apscheduler
 * и openai в Node-версии отсутствуют, а fast-xml-parser и dotenv молчат.
 */
export function setupLogging() {
  configureLogging({
    level: config.LOG_LEVEL,
    file: config.LOG_PATH,
    maxFileBytes: config.LOG_MAX_BYTES,
    backups: config.LOG_BACKUPS,
    tz: config.TIMEZONE,
  });
}

/** Проверяем, что все секреты заполнены, иначе падаем с понятным текстом. */
export function validateConfig() {
  const required = {
    TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
    DEEPSEEK_API_KEY: config.DEEPSEEK_API_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(
      `Не заполнены переменные окружения: ${missing.join(', ')}.\n` +
        'Скопируйте .env.example в .env и заполните значения.',
    );
  }
}

/** Пауза (аналог asyncio.sleep). */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Long polling — аналог dispatcher.start_polling(bot).
 *
 * Цикл идёт, пока isStopped() возвращает false. Сбой сети не роняет бота: ошибка
 * пишется в лог, выжидаем POLL_BACKOFF_SEC и запрашиваем обновления снова (так же
 * ведёт себя aiogram — он продолжает polling после сетевых ошибок).
 *
 * Возвращает количество обработанных обновлений (нужно тестам).
 */
export async function startPolling(
  bot,
  { timeoutSec = POLLING_TIMEOUT_SEC, limit = POLLING_LIMIT, isStopped = () => false } = {},
) {
  let offset = null;
  let processed = 0;
  while (!isStopped()) {
    let updates;
    try {
      updates = await bot.getUpdates(offset, { timeoutSec, limit });
    } catch (exc) {
      logger.warning(
        'Long polling: обновления не получены (%s), повтор через %s сек',
        (exc && exc.message) || exc,
        POLL_BACKOFF_SEC,
      );
      await sleep(POLL_BACKOFF_SEC * 1000);
      continue;
    }
    for (const update of updates || []) {
      if (update && Number.isFinite(update.update_id)) offset = update.update_id + 1;
      await handleUpdate(bot, update);
      processed += 1;
    }
  }
  return processed;
}

/**
 * Полный запуск приложения.
 *
 * poll=false — подготовка без ухода в long polling (бота и планировщик поднимаем,
 * возвращаем ручку остановки): так тест проверяет старт, не занимая процесс.
 */
export async function main({ bot = null, poll = true } = {}) {
  setupLogging();
  validateConfig();
  db.initDb();

  const instance = bot || createBot();

  const scheduler = setupScheduler(instance);
  scheduler.start();

  const upcoming = nextRunTime();
  logger.info(
    'Расписание: %s МСК. Следующий анализ в %s МСК',
    scheduleHuman(),
    config.formatHhmm(upcoming),
  );
  const me = await instance.getMe(); // проверяем токен и получаем профиль бота до старта
  logger.info('Профиль бота: @%s (id=%s)', (me && me.username) || '?', (me && me.id) || '?');

  // Уведомление о запуске: в лог и в Telegram
  await notifier.sendMessage(instance, notifier.formatStartupMessage());

  let stopped = false;
  const stop = async (reason = 'shutdown') => {
    if (stopped) return;
    stopped = true;
    scheduler.shutdown();
    await instance.close();
    db.closeDb();
    logger.info('Бот остановлен (%s)', reason);
  };

  if (!poll) return { bot: instance, scheduler, stop };

  const onSignal = (signal) => {
    logger.info('Остановка по %s', signal === 'SIGINT' ? 'Ctrl+C' : signal);
    void stop(signal).then(() => {
      // Ctrl+C должен срабатывать сразу: long polling может «висеть» до таймаута
      const timer = setTimeout(() => process.exit(0), 2_000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await startPolling(instance, { isStopped: () => stopped });
  } finally {
    await stop('polling_end');
  }
  return { bot: instance, scheduler, stop };
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((exc) => {
      if (exc instanceof ConfigError) {
        // аналог SystemExit с текстом: сообщение в stderr и код возврата 1
        logger.info('Запуск прерван: %s', exc.message);
        process.stderr.write(`${exc.message}\n`);
        process.exitCode = 1;
        return;
      }
      logger.exception('Фатальная ошибка: %s', exc);
      process.exitCode = 1;
    });
}
