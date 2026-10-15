import * as config from '../src/config.js';
import * as collector from '../src/news/collector.js';
import { deduplicate, normalizeTitle, jaccardSimilarity } from '../src/news/dedup.js';
import * as horizon from '../src/predictions/horizon.js';

console.log('clean:', collector.cleanText('<p>Привет&nbsp;&amp; пока</p>'));
console.log('sentence:', collector.firstSentence('Первое предложение. Второе предложение про рынок.'));
console.log('sentence2:', collector.firstSentence('Очень длинный текст без точек '.repeat(20)));
console.log('long:', collector.firstSentence('A'.repeat(100) + '. Второе.'));
console.log('date rfc:', collector.parseFeedDate('Tue, 15 Oct 2026 14:00:00 +0300'), config.mskIso(new Date(collector.parseFeedDate('Tue, 15 Oct 2026 14:00:00 +0300') * 1000)));
console.log('date iso:', collector.parseFeedDate('2026-10-15T14:00:00+03:00'), collector.parseFeedDate('2026-10-15T11:00:00Z'));
console.log('date gmt:', collector.parseFeedDate('Thu, 15 Oct 2026 11:00:00 GMT'));
console.log('date naive:', collector.parseFeedDate('2026-10-15 11:00:00'));
console.log('date bad:', collector.parseFeedDate('вчера'));

const rss = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>T</title>
<item><title>ЦБ сохранил ставку</title><link>https://a/1</link><pubDate>Tue, 15 Oct 2026 12:00:00 +0300</pubDate><description><![CDATA[<p>Совет директоров &amp; ставка 16%.</p>]]></description></item>
<item><title>Без даты</title><link>https://a/2</link></item>
<item><title>Старое</title><link>https://a/3</link><pubDate>Mon, 01 Sep 2025 12:00:00 +0300</pubDate></item>
</channel></rss>`;
const bytes = new TextEncoder().encode(rss);
const start = Date.parse('2026-10-15T00:00:00+03:00') / 1000;
const end = Date.parse('2026-10-15T23:00:00+03:00') / 1000;
const parsed = collector.parseFeed('Test', 'https://test/rss', bytes, start, end);
console.log('parsed:', JSON.stringify(parsed, null, 1));

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
<entry><title>Рынок вырос</title><link rel="alternate" href="https://b/1"/><updated>2026-10-15T15:30:00+03:00</updated><summary>Индекс Мосбиржи прибавил 1,2%.</summary></entry></feed>`;
console.log('atom:', JSON.stringify(collector.parseFeed('Atom', 'https://b/rss', new TextEncoder().encode(atom), start, end).items, null, 1));

const rdf = `<?xml version="1.0" encoding="windows-1251"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>RDF</title></channel>
<item><title>Газпром отчитался</title><link>https://c/1</link><dc:date>2026-10-15T16:00:00+03:00</dc:date><description>Прибыль выросла.</description></item></rdf:RDF>`;
console.log('rdf:', JSON.stringify(collector.parseFeed('RDF', 'https://c/rss', new TextEncoder().encode(rdf), start, end).items, null, 1));

console.log('empty:', JSON.stringify(collector.parseFeed('X', 'u', new TextEncoder().encode('   '), start, end)));
console.log('broken:', JSON.stringify(collector.parseFeed('X', 'u', new TextEncoder().encode('<rss><channel><item><title>a'), start, end)));

const [unique, dropped] = deduplicate([
  { title: 'ЦБ сохранил ключевую ставку на уровне 16%' },
  { title: 'ЦБ сохранил ключевую ставку на уровне 16 процентов' },
  { title: 'Газпром отчитался за третий квартал' },
  { title: '   ' },
]);
console.log('dedup:', unique.length, dropped, unique.map((i) => i.title));
console.log('norm:', normalizeTitle('ЦБ: «ставка» — 16%!'), jaccardSimilarity(new Set(['а', 'б']), new Set(['а', 'в'])));

console.log('digest:', JSON.stringify(
  collector.buildDigest(
    [
      { source: 'A', title: 'Раз', summary: 'Первое. Второе.' },
      { source: 'B', title: 'Два', summary: '' },
      { source: 'A', title: 'Три', summary: 'Текст' },
    ],
    3,
  ),
));

const now = config.nowMsk();
console.log('horizon days:', horizon.parseHorizonDays('2-8 недель'), horizon.parseHorizonDays('1 месяц'), horizon.parseHorizonDays('3 дня'), horizon.parseHorizonDays('4 недели'), horizon.parseHorizonDays('до конца года'), horizon.parseHorizonDays(''));
console.log('check_at:', config.mskIso(horizon.computeCheckAt(now, '2-8 недель')));
console.log('dirs:', horizon.normalizeDirection('Лонг'), horizon.normalizeDirection('шорт'), horizon.normalizeDirection('наблюдать'), horizon.normalizeDirection('hold'));
console.log('hits:', horizon.isHit('лонг', 'рост'), horizon.isHit('лонг', 'падение'), horizon.isHit('шорт', 'падение'), horizon.isHit('наблюдать', 'рост'), horizon.isHit('лонг', null));
console.log('moves:', horizon.classifyMove(100, 102), horizon.classifyMove(100, 98), horizon.classifyMove(100, 100.5), horizon.classifyMove(null, 100));
console.log('movePct:', horizon.movePct(100, 105));

// Живая проверка одного источника (RBC)
const live = await collector.fetchSource(
  { name: 'RBC News', url: 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss' },
  (now.getTime() - 6 * 3600 * 1000) / 1000,
  now.getTime() / 1000,
);
console.log('live rbc:', live.status, live.reason, live.count, live.items[0] ? live.items[0].title : '', live.items[0] ? live.items[0].published : '');
console.log('OK');
