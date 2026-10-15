/**
 * Смоук-тест проекта — порт news_analyst_bot/_smoke_test.py.
 *
 * Запуск:
 *   npm run smoke            — офлайн-проверки (без сети, без живых токенов)
 *   npm run smoke:live       — плюс живые проверки: RSS-источники, MOEX/ЦБ,
 *                              T-Invest API и полный run_analysis с DeepSeek
 *                              (или напрямую: node smoke_test.js --live)
 *
 * Проверки разложены на отдельные процессы в tests/ (каждый набор портирован
 * из соответствующего блока news_analyst_bot/_smoke_test.py), поэтому падение
 * одного набора не мешает остальным. Тесты пишут в tests/_smoke.sqlite3, а не
 * в рабочую базу:
 * путь передаётся переменной DB_PATH (её поддерживает src/config.js).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = import.meta.dirname;
const TESTS = path.join(ROOT, 'tests');
const SMOKE_DB = path.join(TESTS, '_smoke.sqlite3');
const SMOKE_LOG = path.join(TESTS, '_smoke.log');
const NODE_ARGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];

/** Офлайн-наборы: ни сети, ни живых токенов не требуют. */
const OFFLINE_SUITES = [
  { file: 'check_db.mjs', title: 'storage/db (SQLite, прогоны, кэш, прогнозы)', db: true },
  { file: 'check_news.mjs', title: 'news/collector + news/dedup + predictions/horizon' },
  { file: 'check_ai.mjs', title: 'ai/prompts + ai/client (DeepSeek)' },
  { file: 'check_market.mjs', title: 'market/quotes (MOEX ISS, ЦБ, ключевая ставка)', db: true },
  { file: 'check_tinkoff.mjs', title: 'broker/tinkoff (REST/SDK, кэши, ошибки)', db: true },
  {
    file: 'check_bot.mjs',
    title: 'bot/handlers + bot/notifier + scheduler + main.js',
    db: true,
    // детерминированность: Tinkoff и DeepSeek считаются «не настроенными»
    offlineTokens: true,
  },
];

/** Живые наборы: только с флагом --live (сеть, токены, расход DeepSeek). */
const LIVE_SUITES = [
  { file: 'check_live.mjs', title: 'живой опрос RSS-источников' },
  {
    file: 'check_e2e.mjs',
    title: 'end-to-end: run_analysis с заглушкой бота (реальный RSS + DeepSeek)',
    db: true,
    endToEnd: true,
  },
];

/** Считает строки «OK …» и «FAIL …» в выводе набора. */
function countChecks(output) {
  let ok = 0;
  let fail = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[?OK[\s\]]/.test(line) || line === 'OK') ok += 1;
    else if (/^\[?FAIL[\s\]]/.test(line)) fail += 1;
  }
  return { ok, fail };
}

function runSuite(suite) {
  const env = { ...process.env };
  // Все наборы пишут в тестовые базу и лог: рабочие news_bot.sqlite3/bot.log
  // при прогоне смоук-теста не трогаются (флаг db оставлен для наглядности).
  env.DB_PATH = env.DB_PATH || SMOKE_DB;
  env.LOG_PATH = env.LOG_PATH || SMOKE_LOG;
  if (suite.offlineTokens) {
    // пробел, а не пустая строка: dotenv не перезапишет уже заданную переменную,
    // а config.trim() превратит её в null — токены считаются незаданными
    env.TINKOFF_INVEST_TOKEN = ' ';
    env.DEEPSEEK_API_KEY = ' ';
  }
  if (suite.endToEnd) {
    env.NEWS_WINDOW_MINUTES = '1440'; // окно шире, чтобы новости точно были
    env.TELEGRAM_CHAT_ID = '123456789';
  }

  const started = Date.now();
  const result = spawnSync(process.execPath, [...NODE_ARGS, path.join(TESTS, suite.file)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const { ok, fail } = countChecks(output);
  const exitCode = result.status === null ? -1 : result.status;
  const passed = exitCode === 0 && fail === 0;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`### tests/${suite.file} — ${suite.title}`);
  console.log(`### результат: ${passed ? 'OK' : 'FAIL'} | проверок ok=${ok} fail=${fail} | код=${exitCode} | ${seconds} с`);
  console.log(`${'='.repeat(78)}`);
  if (output.trim()) console.log(output.trimEnd());

  return { suite, ok, fail, passed, exitCode, seconds };
}

const withLive = process.argv.includes('--live');
const suites = withLive ? [...OFFLINE_SUITES, ...LIVE_SUITES] : OFFLINE_SUITES;

console.log(`Смоук-тест news_analyst_bot_node (Node ${process.version})`);
console.log(`Рабочая папка: ${ROOT}`);
console.log(`Тестовая база: ${SMOKE_DB}`);
console.log(withLive ? 'Режим: офлайн + живые проверки (--live)' : 'Режим: только офлайн (для живых проверок добавьте --live)');

const results = [];
for (const suite of suites) results.push(runSuite(suite));

const totalOk = results.reduce((sum, item) => sum + item.ok, 0);
const totalFail = results.reduce((sum, item) => sum + item.fail, 0);
const failedSuites = results.filter((item) => !item.passed);

console.log(`\n${'='.repeat(78)}`);
for (const item of results) {
  console.log(
    `[${item.passed ? 'OK  ' : 'FAIL'}] tests/${item.suite.file.padEnd(17)} ok=${String(item.ok).padStart(3)} fail=${item.fail} (${item.seconds} с)`,
  );
}
console.log('='.repeat(78));
console.log(`Выполнено наборов: ${results.length}, проверок: ${totalOk}`);
if (!withLive) {
  console.log('Живые проверки пропущены: запустите «npm run smoke:live».');
}
if (failedSuites.length > 0 || totalFail > 0) {
  console.log(`ПРОВАЛЕНО НАБОРОВ: ${failedSuites.length} -> ${failedSuites.map((item) => item.suite.file).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exitCode = 0;
}
