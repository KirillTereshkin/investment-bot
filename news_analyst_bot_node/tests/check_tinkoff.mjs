/**
 * Оффлайн-проверки порта broker/tinkoff.py → src/broker/tinkoff.js
 * (+ опциональный живой вызов REST T-Invest API, если в .env есть токен).
 *
 * Запуск: node check_tinkoff.mjs
 */
process.env.TINKOFF_RETRY_DELAY_SEC = '0'; // тесты не ждут пауз между повторами

const path = (await import('node:path')).default;
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(import.meta.dirname, '..', '.env'), quiet: true });

const tinkoff = await import('../src/broker/tinkoff.js');
const config = await import('../src/config.js');
const db = await import('../src/storage/db.js');

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log('OK  ', name, extra);
  } else {
    failed += 1;
    console.log('FAIL', name, extra);
  }
}

function eq(name, actual, expected) {
  const shown = actual === expected ? '' : ` (ожидалось ${expected})`;
  check(name, actual === expected, `— ${String(actual)}${shown}`);
}

function near(name, actual, expected, eps = 1e-6) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) < eps;
  check(name, ok, `— ${actual}${ok ? '' : ` (ожидалось ${expected})`}`);
}

/** Мини-Response, достаточный для responseText(). */
function jsonResponse(status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const TOKEN = 'tst-token';

/** fetch-заглушка: URL → ответ (объект Response или функция) + журнал вызовов. */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : routes['*'];
    if (typeof route === 'function') return route(url, options, calls);
    if (route === undefined) throw new Error(`неожиданный URL: ${url}`);
    return route;
  };
  return { fetchImpl, calls };
}

/** Портфель как отвечает REST: int64 строками, units/nano, camelCase. */
const PORTFOLIO_OK = {
  totalPortfolioValue: { units: '45230', nano: 0 },
  positions: [
    {
      figi: 'BBG004730N88',
      instrumentUid: 'uid-sber',
      instrumentType: 'share',
      ticker: 'SBER',
      name: 'Сбербанк',
      quantity: { units: '100', nano: 0 },
      averagePositionPrice: { units: '285', nano: 500000000, currency: 'rub' },
      currentPrice: { units: '292', nano: 300000000 },
    },
    {
      figi: 'BBG004730RP0',
      instrumentUid: 'uid-gazp',
      instrumentType: 'share',
      ticker: 'GAZP',
      name: 'Газпром',
      quantity: { units: '50', nano: 0 },
      averagePositionPrice: { units: '100', nano: 0, currency: 'rub' },
      currentPrice: { units: '96', nano: 100000000 },
    },
    {
      // нет тикера — должен быть запрос InstrumentsService/GetInstrumentBy
      figi: 'BBG00475KKY8',
      instrumentUid: 'uid-lkoh',
      instrumentType: 'share',
      quantity: { units: '3', nano: 0 },
      averagePositionPrice: { units: '7000', nano: 0, currency: 'rub' },
      currentPrice: { units: '7100', nano: 0 },
    },
    {
      // нулевая позиция — пропускается
      figi: 'BBG00X1NV4X8',
      instrumentType: 'etf',
      ticker: 'TBRU',
      quantity: { units: '0', nano: 0 },
    },
    {
      // ни FIGI, ни UID — пропускается
      instrumentType: 'share',
      ticker: 'XXX',
      quantity: { units: '5', nano: 0 },
    },
  ],
};

const ACCOUNTS_OK = {
  accounts: [
    {
      id: '2001',
      type: 'ACCOUNT_TYPE_TINKOFF_IIS',
      name: 'ИИС',
      status: 'ACCOUNT_STATUS_OPEN',
      accessLevel: 'ACCOUNT_ACCESS_LEVEL_READ_ONLY',
    },
    {
      id: '2002',
      type: 'ACCOUNT_TYPE_TINKOFF',
      name: 'Брокерский',
      status: 'ACCOUNT_STATUS_OPEN',
      accessLevel: 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS',
    },
  ],
};

console.log('--- вспомогательные функции ---');
eq('field: camelCase', tinkoff.field({ totalPortfolioValue: 5 }, 'totalPortfolioValue'), 5);
eq(
  'field: snake_case',
  tinkoff.field({ total_portfolio_value: 7 }, ['totalPortfolioValue', 'total_portfolio_value']),
  7,
);
eq('field: default', tinkoff.field({}, 'missing', 'нет'), 'нет');
eq('field: 0 — значение, не default', tinkoff.field({ units: 0 }, 'units', 'нет'), 0);
eq('field: пустая строка — значение', tinkoff.field({ ticker: '' }, 'ticker', 'нет'), '');
eq('field: null — берётся следующий синоним', tinkoff.field({ a: null, b: 3 }, ['a', 'b'], 'нет'), 3);
eq('field: null-источник', tinkoff.field(null, 'x', 'нет'), 'нет');

near('quotationToFloat: units+nano', tinkoff.quotationToFloat({ units: '100', nano: 500000000 }), 100.5);
near('quotationToFloat: строка units', tinkoff.quotationToFloat({ units: '100', nano: '0' }), 100);
near('quotationToFloat: отрицательное', tinkoff.quotationToFloat({ units: -1, nano: -500000000 }), -1.5);
eq('quotationToFloat: null', tinkoff.quotationToFloat(null), null);
near('quotationToFloat: строка', tinkoff.quotationToFloat('12.5'), 12.5);
eq('quotationToFloat: bool → null', tinkoff.quotationToFloat(true), null);
eq('quotationToFloat: пустой объект → null', tinkoff.quotationToFloat({}), null);
eq('safeFloat: мусор → null', tinkoff.safeFloat('abc'), null);

eq('formatQuantity: 100', tinkoff.formatQuantity(100), '100');
eq('formatQuantity: 12.5', tinkoff.formatQuantity(12.5), '12.5');
eq('formatQuantity: 0.0001', tinkoff.formatQuantity(0.0001), '0.0001');
eq('formatMoney: разряды', tinkoff.formatMoney(45230), '45 230 ₽');
eq('formatMoney: миллион', tinkoff.formatMoney(1234567.8), '1 234 568 ₽');
eq('formatMoney: null', tinkoff.formatMoney(null), '—');
eq('formatMoney: валюта usd', tinkoff.formatMoney(100, 'usd'), '100 $');
eq('pluralPositions: 1', tinkoff.pluralPositions(1), 'позиция');
eq('pluralPositions: 3', tinkoff.pluralPositions(3), 'позиции');
eq('pluralPositions: 5', tinkoff.pluralPositions(5), 'позиций');
eq('pluralPositions: 11', tinkoff.pluralPositions(11), 'позиций');
eq('pluralPositions: 21', tinkoff.pluralPositions(21), 'позиция');

console.log('--- Position ---');
const sber = new tinkoff.Position({
  figi: 'BBG004730N88',
  ticker: 'SBER',
  name: 'Сбербанк',
  instrumentType: 'share',
  quantity: 100,
  averagePrice: { units: '285', nano: 500000000 },
  currentPrice: { units: '292', nano: 300000000 },
});
near('Position.pnlPct', sber.pnlPct, 2.3824, 0.001);
near('Position.value', sber.value, 29230);
eq('Position.typeTitle (share)', sber.typeTitle, 'акция');
eq('Position.asPromptLine', sber.asPromptLine(), 'SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)');
eq(
  'Position.asTelegramLine',
  sber.asTelegramLine(),
  '• <b>SBER</b> — 100 шт, средняя 285.50 ₽ → 292.30 ₽ (+2.4%)',
);

const gazp = new tinkoff.Position({
  ticker: 'GAZP',
  quantity: 50,
  averagePrice: 100,
  currentPrice: 96.1,
  instrumentType: 'share',
});
eq('Position.asPromptLine: минус', gazp.asPromptLine(), 'GAZP: 50 шт, средняя 100.00 ₽, текущая 96.10 ₽ (-3.9%)');
eq('Position: дробное количество', new tinkoff.Position({ ticker: 'OFZ', quantity: 12.5 }).asPromptLine(), 'OFZ: 12.5 шт');
eq('Position: без цен нет PnL', new tinkoff.Position({ ticker: 'X', quantity: 1 }).pnlPct, null);
eq('Position: тип по умолчанию', new tinkoff.Position({ ticker: 'X' }).typeTitle, 'инструмент');
eq(
  'Position.toCacheDict: ключи snake_case',
  Object.keys(sber.toCacheDict()).join(','),
  'figi,ticker,name,instrument_type,quantity,average_price,current_price,currency',
);
near('Position: чтение из Python-кэша (snake_case)', new tinkoff.Position(sber.toCacheDict()).currentPrice, 292.3);

console.log('--- PortfolioSnapshot ---');
const okSnap = new tinkoff.PortfolioSnapshot({
  positions: [sber, gazp],
  totalValue: 34035,
  accountId: '2002',
  status: tinkoff.STATUS_OK,
});
eq('snapshot.ok', okSnap.ok, true);
eq('statusText: ok', okSnap.statusText(), '💼 Tinkoff: ok | 2 позиции, 34 035 ₽');
eq(
  'statusText: no_token',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_NO_TOKEN }).statusText(),
  '💼 Tinkoff: ⏭️ не настроен — TINKOFF_INVEST_TOKEN не задан',
);
eq(
  'statusText: library_missing',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_LIBRARY_MISSING }).statusText(),
  '💼 Tinkoff: ⏭️ SDK не установлен — он нужен только для TINKOFF_TRANSPORT=sdk (по умолчанию работает REST)',
);
eq(
  'statusText: token_expired',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_TOKEN_EXPIRED }).statusText(),
  '💼 Tinkoff: ❌ токен истёк, обновите TINKOFF_INVEST_TOKEN',
);
eq(
  'statusText: timeout',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_TIMEOUT }).statusText(),
  '💼 Tinkoff: ❌ timeout — прогноз без учёта позиций',
);
eq(
  'statusText: rate_limited',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_RATE_LIMITED }).statusText(),
  '💼 Tinkoff: ⏳ лимит запросов к API (429) — прогноз без учёта позиций',
);
eq(
  'statusText: error',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_ERROR, error: 'сеть' }).statusText(),
  '💼 Tinkoff: ❌ ошибка — сеть — прогноз без учёта позиций',
);

const expectedPrompt = [
  'Мои открытые позиции:',
  '- SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)',
  '- GAZP: 50 шт, средняя 100.00 ₽, текущая 96.10 ₽ (-3.9%)',
  '',
  'Общая стоимость портфеля: 34 035 ₽',
].join('\n');
eq('promptText: блок позиций', okSnap.promptText(), expectedPrompt);
eq(
  'promptText: без позиций пусто',
  new tinkoff.PortfolioSnapshot({ status: tinkoff.STATUS_OK, totalValue: 100 }).promptText(),
  '',
);
eq(
  'promptText: при ошибке пусто',
  new tinkoff.PortfolioSnapshot({ positions: [sber], status: tinkoff.STATUS_ERROR }).promptText(),
  '',
);

const payload = okSnap.asCachePayload();
eq('cache payload: ключи', Object.keys(payload).join(','), 'positions,total_value,account_id');
eq('cache payload: позиций', payload.positions.length, 2);
const restored = tinkoff.PortfolioSnapshot.fromCachePayload(payload);
eq('fromCachePayload: позиций', restored.positions.length, 2);
eq('fromCachePayload: тикер', restored.positions[0].ticker, 'SBER');
eq('fromCachePayload: totalValue', restored.totalValue, 34035);
eq('fromCachePayload: account_id', restored.accountId, '2002');
eq('fromCachePayload: статус ok', restored.status, tinkoff.STATUS_OK);
eq('fromCachePayload: промпт совпадает', restored.promptText(), expectedPrompt);
eq('fromCachePayload: null → null', tinkoff.PortfolioSnapshot.fromCachePayload(null), null);
eq('fromCachePayload: строка → null', tinkoff.PortfolioSnapshot.fromCachePayload('x'), null);
const pythonCache = {
  positions: [
    {
      figi: 'F',
      ticker: 'VTBR',
      name: 'ВТБ',
      instrument_type: 'share',
      quantity: 10,
      average_price: 0.02,
      current_price: 0.025,
      currency: 'rub',
    },
  ],
  total_value: 0.25,
  account_id: '2002',
};
const fromPython = tinkoff.PortfolioSnapshot.fromCachePayload(pythonCache);
eq('fromCachePayload: Python-запись читается', fromPython.positions[0].ticker, 'VTBR');
eq('fromCachePayload: Python-запись, тип', fromPython.positions[0].typeTitle, 'акция');
eq('fromCachePayload: Python-запись, строка', fromPython.positions[0].asPromptLine(), 'VTBR: 10 шт, средняя 0.02 ₽, текущая 0.03 ₽ (+25.0%)');
eq(
  'fromCachePayload: битые записи пропускаются',
  tinkoff.PortfolioSnapshot.fromCachePayload({ positions: [1, null, { figi: 'F', ticker: 'T' }] }).positions
    .length,
  1,
);

console.log('--- Счета ---');
const firstAccount = tinkoff.parseAccount(ACCOUNTS_OK.accounts[0]);
eq('parseAccount: id', firstAccount.id, '2001');
eq('parseAccount: accessLevel', firstAccount.accessLevel, 'ACCOUNT_ACCESS_LEVEL_READ_ONLY');
eq('parseAccount: type', firstAccount.type, 'ACCOUNT_TYPE_TINKOFF_IIS');
eq('parseAccount: без id → null', tinkoff.parseAccount({ name: 'x' }), null);
eq('parseAccount: мусор → null', tinkoff.parseAccount(null), null);
const parsedAccounts = ACCOUNTS_OK.accounts.map((raw) => tinkoff.parseAccount(raw));
eq('pickAccount: брокерский (не ИИС)', tinkoff.pickAccount(parsedAccounts).id, '2002');
eq('pickAccount: TINKOFF_ACCOUNT_ID в приоритете', tinkoff.pickAccount(parsedAccounts, '2001').id, '2001');
eq(
  'pickAccount: неизвестный TINKOFF_ACCOUNT_ID → брокерский',
  tinkoff.pickAccount(parsedAccounts, '9999').id,
  '2002',
);
eq(
  'pickAccount: закрытые счета — берём первый',
  tinkoff
    .pickAccount([
      new tinkoff.AccountInfo({ id: '3', type: 'ACCOUNT_TYPE_TINKOFF', status: 'ACCOUNT_STATUS_CLOSED' }),
    ])
    .id,
  '3',
);
let pickError = null;
try {
  tinkoff.pickAccount([]);
} catch (exc) {
  pickError = exc;
}
check(
  'pickAccount: пустой список → TinkoffUnavailable',
  pickError instanceof tinkoff.TinkoffUnavailable && pickError.status === tinkoff.STATUS_ERROR,
  `— ${pickError && pickError.reason}`,
);

console.log('--- REST-транспорт на fetch-заглушке ---');
const accountsUrl = `https://stub.example${tinkoff.REST_API_PREFIX}UsersService/GetAccounts`;
const portfolioUrl = `https://stub.example${tinkoff.REST_API_PREFIX}OperationsService/GetPortfolio`;
const instrumentUrl = `https://stub.example${tinkoff.REST_API_PREFIX}InstrumentsService/GetInstrumentBy`;
const okFetch = makeFetch({
  [accountsUrl]: jsonResponse(200, ACCOUNTS_OK),
  [portfolioUrl]: jsonResponse(200, PORTFOLIO_OK),
  [instrumentUrl]: jsonResponse(200, {
    instrument: { figi: 'BBG00475KKY8', ticker: 'LKOH', name: 'Лукойл' },
  }),
});

db.initDb();
db.cacheDelete(tinkoff.CACHE_KEY_PORTFOLIO);
db.cacheDelete(tinkoff.CACHE_KEY_FIGI_MAP);

const transport = new tinkoff.RestTransport(TOKEN, 'https://stub.example', {
  fetchImpl: okFetch.fetchImpl,
});
const client = new tinkoff.TinkoffPortfolioClient('token-from-test', transport);
const snap = await client.getPortfolioSnapshot({ force: true });

eq('портфель: статус ok', snap.status, tinkoff.STATUS_OK);
eq('портфель: счет выбран брокерский', snap.accountId, '2002');
eq('портфель: число позиций (нулевые и без FIGI отброшены)', snap.positions.length, 3);
eq('портфель: тикеры', snap.positions.map((p) => p.ticker).join(','), 'SBER,GAZP,LKOH');
eq('портфель: тикер по FIGI через GetInstrumentBy', snap.positions[2].name, 'Лукойл');
near('портфель: средняя цена SBER', snap.positions[0].averagePrice, 285.5);
near('портфель: текущая цена SBER', snap.positions[0].currentPrice, 292.3);
near('портфель: totalPortfolioValue', snap.totalValue, 45230);
eq('портфель: статус-строка', snap.statusText(), '💼 Tinkoff: ok | 3 позиции, 45 230 ₽');
eq('портфель: строка промпта SBER', snap.positions[0].asPromptLine(), 'SBER: 100 шт, средняя 285.50 ₽, текущая 292.30 ₽ (+2.4%)');

eq('REST: три запроса', okFetch.calls.length, 3);
eq('REST: URL аккаунтов', okFetch.calls[0].url, accountsUrl);
eq('REST: Authorization', okFetch.calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
eq('REST: тело GetPortfolio', okFetch.calls[1].options.body, JSON.stringify({ accountId: '2002', currency: 'RUB' }));
eq(
  'REST: тело GetInstrumentBy (FIGI)',
  okFetch.calls[2].options.body,
  JSON.stringify({ idType: tinkoff.REST_ID_TYPE_FIGI, id: 'BBG00475KKY8' }),
);

const figiMap = db.cacheGet(tinkoff.CACHE_KEY_FIGI_MAP, config.TINKOFF_FIGI_CACHE_TTL_SEC);
eq('кэш: FIGI→тикер записан', figiMap.BBG00475KKY8.ticker, 'LKOH');
const cachedPortfolio = db.cacheGet(tinkoff.CACHE_KEY_PORTFOLIO, config.TINKOFF_POSITIONS_CACHE_TTL_SEC);
eq('кэш: портфель записан', cachedPortfolio.positions.length, 3);
eq('кэш: ключи позиции snake_case', Object.keys(cachedPortfolio.positions[0]).join(','), 'figi,ticker,name,instrument_type,quantity,average_price,current_price,currency');
eq('кэш: total_value', cachedPortfolio.total_value, 45230);

console.log('--- Обработка ошибок API ---');
const retries = config.TINKOFF_RETRIES;

const err401 = makeFetch({ '*': jsonResponse(401, { code: 16, description: '40003' }) });
const snap401 = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://stub-401.example', { fetchImpl: err401.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('401/40003 → token_expired', snap401.status, tinkoff.STATUS_TOKEN_EXPIRED);
eq('401: без повторов (одна попытка)', err401.calls.length, 1);
eq('token_expired: ok = false', snap401.ok, false);
eq('token_expired: пустой промпт', snap401.promptText(), '');
eq(
  'token_expired: текст',
  snap401.statusText(),
  '💼 Tinkoff: ❌ токен истёк, обновите TINKOFF_INVEST_TOKEN',
);

const err429 = makeFetch({ '*': jsonResponse(429, { message: 'RESOURCE_EXHAUSTED' }) });
const snap429 = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://stub-429.example', { fetchImpl: err429.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('429 → rate_limited', snap429.status, tinkoff.STATUS_RATE_LIMITED);
eq('429: попыток = TINKOFF_RETRIES + 1', err429.calls.length, retries + 1);

const err500 = makeFetch({ '*': jsonResponse(500, { message: 'internal' }) });
const snap500 = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://stub-500.example', { fetchImpl: err500.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('500 → error', snap500.status, tinkoff.STATUS_ERROR);
eq('500: попыток = TINKOFF_RETRIES + 1', err500.calls.length, retries + 1);
eq(
  '500: текст',
  snap500.statusText(),
  '💼 Tinkoff: ❌ ошибка — HTTP 500 — сервис недоступен — прогноз без учёта позиций',
);

const timeouts = makeFetch({
  '*': () => {
    const exc = new Error('timed out');
    exc.name = 'TimeoutError';
    throw exc;
  },
});
const snapTimeout = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://stub-timeout.example', { fetchImpl: timeouts.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('timeout → STATUS_TIMEOUT', snapTimeout.status, tinkoff.STATUS_TIMEOUT);
eq('timeout: попыток = TINKOFF_RETRIES + 1', timeouts.calls.length, retries + 1);
eq(
  'timeout: текст',
  snapTimeout.statusText(),
  '💼 Tinkoff: ❌ timeout — прогноз без учёта позиций',
);

const badJson = makeFetch({ '*': jsonResponse(200, 'не json') });
const snapBadJson = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://stub-json.example', { fetchImpl: badJson.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('некорректный JSON → error', snapBadJson.status, tinkoff.STATUS_ERROR);
check(
  'некорректный JSON: причина понятна',
  String(snapBadJson.error).includes('JSON'),
  `— ${snapBadJson.error}`,
);

console.log('--- Резервный хост ---');
const failoverCalls = [];
const failoverFetch = async (url) => {
  failoverCalls.push(url);
  if (url.startsWith('https://bad.example')) throw new Error('ECONNREFUSED');
  if (url.includes('GetAccounts')) return jsonResponse(200, ACCOUNTS_OK);
  if (url.includes('GetPortfolio')) return jsonResponse(200, PORTFOLIO_OK);
  return jsonResponse(200, { instrument: { figi: 'BBG00475KKY8', ticker: 'LKOH', name: 'Лукойл' } });
};
const failoverTransport = new tinkoff.RestTransport(
  TOKEN,
  ['https://bad.example', 'https://good.example'],
  { fetchImpl: failoverFetch },
);
const failoverSnap = await new tinkoff.TinkoffPortfolioClient('tok', failoverTransport).getPortfolioSnapshot(
  { force: true },
);
eq('failover: портфель получен с резервного хоста', failoverSnap.status, tinkoff.STATUS_OK);
eq('failover: позиции на месте', failoverSnap.positions.length, 3);
eq('failover: сбойный хост ушёл в конец списка', failoverTransport._baseUrls[0], 'https://good.example');
eq(
  'failover: в упавший хост стучались один раз',
  failoverCalls.filter((url) => url.startsWith('https://bad.example')).length,
  1,
);
check('failover: первый запрос — на основной хост', failoverCalls[0].startsWith('https://bad.example'));

console.log('--- Кэш SQLite и публичный API модуля ---');
const deadFetch = makeFetch({
  '*': () => {
    throw new Error('нет сети');
  },
});
const cachedSnap = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://dead.example', { fetchImpl: deadFetch.fetchImpl }),
).getPortfolioSnapshot();
eq('кэш: свежий снимок отдан из SQLite', cachedSnap.status, tinkoff.STATUS_OK);
eq('кэш: позиций из кэша', cachedSnap.positions.length, 3);
eq('кэш: обращений к API не было', deadFetch.calls.length, 0);
eq('кэш: тикер из кэша', cachedSnap.positions.map((p) => p.ticker).join(','), 'SBER,GAZP,LKOH');

const deadFetch2 = makeFetch({
  '*': () => {
    throw new Error('нет сети');
  },
});
const forcedSnap = await new tinkoff.TinkoffPortfolioClient(
  'tok',
  new tinkoff.RestTransport(TOKEN, 'https://dead2.example', { fetchImpl: deadFetch2.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('force: сетевой сбой → error', forcedSnap.status, tinkoff.STATUS_ERROR);
eq('force: сеть недоступна после всех повторов', deadFetch2.calls.length, retries + 1);

const noTokenFetch = makeFetch({
  '*': () => {
    throw new Error('не должен вызываться');
  },
});
const noTokenSnap = await new tinkoff.TinkoffPortfolioClient(
  '',
  new tinkoff.RestTransport(TOKEN, 'https://never.example', { fetchImpl: noTokenFetch.fetchImpl }),
).getPortfolioSnapshot({ force: true });
eq('без токена: статус no_token', noTokenSnap.status, tinkoff.STATUS_NO_TOKEN);
eq('без токена: запросов нет', noTokenFetch.calls.length, 0);
eq(
  'без токена: текст',
  noTokenSnap.statusText(),
  '💼 Tinkoff: ⏭️ не настроен — TINKOFF_INVEST_TOKEN не задан',
);

eq('buildTransport: по умолчанию REST', tinkoff.buildTransport('t.test').name, 'rest');
const sdkSnap = await new tinkoff.TinkoffPortfolioClient('t', new tinkoff.SdkTransport('t')).getPortfolioSnapshot(
  { force: true },
);
eq('SDK не установлен → library_missing', sdkSnap.status, tinkoff.STATUS_LIBRARY_MISSING);
check(
  'library_missing: текст из Python-версии',
  sdkSnap.statusText().includes('SDK не установлен'),
  `— ${sdkSnap.statusText()}`,
);

console.log('--- Публичный API модуля: getClient / getPortfolio ---');
const clientA = tinkoff.getClient();
check('getClient: клиент кэшируется', clientA === tinkoff.getClient());
check(
  'getClient: клиент знает токен из config',
  clientA.token === config.TINKOFF_INVEST_TOKEN,
  `— ${JSON.stringify(clientA.token)}`,
);
tinkoff.resetClient();
check('resetClient: клиент пересоздан', clientA !== tinkoff.getClient());

// getPortfolio() — алиас getPortfolioSnapshot(): клиент берётся из
// config.TINKOFF_INVEST_TOKEN. В Python-тесте токен подменялся в рантайме
// (config — модуль), в Node config неизменяем, поэтому проверяем алиас на
// реальном окружении: с токеном он обязан отдать снимок из кэша SQLite,
// без токена — статус no_token (сеть не трогаем).
const aliasSnap = await tinkoff.getPortfolio();
if (config.TINKOFF_INVEST_TOKEN) {
  check(
    'getPortfolio(): алиас читает кэш SQLite',
    aliasSnap.status === tinkoff.STATUS_OK,
    `— ${aliasSnap.statusText()}`,
  );
  eq('getPortfolio(): то же содержимое', aliasSnap.positions.length, 3);
} else {
  check(
    'getPortfolio(): без токена в окружении → no_token',
    aliasSnap.status === tinkoff.STATUS_NO_TOKEN,
    `— ${aliasSnap.statusText()}`,
  );
  eq(
    'getPortfolio(): текст про отсутствующий токен',
    aliasSnap.statusText(),
    '💼 Tinkoff: ⏭️ не настроен — TINKOFF_INVEST_TOKEN не задан',
  );
}

console.log('--- Живой вызов T-Invest API (если задан токен) ---');
if (config.TINKOFF_INVEST_TOKEN) {
  const live = await tinkoff.getPortfolioSnapshot({ force: true });
  console.log('     статус:', live.status, '|', live.statusText());
  check(
    'live: ответ получен без исключений',
    typeof live.status === 'string' && live.status.length > 0,
    `— ${live.status}`,
  );
  if (live.status === tinkoff.STATUS_OK) {
    console.log('     счет:', live.accountId, '| позиций:', live.positions.length, '| стоимость:', live.totalValue);
    for (const position of live.positions.slice(0, 5)) console.log('     ', position.asTelegramLine());
    check(
      'live: снимок ok',
      live.ok === true && live.positions.every((p) => typeof p.ticker === 'string' && p.ticker.length > 0),
    );
  } else {
    console.log('     (для ok-проверки нужен действующий read-only токен)');
  }
} else {
  console.log('     SKIP — TINKOFF_INVEST_TOKEN не задан в .env');
}

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
db.closeDb();
process.exitCode = failed ? 1 : 0;
