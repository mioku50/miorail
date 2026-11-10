import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { updateStillRegionTableV1 } from './stillRegionTableUpdate.js';
import { buildStillRegionTableV1, ipv4NumberV1, parseStillRegionTableV1, stillRegionCountryV1 } from './stillRegionTable.js';

// A whole synthetic database: 131,072 IPv4 and 131,072 IPv6 ranges cycling
// through 210 made-up countries, with Google's and Level 3's resolvers in US
// and loopback and 10/8 in reserved space, as in DB-IP's real file.
const COUNTRIES = Array.from({ length: 210 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)));
const ipv4 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ipv6 = (n: bigint) => Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - 16 * i)) & BigInt(0xffff)).toString(16)).join(':');
function wholeCsv(override: Partial<Record<'google', string>> = {}): string {
  const rows: string[] = [];
  const size4 = 2 ** 15, us = [ipv4NumberV1('8.8.8.8')!, ipv4NumberV1('4.2.2.2')!], reserved = [ipv4NumberV1('127.0.0.1')!, ipv4NumberV1('10.0.0.1')!];
  for (let i = 0; i < 2 ** 17; i++) {
    const start = i * size4, end = start + size4 - 1;
    const holds = (list: number[]) => list.some(a => a >= start && a <= end);
    const country = holds([us[0]!]) ? override.google ?? 'US' : holds([us[1]!]) ? 'US' : holds(reserved) ? 'ZZ' : COUNTRIES[i % COUNTRIES.length]!;
    rows.push(`${ipv4(start)},${ipv4(end)},${country}`);
  }
  const size6 = BigInt(1) << BigInt(111);
  for (let i = 0; i < 2 ** 17; i++) {
    const start = BigInt(i) * size6;
    rows.push(`${ipv6(start)},${ipv6(start + size6 - BigInt(1))},${COUNTRIES[i % COUNTRIES.length]}`);
  }
  return rows.join('\n');
}
const WHOLE_GZ = gzipSync(wholeCsv());

let directory = '', path = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'still-region-update-')); path = join(directory, 'state', 'region-v1.bin'); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const NOW = new Date('2026-11-02T04:00:00Z');
function fetcher(answers: Record<string, { status: number; body?: Buffer }>, asked: string[]) {
  return async (url: string) => {
    asked.push(url);
    const answer = answers[url] ?? { status: 404 };
    return { status: answer.status, body: answer.body ?? Buffer.alloc(0) };
  };
}
const url = (month: string) => `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`;

describe('the monthly region table update', () => {
  it('builds this month’s table where there is none, and it places addresses as the database does', async () => {
    const asked: string[] = [];
    const result = await updateStillRegionTableV1({ path, now: NOW, fetch: fetcher({ [url('2026-11')]: { status: 200, body: WHOLE_GZ } }, asked) });
    assert.deepEqual(result, { outcome: 'updated', month: '2026-11', ipv4Ranges: 131072, ipv6Ranges: 131072, previous: null });
    assert.deepEqual(asked, [url('2026-11')]);
    const table = parseStillRegionTableV1(readFileSync(path));
    assert.equal(stillRegionCountryV1(table, '8.8.8.8'), 'US');
    assert.equal(stillRegionCountryV1(table, '127.0.0.1'), null);
  });

  it('takes last month’s while this month’s is not out, and leaves a table of the month in place', async () => {
    const asked: string[] = [];
    const first = await updateStillRegionTableV1({ path, now: NOW, fetch: fetcher({ [url('2026-10')]: { status: 200, body: WHOLE_GZ } }, asked) });
    assert.equal(first.outcome === 'updated' && first.month, '2026-10');
    assert.deepEqual(asked, [url('2026-11'), url('2026-10')]);
    // The next day: still no November file, and October's is what is in place.
    const again = await updateStillRegionTableV1({ path, now: new Date('2026-11-03T04:00:00Z'), fetch: fetcher({}, asked) });
    assert.deepEqual(again, { outcome: 'current', month: '2026-10' });
    writeFileSync(path, buildStillRegionTableV1(wholeCsv(), '2026-11'));
    const before = asked.length;
    assert.deepEqual(await updateStillRegionTableV1({ path, now: NOW, fetch: fetcher({}, asked) }), { outcome: 'current', month: '2026-11' });
    assert.equal(asked.length, before);
  });

  it('keeps the table in place when a download is broken, places Google elsewhere, or is refused', async () => {
    writeFileSync(join(directory, 'seed'), '');
    await updateStillRegionTableV1({ path, now: NOW, fetch: fetcher({ [url('2026-10')]: { status: 200, body: WHOLE_GZ } }, []) });
    const kept = readFileSync(path);
    const gap = gzipSync(wholeCsv().split('\n').filter((_, i) => i !== 5).join('\n'));
    const elsewhere = gzipSync(wholeCsv({ google: 'DE' }));
    for (const answer of [{ status: 200, body: gap }, { status: 200, body: elsewhere }, { status: 200, body: Buffer.from('not gzip') }, { status: 503 }]) {
      await assert.rejects(updateStillRegionTableV1({ path, now: NOW, fetch: fetcher({ [url('2026-11')]: answer }, []) }));
      assert.deepEqual(readFileSync(path), kept);
    }
    await assert.rejects(updateStillRegionTableV1({ path: join(directory, 'none', 'region-v1.bin'), now: NOW, fetch: fetcher({}, []) }), /no database for 2026-11 or 2026-10/);
  });
});
