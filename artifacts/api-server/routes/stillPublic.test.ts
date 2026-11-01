import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { CalendarRead, MirrorOutcome, MirrorService } from '@mioagent/still-engine';
import { InMemoryRateLimiter } from '@mioagent/utils';

import { stillRpcUrlsV1 } from '../lib/stillMirror.js';
import { publicStillRouter, publicStillRuntimeV1 } from './stillPublic.js';

const original = { ...publicStillRuntimeV1 };
afterEach(() => Object.assign(publicStillRuntimeV1, original));

const WALLET = `0x${'1'.repeat(40)}` as const;

function fakeService(answer: (input: string) => Promise<MirrorOutcome>, calendar: CalendarRead = { ok: false }) {
  const asked: string[] = [];
  const service: MirrorService = {
    check: async (input) => {
      asked.push(input);
      return answer(input);
    },
    reading: async () => assert.fail('the public door reads by subject, never a reading'),
    earnings: async () => calendar,
  };
  return { service, asked };
}

function app(service: MirrorService, max = 30) {
  publicStillRuntimeV1.service = () => service;
  publicStillRuntimeV1.limiter = new InMemoryRateLimiter({ windowMs: 60_000, max });
  const server = express();
  server.use('/api/public/still', publicStillRouter);
  return server;
}

test('a wallet’s report answers 200 and is never cached', async () => {
  const report = { kind: 'still.mirror', subject: { address: WALLET, name: null, input: WALLET } } as never;
  const { service, asked } = fakeService(async () => ({ outcome: 'report', report, cached: false }));
  const res = await request(app(service)).get('/api/public/still/mirror').query({ subject: WALLET });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.outcome, 'report');
  assert.equal(res.body.report.kind, 'still.mirror');
  assert.deepEqual(asked, [WALLET]);
});

test('each refusal keeps its own status: ours is 503, never a fact about the wallet', async () => {
  const cases: Array<[MirrorOutcome, number]> = [
    [{ outcome: 'invalid_subject', input: 'x', reason: 'not_an_address_or_name' }, 400],
    [{ outcome: 'name_not_found', input: 'nobody.base', name: 'nobody.base' }, 404],
    [{ outcome: 'names_unavailable', input: 'alex.base', name: 'alex.base' }, 503],
    [{ outcome: 'chain_unavailable', attempts: [{ provider: 'base-public', kind: 'throttled' }] }, 503],
  ];
  for (const [outcome, status] of cases) {
    const { service } = fakeService(async () => outcome);
    const res = await request(app(service)).get('/api/public/still/mirror').query({ subject: 'anything' });
    assert.equal(res.status, status, outcome.outcome);
    assert.equal(res.body.outcome, outcome.outcome);
  }
});

test('a subject longer than any name never reaches the chain', async () => {
  const { service, asked } = fakeService(async () => assert.fail('not asked'));
  const res = await request(app(service)).get('/api/public/still/mirror').query({ subject: 'a'.repeat(257) });
  assert.equal(res.status, 400);
  assert.equal(res.body.outcome, 'invalid_subject');
  assert.deepEqual(asked, []);
});

test('a failure inside the read answers a fixed code and nothing of the error', async () => {
  const { service } = fakeService(async () => {
    throw new Error('https://base-mainnet.example/v3/SECRET failed');
  });
  const res = await request(app(service)).get('/api/public/still/mirror').query({ subject: WALLET });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { outcome: 'internal_error' });
  assert.doesNotMatch(res.text, /SECRET|https?:/);
});

test('one address gets its share and then waits', async () => {
  const report = { kind: 'still.mirror' } as never;
  const { service } = fakeService(async () => ({ outcome: 'report', report, cached: true }));
  const server = app(service, 2);
  assert.equal((await request(server).get('/api/public/still/mirror').query({ subject: WALLET })).status, 200);
  assert.equal((await request(server).get('/api/public/still/terms')).status, 200);
  const refused = await request(server).get('/api/public/still/mirror').query({ subject: WALLET });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.outcome, 'rate_limited');
  assert.ok(Number(refused.headers['retry-after']) >= 1);
});

test('the terms say which windows are open now and when each stock reports', async () => {
  const calendar: CalendarRead = {
    ok: true,
    calendar: { readAt: new Date('2026-10-31T14:00:00Z'), dates: new Map([['NVDAc', ['2026-11-18']], ['TSLAc', []]]) },
  };
  const { service } = fakeService(async () => assert.fail('not asked'), calendar);
  const server = app(service);
  publicStillRuntimeV1.now = () => new Date('2026-10-31T15:00:00Z'); // Saturday, 11:00 in New York
  const res = await request(server).get('/api/public/still/terms');
  assert.equal(res.status, 200);
  assert.equal(res.body.sharePercentOfProtocol, 50);
  assert.equal(res.body.weekend.activeNow, true);
  assert.equal(res.body.weekend.stockSharePercentOfProtocol, 40);
  assert.equal(res.body.weekend.endsAt, '2026-11-02T01:00:00.000Z'); // Sunday 20:00 EST, after the clock change
  const stock = (id: string) => res.body.earnings.stocks.find((s: { id: string }) => s.id === id);
  assert.deepEqual(stock('NVDAc'), {
    id: 'NVDAc',
    reportDate: '2026-11-18',
    windowStartsAt: '2026-11-17T05:00:00.000Z',
    windowEndsAt: '2026-11-20T01:00:00.000Z',
    countsAtEarningsRateNow: false,
    calendarRead: true,
  });
  // No report scheduled is not the same as not read.
  assert.equal(stock('TSLAc').countsAtEarningsRateNow, false);
  assert.equal(stock('TSLAc').calendarRead, true);
  assert.equal(stock('AAPLc').countsAtEarningsRateNow, true);
  assert.equal(stock('AAPLc').calendarRead, false);
});

test('Still reads the way the API reads: the configured endpoint, then Base’s public one', () => {
  assert.deepEqual(stillRpcUrlsV1({ BASE_MAINNET_RPC_URL: 'https://base.example/key' }), ['https://base.example/key', 'https://mainnet.base.org']);
  assert.deepEqual(stillRpcUrlsV1({ BASE_RPC_URL: 'https://fallback.example' }), ['https://fallback.example', 'https://mainnet.base.org']);
  assert.deepEqual(stillRpcUrlsV1({}), ['https://mainnet.base.org']);
});

// Still Spend, stage 1: Bitrefill's catalogue as a guest, cached, never buying.
function fakeSpend(answers: { search?: () => Promise<unknown>; product?: () => Promise<unknown> }) {
  const asked: string[] = [];
  const catalog = {
    search: async (input: unknown) => { asked.push(`search ${JSON.stringify(input)}`); return answers.search!(); },
    product: async (id: string) => { asked.push(`product ${id}`); return answers.product!(); },
  };
  publicStillRuntimeV1.spend = () => catalog as never;
  return asked;
}

test('Spend reads Bitrefill’s catalogue once per half hour, and a failure is never kept', async (t) => {
  const { resetStillCardCachesV1 } = await import('./stillPublic.js');
  resetStillCardCachesV1();
  t.after(() => resetStillCardCachesV1());
  let fail = true;
  const asked = fakeSpend({ search: async () => (fail ? { ok: false, reason: 'bitrefill_rate_limited' } : {
    ok: true, value: [{ id: 'bitrefill-esim-germany', name: 'Bitrefill eSIM Germany', countries: ['DE'], inStock: true }],
  }) });
  const server = app(fakeService(async () => assert.fail('no wallet read')).service);
  const failed = await request(server).get('/api/public/still/spend/search').query({ type: 'esim', country: 'de' });
  assert.deepEqual([failed.status, failed.body], [503, { outcome: 'unavailable', reason: 'bitrefill_rate_limited' }]);
  fail = false;
  const first = await request(server).get('/api/public/still/spend/search').query({ type: 'esim', country: 'DE' });
  const again = await request(server).get('/api/public/still/spend/search').query({ type: 'esim', country: 'DE' });
  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, 'products');
  assert.equal(first.body.products[0].id, 'bitrefill-esim-germany');
  assert.deepEqual(again.body, first.body);
  assert.deepEqual(asked, ['search {"type":"esim","country":"DE"}', 'search {"type":"esim","country":"DE"}']);
});

test('Spend refuses what cannot be a product type, a country, a search or a product id, before asking anyone', async () => {
  const asked = fakeSpend({ search: async () => assert.fail('never asked'), product: async () => assert.fail('never asked') });
  const server = app(fakeService(async () => assert.fail('no wallet read')).service);
  for (const query of [{ type: 'loan', country: 'DE' }, { type: 'esim', country: 'DEU' }, { type: 'esim', country: 'DE', q: '<script>' }, { type: 'esim', country: 'DE', q: 'x'.repeat(41) }]) {
    assert.equal((await request(server).get('/api/public/still/spend/search').query(query)).status, 400, JSON.stringify(query));
  }
  for (const id of ['', '../buy-products', 'Amazon DE', 'x'.repeat(101)]) {
    assert.equal((await request(server).get('/api/public/still/spend/product').query({ id })).status, 400, id);
  }
  assert.deepEqual(asked, []);
});

test('a product is its USDC packages, and one Bitrefill does not have is a 404, not our failure', async (t) => {
  const { resetStillCardCachesV1 } = await import('./stillPublic.js');
  resetStillCardCachesV1();
  t.after(() => resetStillCardCachesV1());
  let answer: unknown = { ok: false, reason: 'bitrefill_product_not_found' };
  fakeSpend({ product: async () => answer });
  const server = app(fakeService(async () => assert.fail('no wallet read')).service);
  const missing = await request(server).get('/api/public/still/spend/product').query({ id: 'amazon_de-germany' });
  assert.deepEqual([missing.status, missing.body.reason], [404, 'bitrefill_product_not_found']);
  answer = { ok: true, value: { id: 'amazon_de-germany', name: 'Amazon.de', country: 'DE', inStock: true, recipientType: null,
    packages: [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }], url: null } };
  const found = await request(server).get('/api/public/still/spend/product').query({ id: 'amazon_de-germany' });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.product.packages, [{ value: '50', faceCurrency: 'EUR', priceUsdc: '58.80' }]);
  // Paying from Still is the operator's switch, read on every request and never cached with the catalogue.
  assert.deepEqual(found.body.checkout, { enabled: false, available: false, capAtomic: '100000000' });
  const before = process.env.STILL_SPEND_PAY_V1;
  process.env.STILL_SPEND_PAY_V1 = 'on';
  t.after(() => { if (before === undefined) delete process.env.STILL_SPEND_PAY_V1; else process.env.STILL_SPEND_PAY_V1 = before; });
  const open = await request(server).get('/api/public/still/spend/product').query({ id: 'amazon_de-germany' });
  assert.deepEqual(open.body.checkout, { enabled: true, available: true, capAtomic: '100000000' });
});
