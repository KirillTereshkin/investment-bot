/**
 * End-to-end проверка: полный прогон run_analysis с заглушкой бота
 * (порт test_end_to_end из news_analyst_bot/_smoke_test.py).
 *
 * Набор живой: ходит в реальные RSS-источники, MOEX/ЦБ, T-Invest API и DeepSeek
 * (если ключ есть в .env или в переменных окружения). Запускается только вместе
 * с флагом --live:
 *   npm run smoke -- --live
 *   node --experimental-sqlite --disable-warning=ExperimentalWarning tests/check_e2e.mjs
 *
 * Пути к базе и логу выставляются ДО импорта config.js, поэтому тест не трогает
 * рабочую базу и файл bot.log (в Python-версии тест подменял config.DB_PATH и
 * config.NEWS_WINDOW_MINUTES в рантайме).
 */

import path from 'node:path';

const SMOKE_DB = path.join(import.meta.dirname, '_smoke.sqlite3');
const SMOKE_LOG = path.join(import.meta.dirname, '_smoke.log');

process.env.DB_PATH = process.env.DB_PATH || SMOKE_DB;
process.env.LOG_PATH = process.env.LOG_PATH || SMOKE_LOG;
// окно шире суток — иначе в тесте может не оказаться ни одной новости
process.env.NEWS_WINDOW_MINUTES = process.env.NEWS_WINDOW_MINUTES || '1440';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '123456789';

// импорты после правки окружения — модули читают env на этапе загрузки
const config = await import('../src/config.js');
const jobs = await import('../src/scheduler/jobs.js');
const db = await import('../src/storage/db.js');

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

/** Заглушка бота: складывает отправленные тексты, в сеть не выходит. */
class FakeBot {
  constructor() {
    this.sent = [];
    this.username = 'smoke_bot';
  }

  async sendMessage(chatId, text) {
    this.sent.push(String(text));
    return true;
  }

  async getMe() {
    return { id: 1, is_bot: true, username: this.username };
  }

  async close() {
    /* симметрия с aiogram Bot.session.close() */
  }
}

const bot = new FakeBot();
const payload = await jobs.runAnalysis(bot, 'manual');

check('e2e: run_analysis вернул результат', payload !== null && typeof payload === 'object');
check(
  'e2e: сообщение отправлено',
  bot.sent.length === 1 && bot.sent[0].length > 100,
  `частей=${bot.sent.length}`,
);

if (payload !== null && typeof payload === 'object') {
  check('e2e: дайджест не пуст', payload.digest_lines > 0, `строк=${payload.digest_lines}`);
  eq('e2e: шесть источников в отчёте', payload.sources.length, 6);

  const status = String(payload.deepseek_status ?? '');
  check(
    'e2e: статус DeepSeek зафиксирован',
    status === 'ok' || status.startsWith('error:'),
    status,
  );

  check('e2e: прогон записан в БД', db.getLastRun() !== null);

  const market = payload.market;
  check(
    'e2e: рыночный контекст в payload',
    Boolean(market) && 'usdrub' in market && 'cnyrub' in market,
    JSON.stringify(market),
  );

  check(
    'e2e: статус Tinkoff в сообщении',
    String(payload.tinkoff_status ?? '').includes('💼 Tinkoff:'),
    String(payload.tinkoff_status),
  );

  check('e2e: снимок рынка сохранён в SQLite', db.getLastMarketSnapshot() !== null);
  check('e2e: статус Tinkoff сохранён в runs', Boolean((db.getLastRun() ?? {}).tinkoff_status));
  check(
    'e2e: счётчик предсказаний посчитан',
    Number.isInteger(payload.predictions_created),
    String(payload.predictions_created),
  );

  if (payload.predictions_created) {
    check(
      'e2e: идеи попали в predictions',
      db.getPredictionStats().total > 0,
      String(db.getPredictionStats().total),
    );
  }

  // Повторный одновременный запуск должен быть отклонён (lock)
  check('e2e: повторный запуск после завершения работает', jobs.isAnalysisRunning() === false);
}

if (bot.sent.length > 0) {
  console.log('\n--- ТЕЛЕГРАМ-СООБЩЕНИЕ (заглушка) ---\n' + bot.sent[0].slice(0, 2500) + '\n--- КОНЕЦ ---\n');
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
