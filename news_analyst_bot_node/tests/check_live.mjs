import * as config from '../src/config.js';
import { decodeBuffer } from '../src/http.js';
import * as collector from '../src/news/collector.js';

// cp1251: «Привет» = CF F0 E8 E2 E5 F2
const cp1251 = Buffer.from([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x3d, 0x22, 0x31, 0x2e, 0x30, 0x22, 0x20, 0x65, 0x6e, 0x63, 0x6f, 0x64, 0x69, 0x6e, 0x67, 0x3d, 0x22, 0x77, 0x69, 0x6e, 0x64, 0x6f, 0x77, 0x73, 0x2d, 0x31, 0x32, 0x35, 0x31, 0x22, 0x3f, 0x3e, 0x3c, 0x74, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3c, 0x2f, 0x74, 0x3e]);
console.log('cp1251 decode:', decodeBuffer(cp1251, 'text/xml'));

const now = config.nowMsk();
const start = (now.getTime() - 24 * 3600 * 1000) / 1000;
for (const source of collector.SOURCES) {
  const result = await collector.fetchSource(source, start, now.getTime() / 1000);
  console.log(`--- ${source.name}: ${result.status} / ${result.reason} / ${result.count}`);
  for (const item of result.items.slice(0, 2)) {
    console.log(`    [${item.published}] ${item.title}`);
    console.log(`      ${item.summary.slice(0, 120)}`);
    console.log(`      ${item.link}`);
  }
}
console.log('OK');
