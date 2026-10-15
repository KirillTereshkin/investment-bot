// Временная проверка market/quotes.js: офлайн-разбор + живой опрос источников.
import * as config from '../src/config.js';
import * as db from '../src/storage/db.js';
import * as quotes from '../src/market/quotes.js';

const results = [];
function check(name, condition, extra = '') {
  results.push(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  return condition;
}

// --- офлайн-проверки ---------------------------------------------------------
check('toFloat 14,00', quotes.toFloat('14,00') === 14);
check('toFloat nbsp 1 234,5', quotes.toFloat('1 234,5') === 1234.5, String(quotes.toFloat('1 234,5')));
check('toFloat -0.92%', quotes.toFloat('-0.92%') === -0.92);
check('toFloat null', quotes.toFloat(null) === null);

const cbrDate = quotes.parseCbrDate('15.10.2026');
check('parseCbrDate МСК', config.mskParts(cbrDate).year === 2026 && config.mskParts(cbrDate).day === 15);
check('parseCbrDate мусор', quotes.parseCbrDate('не дата') === null);
check('parseCbrDate 31.02', quotes.parseCbrDate('31.02.2026') === null);

check('extractTicker SBER', quotes.extractTicker('SBER') === 'SBER');
check('extractTicker GAZP (ао)', quotes.extractTicker('GAZP (ао)') === 'GAZP');
check('extractTicker ОФЗ 26238', quotes.extractTicker('ОФЗ 26238') === null);
check('extractTicker CNY/RUB', quotes.extractTicker('CNY/RUB') === null);
check('extractTicker SBER.', quotes.extractTicker('sber.') === 'SBER');

const xmlAttrs = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Name="Ключевая ставка">
  <Record Date="01.01.2024" Rate="16.00"/>
  <Record Date="15.10.2026" Rate="14.00"/>
  <Record Date="01.06.2025" Rate="21.00"/>
</ValCurs>`;
check('parseKeyRateXml атрибуты → свежая дата', quotes.parseKeyRateXml(xmlAttrs) === 14, String(quotes.parseKeyRateXml(xmlAttrs)));

const xmlNested = `<ValCurs><Record><Date>01.01.2024</Date><Rate>16,00</Rate></Record><Record><Date>15.10.2026</Date><Rate>14,50</Rate></Record></ValCurs>`;
check('parseKeyRateXml вложенные узлы', quotes.parseKeyRateXml(xmlNested) === 14.5, String(quotes.parseKeyRateXml(xmlNested)));
check('parseKeyRateXml HTML вместо XML', quotes.parseKeyRateXml('<html><body>нет xml</body></html>') === null);

const htmlTable = `<html><body><table class="data">
<tr><th>Дата</th><th>Ставка</th></tr>
<tr><td>15.10.2026</td><td>14,00</td></tr>
<tr><td>01.06.2025</td><td>21,00</td></tr>
</table></body></html>`;
check('parseKeyRateHtml', quotes.parseKeyRateHtml(htmlTable) === 14, String(quotes.parseKeyRateHtml(htmlTable)));
check('parseKeyRateHtml без таблицы', quotes.parseKeyRateHtml('<html><body>пусто</body></html>') === null);

// --- снимок из заглушки + SQLite -------------------------------------------
db.initDb();

const stubLive = () => ({
  rates: { usdrub: 80.1234, cnyrub: 11.05, eurrub: 93.5 },
  rates_error: null,
  moex: { moex_value: 2750.5, moex_change: -0.42 },
  moex_error: null,
  key_rate: 14.25,
  key_rate_source: 'html',
  key_rate_error: null,
});

const snapshotA = await quotes.buildSnapshot({ fetchLive: stubLive });
check('snapshot: значения из живого опроса', snapshotA.value('moex_value') === 2750.5 && snapshotA.value('key_rate') === 14.25);
check('snapshot: статусы ok', snapshotA.source_status.cbr_rates === 'ok' && snapshotA.source_status.moex_index === 'ok' && snapshotA.source_status.key_rate === 'ok:html',
  JSON.stringify(snapshotA.source_status));
check('snapshot: нет fallback', snapshotA.fallback_values.length === 0, JSON.stringify(snapshotA.fallback_values));

// Источник курсов «упал» — значения должны подтянуться из SQLite (stale).
const snapshotB = await quotes.buildSnapshot({
  fetchLive: () => ({ rates: null, rates_error: 'http_500', moex: null, moex_error: 'timeout', key_rate: null, key_rate_error: 'unavailable' }),
});
check('snapshot: курсы взяты из SQLite', snapshotB.usdrub === 80.1234 && snapshotB.stale_values.includes('usdrub'), JSON.stringify(snapshotB.stale_values));
check('snapshot: индекс со снимка SQLite', snapshotB.value('moex_value') === 2750.5);
check('snapshot: ставка из кэша', snapshotB.key_rate === 14.25 && snapshotB.source_status.key_rate === 'cache', snapshotB.source_status.key_rate);
check('snapshot: ошибки источников в статусах', snapshotB.source_status.cbr_rates === 'error:http_500' && snapshotB.source_status.moex_index === 'error:timeout');

const lastRow = db.getLastMarketSnapshot();
check('SQLite: снимок записан', Boolean(lastRow) && lastRow.key_rate === 14.25, JSON.stringify(lastRow));
check('SQLite: source_status — JSON', typeof lastRow.source_status === 'string' && JSON.parse(lastRow.source_status).cbr_rates === 'error:http_500');
check('snapshot.asRow формат', quotes.buildSnapshot !== undefined && typeof snapshotA.asRow().moex_change_pct === 'number');

// --- живой опрос ------------------------------------------------------------
console.log('\n--- живой опрос источников ---');
const live = await quotes.fetchLiveQuotes();
console.log('rates:', JSON.stringify(live.rates), 'error:', live.rates_error);
console.log('moex:', JSON.stringify(live.moex), 'error:', live.moex_error);
console.log('key_rate:', live.key_rate, 'source:', live.key_rate_source, 'error:', live.key_rate_error);
const sber = await quotes.fetchTickerPrice('SBER');
console.log('SBER price:', sber);

quotes.resetCache();
const liveSnapshot = await quotes.getSnapshot(true);
console.log('log_line:', liveSnapshot.logLine());
console.log('as_row:', JSON.stringify(liveSnapshot.asRow()));

db.closeDb();
console.log('\n' + results.join('\n'));
console.log(`\nИтого: ${results.filter((r) => r.startsWith('OK')).length}/${results.length} офлайн-проверок пройдено`);
