import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoinbaseStockMetaCacheV1, isPngV1, parseCoinbaseStockMetaV1 } from './coinbaseStockMeta.js';

const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const ICON = `https://metadata.coinbase.com/equity_icons/${'ab'.repeat(32)}.png`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const body = (tokens: unknown[]) => ({ tokens });
const nvidia = { contract_address: NVDAC.toUpperCase().replace('0X', '0x'), symbol: 'NVDAc', name: ' NVIDIA Corporation ', icon_url: ICON };

test('a row that fails its shape is skipped, and the rest are kept', () => {
  const rows = parseCoinbaseStockMetaV1(
    body([
      nvidia,
      { ...nvidia, contract_address: 'NVDAc' },
      { ...nvidia, contract_address: `0x${'2'.repeat(40)}`, name: '' },
      // An icon anywhere but Coinbase's icon store is no icon at all.
      { ...nvidia, contract_address: `0x${'3'.repeat(40)}`, icon_url: 'https://example.com/x.png' },
      { ...nvidia, contract_address: `0x${'4'.repeat(40)}`, icon_url: `${ICON}?v=1` },
    ]),
  );
  assert.deepEqual([...rows.keys()], [NVDAC, `0x${'3'.repeat(40)}`, `0x${'4'.repeat(40)}`]);
  assert.deepEqual(rows.get(NVDAC), { tokenAddress: NVDAC, symbol: 'NVDAc', name: 'NVIDIA Corporation', iconUrl: ICON });
  assert.equal(rows.get(`0x${'3'.repeat(40)}`)!.iconUrl, null);
  assert.equal(rows.get(`0x${'4'.repeat(40)}`)!.iconUrl, null);
  assert.equal(parseCoinbaseStockMetaV1({ data: [] }).size, 0);
});

test('a failed read keeps the last good answer and waits before asking again', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const fetchImpl = (async (url: unknown) => {
    calls += 1;
    if (fail) throw new Error('offline');
    assert.equal(String(url), 'https://api.coinbase.com/v1/tokenized-stocks');
    return new Response(JSON.stringify(body([nvidia])), { status: 200 });
  }) as typeof fetch;
  const cache = createCoinbaseStockMetaCacheV1({ fetchImpl, now: () => clock, ttlMs: 1_000, retryMs: 100 });
  assert.equal((await cache.read()).size, 1);
  assert.equal((await cache.read()).size, 1);
  assert.equal(calls, 1);
  clock = 1_001;
  fail = true;
  assert.equal((await cache.read()).size, 1, 'the outage keeps the old names');
  assert.equal(calls, 2);
  clock = 1_050;
  await cache.read();
  assert.equal(calls, 2, 'no retry before the retry interval');
  clock = 1_200;
  fail = false;
  await cache.read();
  assert.equal(calls, 3);
});

test('an icon is fetched once, only from the URL Coinbase gave, and only if it is a PNG', async () => {
  const asked: string[] = [];
  let iconBytes: Uint8Array = PNG;
  const fetchImpl = (async (url: unknown) => {
    asked.push(String(url));
    if (String(url).startsWith('https://api.coinbase.com/')) return new Response(JSON.stringify(body([nvidia])));
    return new Response(Buffer.from(iconBytes), { status: 200 });
  }) as typeof fetch;
  const cache = createCoinbaseStockMetaCacheV1({ fetchImpl, now: () => 0 });
  assert.deepEqual(await cache.icon(NVDAC), PNG);
  assert.deepEqual(await cache.icon(NVDAC), PNG);
  assert.deepEqual(asked, ['https://api.coinbase.com/v1/tokenized-stocks', ICON]);
  assert.equal(await cache.icon(`0x${'9'.repeat(40)}`), null, 'an address Coinbase does not list has no icon');

  const other = createCoinbaseStockMetaCacheV1({ fetchImpl, now: () => 0 });
  iconBytes = new TextEncoder().encode('<svg onload="alert(1)"/>');
  assert.equal(await other.icon(NVDAC), null, 'anything but a PNG is refused');
  assert.equal(isPngV1(PNG), true);
  assert.equal(isPngV1(PNG.slice(0, 8)), false);
});
