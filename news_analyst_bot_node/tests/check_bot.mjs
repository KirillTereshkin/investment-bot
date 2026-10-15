/**
 * Оффлайн-проверки порта bot/handlers.py, bot/notifier.py, bot/telegram.py,
 * scheduler/jobs.py, scheduler/cron.py и main.py — то, что в _smoke_test.py
 * проверялось блоками test_handlers / test_notifier_send / test_schedule /
 * test_messages.
 *
 * Запуск: node --experimental-sqlite --disable-warning=ExperimentalWarning tests/check_bot.mjs
 *
 * В сеть не выходим: вместо Telegram Bot API подставляем fetch-заглушку в
 * TelegramBot (fetchImpl), поэтому проверяется настоящий путь отправки — HTML,
 * chat_id, разбивка длинных сообщений, повтор без разметки после ошибки 400.
 * DeepSeek и Tinkoff тест считает ненастроенными (smoke_test.js передаёт
 * DEEPSEEK_API_KEY=' ' и TINKOFF_INVEST_TOKEN=' ' — config.trim() даёт null).
 *
 * Пути к базе и логу выставляются ДО импорта config.js, чтобы тест не трогал
 * рабочую базу (в Python-версии тест подменял config.DB_PATH в рантайме).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SMOKE_DB = path.join(import.meta.dirname, '_smoke.sqlite3');
const SMOKE_LOG = path.join(import.meta.dirname, '_smoke.log');

process.env.DB_PATH = process.env.DB_PATH || SMOKE_DB;
process.env.LOG_PATH = process.env.LOG_PATH || SMOKE_LOG;

// Без секретов тест не зависит от сети: Tinkoff отвечает «не настроен»,
// DeepSeek-клиент не создаётся (как config.TINKOFF_INVEST_TOKEN = None в _smoke_test.py).
process.env.TINKOFF_INVEST_TOKEN = ' ';
process.env.DEEPSEEK_API_KEY = ' ';

// импорты после правки окружения — модули читают env на этапе загрузки
const config = await import('../src/config.js');
const handlers = await import('../src/bot/handlers.js');
const notifier = await import('../src/bot/notifier.js');
const jobs = await import('../src/scheduler/jobs.js');
const cron = await import('../src/scheduler/cron.js');
const db = await import('../src/storage/db.js');
const horizon = await import('../src/predictions/horizon.js');
const telegram = await import('../src/bot/telegram.js');
const main = await import('../main.js');

const results = [];

function check(name, condition, extra = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  return Boolean(condition);
}

function eq(name, actual, expected) {
  const ok = Object.is(actual, expected);
  const extra = ok ? String(actual) : `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`;
  return check(name, ok, extra);
}

/**
 * Заглушка Telegram Bot API: пишет вызовы и умеет ломаться.
 *
 * badRequestFirst — первое сообщение отклонено (HTTP 400, невалидная разметка),
 * apiErrorAlways — все вызовы с HTTP 500.
 */
function makeFetch({ badRequestFirst = false, apiErrorAlways = false } = {}) {
  const calls = [];
  let messages = 0;

  const impl = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (method === 'getMe') {
      return json({
        ok: true,
        result: { id: 42, is_bot: true, first_name: 'News Analyst', username: 'news_analyst_bot' },
      });
    }
    if (method === 'sendMessage') {
      messages += 1;
      if (apiErrorAlways) {
        return json({ ok: false, error_code: 500, description: 'Internal Server Error' }, 500);
      }
      if (badRequestFirst && messages === 1) {
        return json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400);
      }
      return json({ ok: true, result: { message_id: messages } });
    }
    return json({ ok: true, result: true });
  };

  const sent = () => calls.filter((call) => call.method === 'sendMessage');
  return { impl, calls, sent };
}

function buildBot(options = {}) {
  const recorder = makeFetch(options);
  const bot = new telegram.TelegramBot('123456:TEST_TOKEN', { fetchImpl: recorder.impl });
  return { bot, ...recorder };
}

/** Тестовый чат: значение config.TELEGRAM_CHAT_ID или 4242, если оно не задано. */
const CHAT_ID = config.TELEGRAM_CHAT_ID || 4242;

/** Источники прогона — как base_sources() в _smoke_test.py. */
function baseSources() {
  return [
    { source: 'RBC News', status: 'ok', reason: null, count: 8 },
    { source: 'CBR', status: 'ok', reason: null, count: 12 },
    { source: 'TASS', status: 'ok', reason: null, count: 5 },
    { source: 'Interfax', status: 'ok', reason: null, count: 3 },
    { source: 'Kommersant', status: 'empty', reason: null, count: 0 },
    { source: 'Investing.com', status: 'error', reason: 'timeout', count: 0 },
  ];
}

/** Успешный payload анализа — как ok_payload() в _smoke_test.py. */
function okPayload() {
  const windowEnd = config.nowMsk();
  const windowStart = new Date(windowEnd.getTime() - 2 * 3600 * 1000);
  return {
    window_start: windowStart,
    window_end: windowEnd,
    sources: baseSources(),
    deepseek_status: 'ok',
    tokens: 1240,
    duration_ms: 1800,
    parsed: {
      резюме_рынка: 'Ставка выросла, банки под давлением.',
      идеи: [
        {
          инструмент: 'SBER',
          направление: 'лонг',
          горизонт: '2-8 недель',
          уверенность: 'средняя',
          обоснование: 'Высокие ставки = высокая маржа.',
          триггер_отмены: 'Снижение ставки ЦБ.',
        },
        {
          инструмент: 'CNY/RUB',
          направление: 'наблюдать',
          горизонт: '4 недели',
          уверенность: 'низкая',
          обоснование: 'Ждём данные по экспорту.',
          триггер_отмены: 'Рост нефти.',
        },
      ],
      урок_дня: 'Рынок живёт ожиданиями ставки.',
      сигналов_нет: false,
    },
  };
}

// ---------------------------------------------------------------------------
// bot/telegram.js — клиент Bot API (замена aiogram Bot в объёме проекта)
// ---------------------------------------------------------------------------
{
  const { bot, sent } = buildBot();
  const me = await bot.getMe();
  eq('telegram: getMe возвращает профиль', me.username, 'news_analyst_bot');
  eq('telegram: username запомнен (фильтр упоминаний)', bot.username, 'news_analyst_bot');

  await bot.sendMessage(CHAT_ID, '<b>тест</b>', { parseMode: 'HTML', disableWebPagePreview: true });
  const message = sent()[0].body;
  eq('telegram: parse_mode=HTML', message.parse_mode, 'HTML');
  eq('telegram: предпросмотр ссылок отключён', message.disable_web_page_preview, true);
  eq('telegram: адресат — chat_id', message.chat_id, CHAT_ID);

  const plain = buildBot();
  await plain.bot.sendMessage(CHAT_ID, 'плоский текст');
  check(
    'telegram: без parseMode разметка не включается (как aiogram)',
    !plain.sent()[0].body.parse_mode,
    JSON.stringify(plain.sent()[0].body),
  );

  const broken = buildBot({ badRequestFirst: true });
  let badRequest = null;
  try {
    await broken.bot.sendMessage(CHAT_ID, '<b>x</b>');
  } catch (exc) {
    badRequest = exc;
  }
  check(
    'telegram: HTTP 400 → TelegramBadRequest',
    badRequest instanceof telegram.TelegramBadRequest,
    badRequest && badRequest.name,
  );

  const dead = buildBot({ apiErrorAlways: true });
  let apiError = null;
  try {
    await dead.bot.sendMessage(CHAT_ID, 'x');
  } catch (exc) {
    apiError = exc;
  }
  check(
    'telegram: HTTP 500 → TelegramApiError',
    apiError instanceof telegram.TelegramApiError && apiError.error_code === 500,
    apiError && apiError.name,
  );
}

// ---------------------------------------------------------------------------
// bot/notifier.py — формат сообщений (test_messages, test_message_variants)
// ---------------------------------------------------------------------------
const payload = okPayload();
const message = notifier.buildAnalysisMessage(payload);
check('msg: заголовок окна', message.includes('📊 <b>Анализ за') && message.includes('МСК ('));
check(
  'msg: статусы источников',
  message.includes('📡 <b>Источники (4/6 ok):</b>') &&
    message.includes('❌ Investing.com — timeout') &&
    message.includes('⚠️ Kommersant — пусто'),
);
check('msg: DeepSeek ok с токенами', message.includes('🧠 DeepSeek: ok | 1240 токенов | 1.8 сек'));
check(
  'msg: идеи и обоснование',
  message.includes('1. SBER — лонг, 2-8 недель, уверенность: средняя') &&
    message.includes('⚠️ Отмена: Снижение ставки ЦБ.'),
);
check('msg: урок дня', message.includes('📌 <b>Урок дня:</b>'));
check('msg: следующий анализ', message.includes('⏭️ Следующий анализ в'));
check('msg: нет дисклеймера при 1/6 упавших', !message.includes('Больше половины источников'));

const deadPayload = {
  ...payload,
  sources: [
    ...['S0', 'S1', 'S2', 'S3'].map((source) => ({ source, status: 'error', reason: 'http_500', count: 0 })),
    { source: 'OK', status: 'ok', reason: null, count: 2 },
    { source: 'OK2', status: 'empty', reason: null, count: 0 },
  ],
};
check(
  'msg: дисклеймер >50% упавших',
  notifier.buildAnalysisMessage(deadPayload).includes('Больше половины источников недоступно'),
);

const errorMessage = notifier.buildAnalysisMessage({
  ...payload,
  deepseek_status: 'error:invalid_json',
  tokens: null,
  duration_ms: null,
  parsed: null,
});
check(
  'msg: ошибка DeepSeek',
  errorMessage.includes('ошибка после 2 ретраев — "ответ модели не является JSON"') &&
    errorMessage.includes('Прогноз не получен'),
);

const skippedMessage = notifier.buildAnalysisMessage({
  ...payload,
  deepseek_status: 'skipped',
  tokens: null,
  duration_ms: null,
  parsed: null,
});
check(
  'msg: пустой дайджест',
  skippedMessage.includes('не вызывался') && skippedMessage.includes('Новостей за окно нет.'),
);

const noSignals = notifier.buildAnalysisMessage({
  ...payload,
  parsed: { резюме_рынка: 'Тишина.', идеи: [], урок_дня: 'Ждём.', сигналов_нет: true },
});
check('msg: сигналов нет', noSignals.includes('Сигналов нет. Рынок без значимых новостей за окно.'));

const escaped = notifier.buildAnalysisMessage({
  ...payload,
  parsed: { резюме_рынка: 'ставка < 20 & инфляция > 5', идеи: [], сигналов_нет: true },
});
check('msg: экранирование HTML', escaped.includes('&lt; 20') && escaped.includes('&amp;'));

const chunks = notifier.splitMessage('я'.repeat(10000));
check(
  'msg: разбивка длинного текста',
  chunks.length > 1 && chunks.every((chunk) => chunk.length <= config.TELEGRAM_MAX_MESSAGE_LEN),
  `частей=${chunks.length}`,
);

check('msg: расписание', notifier.formatSchedule().includes('🗓 <b>Расписание:</b>'));
const startup = notifier.formatStartupMessage();
check(
  'msg: сообщение о старте',
  startup.includes('Бот запущен.') && startup.includes(config.ANALYSIS_HOURS.map(String).join(',')),
);

const warningMessage = notifier.buildAnalysisMessage({
  ...payload,
  parsed: {
    ...payload.parsed,
    предупреждения_по_позициям: [
      {
        инструмент: 'SBER',
        риск: 'позиция против идеи',
        позиция: 'лонг при шорте',
        обоснование: 'Идея лонг, у вас шорт.',
        рекомендация: 'Закрыть шорт.',
      },
    ],
  },
});
check(
  'msg: блок предупреждений по позициям',
  warningMessage.includes('⚠️ <b>По вашим позициям:</b>') &&
    warningMessage.includes('• SBER — позиция против идеи (лонг при шорте): Идея лонг, у вас шорт.') &&
    warningMessage.includes('Рекомендация: Закрыть шорт.'),
);
check(
  'msg: предупреждения идут до «Следующий анализ»',
  warningMessage.indexOf('По вашим позициям') < warningMessage.indexOf('⏭️ Следующий анализ в'),
);
check('msg: без предупреждений блока нет', !message.includes('По вашим позициям'));

const escapedWarning = notifier.buildAnalysisMessage({
  ...payload,
  parsed: { ...payload.parsed, предупреждения_по_позициям: [{ инструмент: 'SBER', риск: '<b>риск</b>' }] },
});
check('msg: блок предупреждений экранируется', escapedWarning.includes('&lt;b&gt;риск&lt;/b&gt;'));

check(
  'msg: строка статуса Tinkoff',
  notifier
    .buildAnalysisMessage({ ...payload, tinkoff_status: '💼 Tinkoff: позиции загружены (2)' })
    .includes('💼 Tinkoff: позиции загружены (2)'),
);

check(
  'msg: /last показывает Tinkoff',
  notifier
    .formatLastRun({
      started_at: '2026-01-01T10:00+03:00',
      deepseek_status: 'ok',
      deepseek_tokens: 1240,
      deepseek_duration_ms: 1800,
      tinkoff_status: '💼 Tinkoff: позиции загружены (2)',
      sources_status: JSON.stringify(baseSources()),
      parsed_json: JSON.stringify(payload.parsed),
      digest: 'строка один\nстрока два',
    })
    .includes('💼 Tinkoff: позиции загружены (2)'),
);
check(
  'msg: /last без Tinkoff не падает',
  notifier
    .formatLastRun({ started_at: '2026-01-01T10:00+03:00', deepseek_status: 'ok' })
    .includes('🕓 <b>Последний прогон:</b>'),
);

check('horizon: константы направлений', typeof horizon.RISE === 'string' && typeof horizon.FALL === 'string');
check(
  'msg: итог проверки идей',
  notifier
    .formatPredictionsCheck([
      { ticker: 'SBER', direction: horizon.RISE, realized_direction: horizon.RISE, hit: 1, change_pct: 1.2 },
      { ticker: 'GAZP', direction: horizon.FALL, realized_direction: horizon.RISE, hit: 0, change_pct: -0.7 },
    ])
    .includes('Итог: сбылось 1, не сбылось 1 из 2'),
);

check(
  'msg: /portfolio без позиций',
  notifier
    .formatPortfolio({ ok: true, positions: [], totalValue: null, statusText: () => '💼 Tinkoff: ok' })
    .includes('Открытых позиций нет.'),
);
const portfolioOk = notifier.formatPortfolio({
  ok: true,
  positions: [{ asTelegramLine: () => '• SBER: 10 шт.' }],
  totalValue: 12345.6,
  statusText: () => '💼 Tinkoff: ok',
});
check(
  'msg: /portfolio с позициями и итогом',
  portfolioOk.includes('• SBER: 10 шт.') && /Итого: <b>[\d\s\u00a0.,]+ ₽<\/b>/.test(portfolioOk),
  portfolioOk.split('\n').pop(),
);

// ---------------------------------------------------------------------------
// bot/notifier.py — отправка (test_notifier_send: разбивка, fallback, ошибки)
// ---------------------------------------------------------------------------
async function sendViaNotifier(options = {}, text = 'текст', chatId = CHAT_ID) {
  const { bot, sent } = buildBot(options);
  const delivered = await notifier.sendMessage(bot, text, chatId);
  return { delivered, sent: sent() };
}

const longSend = await sendViaNotifier({}, 'строка\n'.repeat(1200));
check('notifier: длинное сообщение разбито на части', longSend.sent.length > 1, `частей=${longSend.sent.length}`);
check('notifier: отправка помечена успешной', longSend.delivered === true);
check(
  'notifier: все части в пределах лимита Telegram',
  longSend.sent.every((entry) => [...entry.body.text].length <= config.TELEGRAM_MAX_MESSAGE_LEN),
);
check(
  'notifier: parse_mode=HTML задан явно',
  longSend.sent.every((entry) => entry.body.parse_mode === 'HTML'),
);
check(
  'notifier: адресат — переданный chat_id',
  longSend.sent.every((entry) => entry.body.chat_id === CHAT_ID),
);

const fallbackSend = await sendViaNotifier({ badRequestFirst: true }, '<b>жирный</b> текст');
check(
  'notifier: повтор без разметки после ошибки Telegram',
  fallbackSend.sent.length === 2 && fallbackSend.delivered === true,
);
check(
  'notifier: fallback ушёл без HTML-тегов',
  !fallbackSend.sent[1].body.parse_mode && !fallbackSend.sent[1].body.text.includes('<b>'),
  JSON.stringify(fallbackSend.sent[1].body),
);
eq('notifier: strip_html', notifier.stripHtml('<b>жирный</b> &amp; текст'), 'жирный & текст');

const deadSend = await sendViaNotifier({ apiErrorAlways: true });
check(
  'notifier: ошибка API → доставка не подтверждена',
  deadSend.delivered === false && deadSend.sent.length === 1,
);

const noChatSend = await sendViaNotifier({}, 'текст', null);
check(
  'notifier: без chat_id отправки нет',
  config.TELEGRAM_CHAT_ID ? noChatSend.sent.length === 1 : noChatSend.delivered === false && noChatSend.sent.length === 0,
  `chat_id в конфиге: ${config.TELEGRAM_CHAT_ID}`,
);

// ---------------------------------------------------------------------------
// bot/handlers.py — команды и маршрутизация update'ов
// ---------------------------------------------------------------------------
db.initDb();

async function runCommand(handler) {
  const { bot, sent } = buildBot();
  await handler(bot, CHAT_ID);
  return sent().map((entry) => entry.body);
}

check(
  'handlers: 8 команд + обработчик любого текста',
  handlers.COMMANDS.length === 8 &&
    Object.keys(handlers.HANDLERS).length === 8 &&
    typeof handlers.cmdUnknown === 'function',
);

const helpSent = await runCommand(handlers.cmdHelp);
eq('handlers: /help отдаёт HELP_TEXT', helpSent[0].text, handlers.HELP_TEXT);
check(
  'handlers: /help знает про /accuracy и /portfolio',
  handlers.HELP_TEXT.includes('/accuracy') && handlers.HELP_TEXT.includes('/portfolio'),
);

const scheduleSent = await runCommand(handlers.cmdSchedule);
check('handlers: /schedule показывает расписание', scheduleSent[0].text.includes('🗓 <b>Расписание:</b>'));

const startSent = await runCommand(handlers.cmdStart);
check(
  'handlers: /start показывает расписание и команды',
  startSent[0].text.includes('🗓 <b>Расписание:</b>') && startSent[0].text.includes('/help'),
);

const lastSent = await runCommand(handlers.cmdLast);
check(
  'handlers: /last читает БД',
  lastSent[0].text.includes('🕓 <b>Последний прогон:</b>') || lastSent[0].text.includes('📭 Прогонов ещё не было'),
  lastSent[0].text.split('\n')[0],
);

const statsSent = await runCommand(handlers.cmdStats);
check('handlers: /stats читает БД', statsSent[0].text.includes('📊 <b>Статистика за 7 дней</b>'));

const accuracySent = await runCommand(handlers.cmdAccuracy);
check(
  'handlers: /accuracy читает predictions',
  accuracySent[0].text.includes('📊 <b>Точность прогнозов за 30 дней</b>') &&
    accuracySent[0].text.includes('⏳ Ожидают проверки:'),
);

const portfolioSent = await runCommand(handlers.cmdPortfolio);
const portfolioText = portfolioSent.map((entry) => entry.text).join('\n');
check(
  'handlers: /portfolio отвечает снимком',
  portfolioSent.length === 2 && portfolioText.includes('💼 <b>Портфель Tinkoff</b>'),
);
check('handlers: /portfolio без токена сообщает причину', portfolioText.includes('TINKOFF_INVEST_TOKEN не задан'));

const unknownSent = await runCommand(handlers.cmdUnknown);
check('handlers: неизвестная команда', unknownSent[0].text.startsWith('Неизвестная команда.'));

const allSent = [
  ...helpSent,
  ...scheduleSent,
  ...startSent,
  ...lastSent,
  ...statsSent,
  ...accuracySent,
  ...portfolioSent,
  ...unknownSent,
];
check(
  'handlers: все ответы с отключённым предпросмотром',
  allSent.every((entry) => entry.disable_web_page_preview === true),
);
check(
  'handlers: ответы адресованы тому же чату',
  allSent.every((entry) => entry.chat_id === CHAT_ID),
);

eq('handlers: parseCommand понимает @username', handlers.parseCommand('/help@news_analyst_bot').command, 'help');
eq('handlers: parseCommand игнорирует обычный текст', handlers.parseCommand('привет'), null);

{
  const { bot, sent } = buildBot();
  await bot.getMe(); // username нужен, чтобы отличить своё упоминание от чужого
  const update = (messageId, text) => ({
    update_id: messageId,
    message: { message_id: messageId, chat: { id: CHAT_ID }, text },
  });

  eq(
    'handleUpdate: /help@news_analyst_bot → help',
    await handlers.handleUpdate(bot, update(1, '/help@news_analyst_bot')),
    'help',
  );
  eq(
    'handleUpdate: /help@other_bot → unknown',
    await handlers.handleUpdate(bot, update(2, '/help@other_bot')),
    'unknown',
  );
  eq('handleUpdate: текст без команды → unknown', await handlers.handleUpdate(bot, update(3, 'привет')), 'unknown');
  eq('handleUpdate: не message → null', await handlers.handleUpdate(bot, { update_id: 4 }), null);
  eq('handleUpdate: без chat → null', await handlers.handleUpdate(bot, { update_id: 5, message: { text: '/help' } }), null);
  check(
    'handleUpdate: чужое упоминание получило подсказку',
    sent().length === 3 && sent()[1].body.text.startsWith('Неизвестная команда.'),
    `сообщений=${sent().length}`,
  );

  const failingBot = {
    username: 'news_analyst_bot',
    sendMessage: async () => {
      throw new telegram.TelegramApiError('boom', { errorCode: 500 });
    },
  };
  eq(
    'handleUpdate: падение хендлера не роняет polling',
    await handlers.handleUpdate(failingBot, update(6, '/help')),
    'help',
  );
}

// ---------------------------------------------------------------------------
// scheduler/cron.js + scheduler/jobs.js — расписание и срабатывание задач
// ---------------------------------------------------------------------------
const hoursText = config.ANALYSIS_HOURS.join(',');
const at = (iso) => new Date(iso);

eq('cron: следующий запуск внутри дня — 14:00', config.formatHhmm(cron.nextRunTime(at('2026-10-15T13:30:00+03:00'))), '14:00');
eq('cron: после последнего часа — 10:00 следующего дня', config.formatHhmm(cron.nextRunTime(at('2026-10-15T20:30:00+03:00'))), '10:00');
eq('cron: ровно в час запуска — следующий слот', config.formatHhmm(cron.nextRunTime(at('2026-10-15T14:00:00+03:00'))), '16:00');
eq('jobs: schedule_human', cron.scheduleHuman(), config.ANALYSIS_HOURS.join(', '));

const triggerSpec = jobs.buildTriggerSpec();
check(
  'jobs: buildTriggerSpec — часы и минута',
  String(triggerSpec.hour) === hoursText && Number(triggerSpec.minute) === 0,
  JSON.stringify(triggerSpec),
);
const checkSpec = jobs.buildCheckTriggerSpec();
check(
  'jobs: buildCheckTriggerSpec — час проверки идей',
  Number(checkSpec.hour) === config.PREDICTION_CHECK_HOUR &&
    Number(checkSpec.minute) === config.PREDICTION_CHECK_MINUTE,
  JSON.stringify(checkSpec),
);

const { bot: scheduleBot } = buildBot();
const scheduler = jobs.setupScheduler(scheduleBot);
const analysisJob = scheduler.jobs.get('hourly_analysis');
check('scheduler: job hourly_analysis зарегистрирован', analysisJob !== undefined);
check(
  'scheduler: часы и минута из конфига',
  String(analysisJob.hours) === hoursText && analysisJob.minute === 0,
  String(analysisJob.hours),
);
check('scheduler: maxInstances=1 и coalesce=true', analysisJob.maxInstances === 1 && analysisJob.coalesce === true);
check('scheduler: таймзона МСК', ['Europe/Moscow', 'MSK'].includes(scheduler.timezone), scheduler.timezone);
check('scheduler: misfireGraceSec=300', analysisJob.misfireGraceSec === 300);
check('scheduler: без start() ничего не запущено', scheduler.running === false);
check('scheduler: ровно два job-а', scheduler.jobs.size === 2, [...scheduler.jobs.keys()].join(', '));
check('scheduler: job daily_prediction_check зарегистрирован', scheduler.jobs.get('daily_prediction_check') !== undefined);

const nowMsk = config.nowMsk();
const nextFire = scheduler.nextRunOf('hourly_analysis', nowMsk);
check(
  'scheduler: следующий запуск на ровный час МСК',
  nextFire !== null &&
    config.mskParts(nextFire).minute === 0 &&
    config.ANALYSIS_HOURS.includes(config.mskParts(nextFire).hour),
  config.strftimeMsk(nextFire, '%d.%m %H:%M'),
);
const checkFire = scheduler.nextRunOf('daily_prediction_check', nowMsk);
check(
  'scheduler: проверка идей в заданное время МСК',
  checkFire !== null &&
    config.mskParts(checkFire).hour === config.PREDICTION_CHECK_HOUR &&
    config.mskParts(checkFire).minute === config.PREDICTION_CHECK_MINUTE,
  config.strftimeMsk(checkFire, '%d.%m %H:%M'),
);

check('jobs: isAnalysisRunning — свободен', jobs.isAnalysisRunning() === false);
eq('jobs: countIdeas считает идеи', jobs.countIdeas(payload.parsed), 2);
eq('jobs: countIdeas при сигналов_нет = 0', jobs.countIdeas({ сигналов_нет: true, идеи: [{ инструмент: 'SBER' }] }), 0);
eq('jobs: countIdeas без идей = 0', jobs.countIdeas({}), 0);

{
  const fired = [];
  const probeScheduler = new cron.CronScheduler();
  probeScheduler.addJob({
    id: 'probe',
    hours: config.ANALYSIS_HOURS,
    minute: 0,
    handler: async () => {
      fired.push(Date.now());
    },
    misfireGraceSec: 300,
    maxInstances: 1,
  });
  const probe = probeScheduler.jobs.get('probe');
  probeScheduler.running = true;

  await probeScheduler._fire(probe, new Date(Date.now() - 600_000)); // опоздание 10 минут
  eq('misfire: опоздание больше misfireGraceSec → запуск пропущен', fired.length, 0);

  probe.running = 1; // имитируем незавершённый предыдущий запуск
  await probeScheduler._fire(probe, new Date());
  eq('maxInstances: повторный запуск пропущен', fired.length, 0);

  probe.running = 0;
  await probeScheduler._fire(probe, new Date());
  eq('misfire: нормальный запуск выполняется', fired.length, 1);
  check('scheduler: после срабатывания запланирован следующий запуск', probe.nextRun instanceof Date);

  probeScheduler.shutdown();
  check('scheduler: shutdown снимает таймеры', probe.timer === null && probeScheduler.running === false);
}


// ---------------------------------------------------------------------------
// main.py — логирование, проверка конфига, long polling, запуск приложения
// ---------------------------------------------------------------------------
const fs = await import('node:fs');
const { pathToFileURL } = await import('node:url');

main.setupLogging();
const { getLogger } = await import('../src/logger.js');
getLogger('check.bot').info('проверка записи в файл лога');
check('main: setupLogging пишет в файл лога', fs.existsSync(config.LOG_PATH), config.LOG_PATH);

const MAIN_URL = pathToFileURL(path.join(ROOT, 'main.js')).href;
const NODE_ARGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];

function runValidateConfig(env) {
  const script =
    `import(${JSON.stringify(MAIN_URL)}).then((m) => {` +
    " try { m.validateConfig(); console.log('VALIDATE_OK'); }" +
    " catch (exc) { console.log('VALIDATE_FAIL:' + exc.constructor.name + ':' + exc.message.split('\\n')[0]); } });";
  const result = spawnSync(process.execPath, [...NODE_ARGS, '--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

const allMissing = runValidateConfig({
  TELEGRAM_BOT_TOKEN: ' ',
  TELEGRAM_CHAT_ID: ' ',
  DEEPSEEK_API_KEY: ' ',
});
check(
  'main: validateConfig перечисляет все незаполненные секреты',
  allMissing.includes(
    'VALIDATE_FAIL:ConfigError:Не заполнены переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DEEPSEEK_API_KEY.',
  ),
  allMissing.trim() || 'пустой вывод',
);

const oneMissing = runValidateConfig({ TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_CHAT_ID: '1', DEEPSEEK_API_KEY: ' ' });
check(
  'main: validateConfig сообщает только про DEEPSEEK_API_KEY',
  oneMissing.includes('VALIDATE_FAIL:ConfigError:Не заполнены переменные окружения: DEEPSEEK_API_KEY.'),
  oneMissing.trim(),
);

const entryRun = spawnSync(process.execPath, [...NODE_ARGS, path.join(ROOT, 'main.js')], {
  cwd: ROOT,
  env: { ...process.env, TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: ' ', DEEPSEEK_API_KEY: ' ' },
  encoding: 'utf8',
});
check(
  'main: точка входа печатает причину и завершается с кодом 1',
  entryRun.status === 1 && String(entryRun.stderr).includes('Не заполнены переменные окружения:'),
  `код=${entryRun.status}`,
);

{
  const offsets = [];
  const texts = [];
  let stop = false;
  const pollBot = {
    username: 'news_analyst_bot',
    async getUpdates(offset) {
      offsets.push(offset);
      if (offsets.length === 1) {
        return [
          { update_id: 10, message: { message_id: 1, chat: { id: CHAT_ID }, text: '/help' } },
          { update_id: 11, message: { message_id: 2, chat: { id: CHAT_ID }, text: 'привет' } },
        ];
      }
      stop = true;
      return [];
    },
    async sendMessage(chatId, text) {
      texts.push({ chatId, text });
      return true;
    },
  };

  const processed = await main.startPolling(pollBot, { isStopped: () => stop });
  eq('main.startPolling: обработаны оба обновления', processed, 2);
  eq('main.startPolling: первый запрос без offset', offsets[0], null);
  eq('main.startPolling: offset = max update_id + 1', offsets[1], 12);
  check(
    'main.startPolling: команда исполнена',
    texts.length >= 1 && texts[0].chatId === CHAT_ID && texts[0].text.includes('/help'),
  );
  check(
    'main.startPolling: текст без команды получил подсказку',
    texts.some((entry) => entry.text.startsWith('Неизвестная команда.')),
  );
}

{
  // Полный старт приложения проверяем в отдельном процессе: validateConfig
  // требует заполненные секреты, а в этом процессе они намеренно пустые.
  const childScript = `
const m = await import(${JSON.stringify(MAIN_URL)});
let startupMessage = null;
let closed = false;
const bot = {
  username: 'news_analyst_bot',
  async getMe() { return { id: 1, is_bot: true, username: 'news_analyst_bot' }; },
  async sendMessage(chatId, text) { if (startupMessage === null) startupMessage = String(text); return true; },
  async close() { closed = true; },
};
const handle = await m.main({ bot, poll: false });
console.log('MAIN_OK:' + handle.scheduler.running + ':' + handle.scheduler.jobs.size + ':' + (startupMessage || '').includes('Бот запущен.'));
await handle.stop();
console.log('STOP_OK:' + handle.scheduler.running + ':' + closed);
`;
  const childRun = spawnSync(process.execPath, [...NODE_ARGS, '--input-type=module', '-e', childScript], {
    cwd: ROOT,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: '1',
      DEEPSEEK_API_KEY: 'key',
      TINKOFF_INVEST_TOKEN: ' ',
      DB_PATH: process.env.DB_PATH,
      LOG_PATH: process.env.LOG_PATH,
    },
    encoding: 'utf8',
  });
  const childOut = `${childRun.stdout || ''}${childRun.stderr || ''}`;
  check(
    'main: старт поднимает планировщик с двумя job-ами и шлёт сообщение о запуске',
    childOut.includes('MAIN_OK:true:2:true'),
    childOut.trim().split('\n').pop(),
  );
  check(
    'main: stop останавливает планировщик и закрывает бота',
    childOut.includes('STOP_OK:false:true'),
    childOut.trim().split('\n').pop(),
  );
}

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------
const failedChecks = results.filter((item) => !item.ok);
console.log(`\nИтог: проверок ${results.length}, успешно ${results.length - failedChecks.length}, провалено ${failedChecks.length}`);
if (failedChecks.length > 0) {
  console.log('Провалены:');
  for (const item of failedChecks) console.log(`  - ${item.name}`);
  process.exitCode = 1;
}
