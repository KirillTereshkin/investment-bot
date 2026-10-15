import * as db from '../src/storage/db.js';
import * as config from '../src/config.js';

db.initDb();
const runId = db.saveRun({
  startedAt: config.nowMsk(),
  finishedAt: config.nowMsk(),
  sourcesStatus: [{ source: 'RBC News', status: 'error' }, { source: 'TASS', status: 'ok' }],
  deepseekStatus: 'ok',
  deepseekTokens: 1234,
  deepseekDurationMs: 5500,
  digest: 'строка дайджеста',
  rawResponse: '{"a":1}',
  parsedJson: { идеи: [{ инструмент: 'SBER' }] },
  signalPresent: true,
  tinkoffStatus: 'Портфель: 2 позиции',
  marketSnapshot: { moex_value: 3000 },
});
console.log('runId', runId);
const last = db.getLastRun();
console.log('last', last.id, last.started_at, last.signal_present, JSON.parse(last.parsed_json).идеи[0].инструмент);
const snapshotId = db.saveMarketSnapshot({
  capturedAt: config.nowMsk(),
  usdrub: 80.5,
  moexValue: 3000.1,
  keyRate: 16,
  sourceStatus: { usdrub: 'moex' },
});
console.log('snapshotId', snapshotId, db.getLastMarketSnapshot().usdrub);
db.cacheSet('figi:SBER', { ticker: 'SBER' });
console.log('cache', db.cacheGet('figi:SBER', 60), db.cacheGet('figi:SBER', 0));
db.cacheDelete('figi:SBER');
console.log('cache after delete', db.cacheGet('figi:SBER'));
const now = config.nowMsk();
const saved = db.savePredictions(runId, now, [
  {
    ticker: 'sber',
    direction: 'Лонг',
    confidence: 'высокая',
    horizon: '2-8 недель',
    entryPrice: 300,
    checkAt: new Date(now.getTime() - 86400000),
    instrument: 'Сбербанк',
  },
  { ticker: 'GAZP', direction: 'наблюдать', horizon: '1 месяц', entryPrice: null, checkAt: null },
]);
console.log('saved predictions', saved);
const due = db.getPredictionsDue(now, 10);
console.log('due', due.length, due[0] && due[0].ticker, due[0] && due[0].check_at);
db.updatePredictionResult(due[0].id, { priceAtCheck: 330, realizedDirection: 'рост', hit: 1 });
const stats = db.getPredictionStats(1);
console.log('stats', JSON.stringify({ total: stats.total, evaluated: stats.evaluated, hit: stats.hit, pending: stats.pending, by_ticker: stats.by_ticker }));
console.log('rows stats', JSON.stringify(db.getStats(1)));
console.log('OK');
