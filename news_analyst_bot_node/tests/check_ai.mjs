// Временная проверка ai/prompts.js и ai/client.js.
import path from 'node:path';
import dotenv from 'dotenv';

// Живой вызов DeepSeek — только если ключ есть в .env проекта.
// .env подхватывается ДО импорта config.js (в ESM импорты выполняются раньше тела модуля),
// поэтому модули подтягиваем динамически.
dotenv.config({ path: path.join(import.meta.dirname, '..', '.env'), quiet: true });
// Пробельное значение считаем отсутствующим: config.trim() превращает его в null,
// именно так smoke_test.js гасит ключи для оффлайн-наборов (DEEPSEEK_API_KEY=' ').
const envKey = () => String(process.env.DEEPSEEK_API_KEY ?? '').trim();
if (!envKey()) process.env.DEEPSEEK_API_KEY = 'test-dummy-key';

// Лог пишем в тестовую папку, чтобы не трогать bot.log рабочего запуска.
process.env.LOG_PATH = process.env.LOG_PATH || path.join(import.meta.dirname, '_smoke.log');

const config = await import('../src/config.js');
const prompts = await import('../src/ai/prompts.js');
const { DeepSeekApiError, DeepSeekClient, JsonError, describeError, extractJson } = await import('../src/ai/client.js');
const { FetchError } = await import('../src/http.js');
const liveKey = envKey() !== 'test-dummy-key';

const results = [];
function check(name, condition, extra = '') {
  results.push(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  return condition;
}

// --- extractJson -------------------------------------------------------------
check('extractJson простой JSON', extractJson('{"a":1}').a === 1);
check('extractJson ```json обёртка', extractJson('```json\n{"а":"б"}\n```').а === 'б');
check('extractJson ``` обёртка без слова json', extractJson('```\n{"x":[1,2]}\n```').x.length === 2);
check('extractJson текст вокруг JSON', extractJson('Вот прогноз: {"ok":true} — готово.').ok === true);
check(
  'extractJson массив → ошибка',
  (() => {
    try {
      extractJson('[1,2]');
      return false;
    } catch (e) {
      return e instanceof JsonError;
    }
  })(),
);
check(
  'extractJson пустая строка → ошибка',
  (() => {
    try {
      extractJson('');
      return false;
    } catch (e) {
      return e instanceof JsonError;
    }
  })(),
);
check(
  'extractJson мусор → ошибка',
  (() => {
    try {
      extractJson('нет json вовсе');
      return false;
    } catch (e) {
      return e instanceof JsonError;
    }
  })(),
);
check('extractJson битый JSON внутри скобок', (() => {
  try {
    extractJson('{oops}');
    return false;
  } catch (e) {
    return e instanceof SyntaxError;
  }
})());

// --- describeError ----------------------------------------------------------
check('describeError timeout', describeError(new FetchError('timeout')) === 'timeout');
check('describeError connection_error', describeError(new FetchError('connection_error', 'ECONN')) === 'connection_error');

// --- buildUserPrompt --------------------------------------------------------
const base = {
  windowStart: '01.10.2026 00:00',
  windowEnd: '15.10.2026 12:00',
  digest: '1) ЦБ снизил ставку до 14%',
  keyRate: 14.0,
  moexValue: 2395.26,
  moexChange: -1.08,
  usdrub: 83.9497,
};

const promptNoPortfolio = prompts.buildUserPrompt(base);
check(
  'prompt: окно и дайджест на месте',
  promptNoPortfolio.includes('01.10.2026 00:00–15.10.2026 12:00') && promptNoPortfolio.includes('1) ЦБ снизил ставку до 14%'),
);
check('prompt: н/д для отсутствующих курсов', promptNoPortfolio.includes('CNY/RUB н/д, EUR/RUB н/д'));
check('prompt: JSON_FORMAT_HINT в конце', promptNoPortfolio.endsWith(prompts.JSON_FORMAT_HINT));
check(
  'prompt: нет незаполненных плейсхолдеров',
  !/\{(window_start|window_end|digest|portfolio_block|key_rate|moex_value|moex_change|usdrub|cnyrub|eurrub)\}/.test(promptNoPortfolio),
);
check('prompt: без портфеля нет блока позиций', !promptNoPortfolio.includes('Мои открытые позиции'));

const promptWithPortfolio = prompts.buildUserPrompt({
  ...base,
  cnyrub: 12.5358,
  eurrub: 93.9229,
  portfolioText: 'Мои открытые позиции: SBER 10 шт (+2%)',
});
check('prompt: портфель вставлен', promptWithPortfolio.includes('\nМои открытые позиции: SBER 10 шт (+2%)\n'));
check('prompt: курсы подставлены', promptWithPortfolio.includes('CNY/RUB 12.5358, EUR/RUB 93.9229'));
check(
  'prompt: SYSTEM_PROMPT содержит требование JSON',
  prompts.SYSTEM_PROMPT.includes('"сигналов_нет": false') && prompts.SYSTEM_PROMPT.includes('строго JSON'),
);
check('prompt: SYSTEM_PROMPT начинается как в Python', prompts.SYSTEM_PROMPT.startsWith('\nТы — аналитик российского фондового рынка.'));

// --- DeepSeekClient со стабом fetch ----------------------------------------
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const capturedRequests = [];
const goodPayload = {
  choices: [{ message: { content: '```json\n{"резюме_рынка":"ставка снижена","идеи":[],"сигналов_нет":true}\n```' } }],
  usage: { total_tokens: 1234 },
};

const okClient = new DeepSeekClient({
  fetchImpl: async (url, init) => {
    capturedRequests.push({ url, init });
    return jsonResponse(goodPayload);
  },
});

const okResult = await okClient.analyze({ ...base, cnyrub: 12.5, eurrub: 93.9, portfolioText: '' });
check('analyze ok: статус', okResult.status === 'ok' && okResult.ok === true, okResult.status);
check('analyze ok: JSON разобран', okResult.parsed?.резюме_рынка === 'ставка снижена' && okResult.parsed.сигналов_нет === true);
check(
  'analyze ok: токены/длительность/попытки',
  okResult.tokens === 1234 && typeof okResult.duration_ms === 'number' && okResult.attempts === 1,
  `tokens=${okResult.tokens} ms=${okResult.duration_ms} attempts=${okResult.attempts}`,
);
check(
  'analyze ok: raw_response сохранён',
  typeof okResult.raw_response === 'string' && okResult.raw_response.includes('резюме_рынка'),
);

const req = capturedRequests[0];
const sentBody = JSON.parse(req.init.body);
check('запрос идёт на /chat/completions', req.url === 'https://api.deepseek.com/chat/completions', req.url);
check(
  'запрос: model/temperature/max_tokens',
  sentBody.model === 'deepseek-chat' && sentBody.temperature === 0.3 && sentBody.max_tokens === 1000,
);
check('запрос: response_format json_object', sentBody.response_format?.type === 'json_object');
check(
  'запрос: system+user сообщения',
  sentBody.messages.length === 2 && sentBody.messages[0].role === 'system' && sentBody.messages[1].role === 'user',
);
check('запрос: промпт содержит дайджест', sentBody.messages[1].content.includes('1) ЦБ снизил ставку до 14%'));
check('запрос: Authorization заголовок', String(req.init.headers.Authorization).startsWith('Bearer '));

check('describeError http_500 из FetchError', describeError(new FetchError('http_500')) === 'http_500');
check('describeError auth_error', describeError(new DeepSeekApiError('auth_error')) === 'auth_error');
check('describeError rate_limit', describeError(new DeepSeekApiError('rate_limit')) === 'rate_limit');
check('describeError invalid_json (JsonError)', describeError(new JsonError('')) === 'invalid_json');
check('describeError unknown', describeError(new TypeError('x')) === 'unknown_error');


// 500 на первой попытке и ok на второй — проверяем ручной retry (пауза 5 сек).
let calls = 0;
const retryClient = new DeepSeekClient({
  fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: 'server' }, 500);
    return jsonResponse(goodPayload);
  },
});
const startedAt = Date.now();
const retryResult = await retryClient.analyze(base);
const elapsed = Date.now() - startedAt;
check('retry: успех со 2-й попытки', retryResult.status === 'ok' && retryResult.attempts === 2, `${retryResult.status} attempts=${retryResult.attempts}`);
check('retry: пауза DEEPSEEK_RETRY_DELAY_SEC выдержана', elapsed >= 4900, `${elapsed} мс`);
check('retry: число вызовов API', calls === 2, String(calls));

// 401 — исчерпание попыток и код ошибки.
let authCalls = 0;
const authClient = new DeepSeekClient({
  fetchImpl: async () => {
    authCalls += 1;
    return jsonResponse({ error: { message: 'Authentication Fails' } }, 401);
  },
});
const authResult = await authClient.analyze(base);
check('401: статус error:auth_error', authResult.status === 'error:auth_error' && authResult.error === 'auth_error', authResult.status);
check(
  '401: попыток всего DEEPSEEK_RETRIES+1',
  authCalls === config.DEEPSEEK_RETRIES + 1 && authResult.attempts === config.DEEPSEEK_RETRIES + 1,
  `calls=${authCalls} attempts=${authResult.attempts}`,
);
check('401: parsed отсутствует', authResult.parsed === null);

// Сетевой сбой → connection_error.
const netClient = new DeepSeekClient({
  fetchImpl: async () => {
    throw new TypeError('fetch failed');
  },
});
const netResult = await netClient.analyze(base);
check('сеть: error:connection_error', netResult.status === 'error:connection_error', netResult.status);

// Таймаут через короткий timeoutSec (AbortSignal.timeout — его таймер "unref",
// поэтому держим цикл событий своим таймером).
const timeoutClient = new DeepSeekClient({
  timeoutSec: 0.05,
  fetchImpl: (url, init) =>
    new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      });
    }),
});
const timeoutResult = await timeoutClient.analyze(base);
check('таймаут: error:timeout', timeoutResult.status === 'error:timeout', timeoutResult.status);

// Некорректный JSON от модели на всех попытках → invalid_json.
const badJsonClient = new DeepSeekClient({
  fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'извините, не могу' } }] }),
});
const badJsonResult = await badJsonClient.analyze(base);
check('битый JSON: error:invalid_json', badJsonResult.status === 'error:invalid_json', badJsonResult.status);
check('битый JSON: raw_response сохранён', badJsonResult.raw_response === 'извините, не могу');

// --- без API-ключа (отдельный процесс: config читает env при импорте) -------
const { execFileSync } = await import('node:child_process');
const { pathToFileURL } = await import('node:url');
// абсолютный URL клиента: дочерний процесс запускается не из папки tests
const clientUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'ai', 'client.js')).href;
const childCode = `
const { DeepSeekClient } = await import(${JSON.stringify(clientUrl)});
const r = await new DeepSeekClient().analyze({ digest: 'x', windowStart: 'a', windowEnd: 'b', keyRate: 1, moexValue: 1, moexChange: 0, usdrub: 1 });
process.stdout.write('RESULT:' + r.status + '|' + r.error + '|attempts=' + r.attempts);
`;
const childOut = execFileSync(process.execPath, ['--input-type=module', '-e', childCode], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, DEEPSEEK_API_KEY: '' },
  encoding: 'utf8',
});
check('без ключа: error:no_api_key, без вызовов API', childOut.includes('RESULT:error:no_api_key|no_api_key|attempts=0'), childOut.trim());

// --- живой вызов DeepSeek ---------------------------------------------------
console.log('\n--- живой вызов DeepSeek ---');
console.log('ключ из .env найден:', liveKey);
if (liveKey) {
  const liveClient = new DeepSeekClient();
  const live = await liveClient.analyze({
    windowStart: '01.10.2026 00:00',
    windowEnd: '15.10.2026 12:00',
    digest: '1) ЦБ РФ снизил ключевую ставку до 14% годовых.\n2) Brent вырос до 78 долларов за баррель.',
    keyRate: 14.0,
    moexValue: 2395.26,
    moexChange: -1.08,
    usdrub: 83.95,
    cnyrub: 12.54,
    eurrub: 93.92,
    portfolioText: 'Мои открытые позиции: SBER 10 шт (+2.1%), GAZP 50 шт (-3.9%)',
  });
  console.log('status:', live.status, '| attempts:', live.attempts, '| tokens:', live.tokens, '| ms:', live.duration_ms);
  console.log('parsed:', JSON.stringify(live.parsed, null, 2));
  check('живой вызов DeepSeek: ok', live.status === 'ok', live.status);
  check('живой вызов: ключи прогноза на месте', Boolean(live.parsed && ('идеи' in live.parsed || 'резюме_рынка' in live.parsed)));
  await liveClient.close();
} else {
  console.log('DEEPSEEK_API_KEY не найден — живой вызов пропущен');
}

await okClient.close();
console.log('\n' + results.join('\n'));
console.log(`\nИтого: ${results.filter((r) => r.startsWith('OK')).length}/${results.length} проверок пройдено`);
