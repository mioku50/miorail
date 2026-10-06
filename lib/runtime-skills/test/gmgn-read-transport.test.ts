import assert from 'node:assert/strict';
import test from 'node:test';
import { gmgnReadFetchV1 } from '../src/gmgn-read-transport.js';

const URL = 'https://openapi.gmgn.ai/v1/trade/gas_price';
const NOW = 1791280000000;

test('GMGN respects the reset across wrappers and endpoints without replaying reads', async () => {
  let now = NOW, calls = 0;
  const raw = (async () => {
    calls++;
    return calls === 1
      ? new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': String(NOW / 1000 + 30) } })
      : new Response('{"code":0}');
  }) as typeof fetch;
  const quote = gmgnReadFetchV1(raw, () => now), market = gmgnReadFetchV1(raw, () => now);
  assert.equal((await quote(URL)).status, 429);
  now += 30_000;
  assert.equal((await market('https://openapi.gmgn.ai/v1/market/rank')).status, 429);
  assert.equal(calls, 1);
  now += 1001;
  assert.equal((await quote(URL)).status, 200);
  assert.equal(calls, 2);
});

for (const [label, headers, duration] of [
  ['Retry-After seconds', { 'retry-after': '60' }, 61_000],
  ['Retry-After date', { 'retry-after': new Date(NOW + 60_000).toUTCString() }, 61_000],
  ['conflicting deadlines', { 'retry-after': '60', 'x-ratelimit-reset': String(NOW / 1000 + 30) }, 61_000],
  ['missing header', {}, 300_000],
  ['malformed header', { 'x-ratelimit-reset': 'tomorrow', 'retry-after': 'later' }, 300_000],
  ['past reset', { 'x-ratelimit-reset': String(NOW / 1000 - 1) }, 300_000],
  ['unbounded reset', { 'x-ratelimit-reset': '99999999999' }, 300_000],
] as const) {
  test(`GMGN cooldown handles ${label}`, async () => {
    let now = NOW, calls = 0;
    const raw = (async () => { calls++; return new Response('{}', { status: calls === 1 ? 429 : 200, headers }); }) as typeof fetch;
    const reader = gmgnReadFetchV1(raw, () => now);
    await reader(URL);
    now += duration - 1;
    assert.equal((await reader(URL)).status, 429);
    assert.equal(calls, 1);
    now++;
    assert.equal((await reader(URL)).status, 200);
    assert.equal(calls, 2);
  });
}

test('successful reads are never cached or retried and test transports remain isolated', async () => {
  let calls = 0;
  const raw = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  const reader = gmgnReadFetchV1(raw, () => NOW);
  await reader(URL); await reader(URL);
  assert.equal(calls, 2);
  await gmgnReadFetchV1((async () => new Response('{}', { status: 429 })) as typeof fetch, () => NOW)(URL);
  assert.equal((await reader(URL)).status, 200);
});

test('a cancelled read remains cancelled during cooldown', async () => {
  const reader = gmgnReadFetchV1((async () => new Response('{}', { status: 429 })) as typeof fetch, () => NOW);
  await reader(URL);
  const signal = AbortSignal.abort();
  await assert.rejects(() => reader(URL, { signal }), { name: 'AbortError' });
});
