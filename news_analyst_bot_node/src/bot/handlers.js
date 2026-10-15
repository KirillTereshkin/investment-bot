/**
 * Хендлеры Telegram-команд (порт bot/handlers.py):
 * /start, /now, /last, /stats, /accuracy, /portfolio, /schedule, /help.
 *
 * В Python-версии это Router aiogram с фильтрами Command/CommandStart. Здесь
 * команда разбирается вручную (parseCommand), а отправка идёт через
 * notifier.sendMessage — как message.answer с parse_mode=HTML.
 */

import { getLogger } from '../logger.js';
import * as db from '../storage/db.js';
import * as jobs from '../scheduler/jobs.js';
import * as notifier from './notifier.js';

const logger = getLogger('bot.handlers');

export const HELP_TEXT = [
  '<b>Команды:</b>',
  '/start — приветствие и текущее расписание',
  '/now — запустить анализ немедленно, вне расписания',
  '/last — последний прогноз из базы',
  '/stats — статистика за 7 дней',
  '/accuracy — точность прогнозов за 30 дней',
  '/portfolio — текущие позиции Tinkoff (только чтение)',
  '/schedule — расписание и время следующего запуска',
  '/help — этот список',
].join('\n');

/** Команды, которые умеет бот (порядок как в HELP_TEXT). */
export const COMMANDS = ['start', 'now', 'last', 'stats', 'accuracy', 'portfolio', 'schedule', 'help'];

/**
 * Разбирает текст сообщения как команду.
 *
 * Возвращает {command, mention, args} или null, если текст не начинается с «/»:
 * «/now», «/now@news_analyst_bot», «/Now аргумент» (aiogram сверяет имя без учёта регистра).
 */
export function parseCommand(text) {
  const trimmed = String(text === null || text === undefined ? '' : text).trim();
  if (!trimmed.startsWith('/')) return null;
  const first = trimmed.split(/\s+/)[0];
  const withoutSlash = first.slice(1);
  if (!withoutSlash) return null;
  const [rawName, mention] = withoutSlash.split('@');
  return {
    command: rawName.toLowerCase(),
    mention: mention ? mention.toLowerCase() : null,
    args: trimmed.slice(first.length).trim(),
  };
}

/** Команда адресована другому боту? (aiogram: Command(ignore_mention=False)). */
function addressedToAnotherBot(bot, mention) {
  if (!mention) return false;
  const username = bot && bot.username ? String(bot.username).toLowerCase() : null;
  if (!username) return false;
  return mention !== username;
}

/** Приветствие + текущее расписание (/start). */
export async function cmdStart(bot, chatId) {
  logger.info('Команда /start от chat_id=%s', chatId);
  const text = [
    '🤖 <b>News Analyst Bot</b>',
    'Собираю экономические новости по российскому рынку из шести RSS-источников',
    'и присылаю краткий торговый прогноз от DeepSeek.',
    '',
    notifier.formatSchedule(),
    '',
    HELP_TEXT,
  ].join('\n');
  await notifier.sendMessage(bot, text, chatId);
}

/** Запуск анализа вне расписания (/now). */
export async function cmdNow(bot, chatId) {
  logger.info('Команда /now от chat_id=%s', chatId);
  if (jobs.isAnalysisRunning()) {
    await notifier.sendMessage(bot, '⏳ Анализ уже выполняется, дождитесь готового отчёта.', chatId);
    return;
  }

  await notifier.sendMessage(
    bot,
    '🚀 Запускаю анализ вне расписания. Отчёт придёт отдельным сообщением.',
    chatId,
  );
  const result = await jobs.runAnalysis(bot, 'manual');
  if (result === null) {
    await notifier.sendMessage(bot, '⚠️ Анализ не удался, подробности в bot.log.', chatId);
  }
}

/** Последний прогноз из БД (/last). */
export async function cmdLast(bot, chatId) {
  logger.info('Команда /last от chat_id=%s', chatId);
  const run = db.getLastRun();
  await notifier.sendMessage(bot, notifier.formatLastRun(run), chatId);
}

/** Статистика за 7 дней (/stats). */
export async function cmdStats(bot, chatId) {
  logger.info('Команда /stats от chat_id=%s', chatId);
  const stats = db.getStats(7);
  await notifier.sendMessage(bot, notifier.formatStats(stats), chatId);
}

/** Точность прогнозов за 30 дней (/accuracy, Часть 3). */
export async function cmdAccuracy(bot, chatId) {
  logger.info('Команда /accuracy от chat_id=%s', chatId);
  const stats = db.getPredictionStats();
  await notifier.sendMessage(bot, notifier.formatAccuracy(stats), chatId);
}

/** Снимок позиций Tinkoff без анализа (/portfolio, Часть 4). */
export async function cmdPortfolio(bot, chatId) {
  logger.info('Команда /portfolio от chat_id=%s', chatId);
  await notifier.sendMessage(bot, '💼 Запрашиваю портфель Tinkoff…', chatId);
  // force=True: ручной запрос всегда мимо 5-минутного кэша
  const snapshot = await jobs.getPortfolioSnapshot(true);
  await notifier.sendMessage(bot, notifier.formatPortfolio(snapshot), chatId);
}

/** Расписание и следующее время запуска (/schedule). */
export async function cmdSchedule(bot, chatId) {
  logger.info('Команда /schedule от chat_id=%s', chatId);
  await notifier.sendMessage(bot, notifier.formatSchedule(), chatId);
}

/** Список команд (/help). */
export async function cmdHelp(bot, chatId) {
  logger.info('Команда /help от chat_id=%s', chatId);
  await notifier.sendMessage(bot, HELP_TEXT, chatId);
}

/** Любой другой текст — подсказка (аналог @router.message()). */
export async function cmdUnknown(bot, chatId) {
  await notifier.sendMessage(bot, `Неизвестная команда.\n\n${HELP_TEXT}`, chatId);
}

/** Таблица «команда → обработчик». */
export const HANDLERS = {
  start: cmdStart,
  now: cmdNow,
  last: cmdLast,
  stats: cmdStats,
  accuracy: cmdAccuracy,
  portfolio: cmdPortfolio,
  schedule: cmdSchedule,
  help: cmdHelp,
};

/**
 * Обрабатывает один update от getUpdates (аналог dispatcher.start_polling).
 *
 * Возвращает имя выполненной команды ('unknown' для текста без команды)
 * или null, если update не про сообщение.
 */
export async function handleUpdate(bot, update) {
  const message = update && update.message;
  if (!message) return null;
  const chat = message.chat || {};
  const chatId = chat.id;
  if (chatId === null || chatId === undefined) return null;

  const parsed = parseCommand(message.text);
  let name = 'unknown';
  if (parsed && !addressedToAnotherBot(bot, parsed.mention)) {
    name = Object.prototype.hasOwnProperty.call(HANDLERS, parsed.command) ? parsed.command : 'unknown';
  }

  try {
    const handler = name === 'unknown' ? cmdUnknown : HANDLERS[name];
    await handler(bot, chatId);
  } catch (exc) {
    // aiogram логирует ошибку хендлера и продолжает polling
    logger.exception('Ошибка обработки команды /%s: %s', name, exc);
  }
  return name;
}
