import assert from 'node:assert/strict';
import test from 'node:test';
import { B20PublicContextBudgetError, B20PublicContextBudgetV1 } from './b20PublicContextBudget.js';
import { clearB20PublicContextCacheV1, readB20PublicContextV1 } from './b20PublicContextRead.js';

test('the seventh public lookup is refused per client, with no effect on another client', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const budget = new B20PublicContextBudgetV1();
  for (let i = 0; i < 6; i++) await budget.consumeLookup('client-a');
  await assert.rejects(budget.consumeLookup('client-a'), error =>
    error instanceof B20PublicContextBudgetError && error.reason === 'client_limit');
  await budget.consumeLookup('client-b');
  now += 60_000;
  await budget.consumeLookup('client-a');
});

test('parallel requests cannot reserve more than 200 paid search attempts', async () => {
  const budget = new B20PublicContextBudgetV1();
  let called = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: 250 }, async () => {
    budget.reserveSearch();
    await Promise.resolve();
    called++;
  }));
  assert.equal(called, 200);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 50);
});

test('the daily allowance resets only when the UTC day moves forwards', () => {
  let now = Date.parse('2026-11-10T23:59:59Z');
  const budget = new B20PublicContextBudgetV1({ dailySearchMax: 1, now: () => now });
  budget.reserveSearch();
  assert.throws(() => budget.reserveSearch(), B20PublicContextBudgetError);
  now = Date.parse('2026-11-11T00:00:00Z');
  budget.reserveSearch();
  now = Date.parse('2026-11-10T23:00:00Z');
  assert.throws(() => budget.reserveSearch(), B20PublicContextBudgetError);
  now = Date.parse('2026-11-11T12:00:00Z');
  assert.throws(() => budget.reserveSearch(), B20PublicContextBudgetError);
});

// Audit MCP-4, 2026-11-14: one anonymous address spent the whole day's pool in 17 to 34 minutes.
test('one client reserves at most ten searches a day, and another client is unaffected', () => {
  const budget = new B20PublicContextBudgetV1();
  for (let i = 0; i < 10; i++) budget.reserveSearch('public-ip:198.51.100.7');
  assert.throws(() => budget.reserveSearch('public-ip:198.51.100.7'), (error) =>
    error instanceof B20PublicContextBudgetError && error.reason === 'client_daily_limit' && /its share of today's public lookups/.test(error.message));
  budget.reserveSearch('public-ip:198.51.100.8');
});

test('clients that are not connected grants share 150 searches, and the last 50 stay for grants', () => {
  const budget = new B20PublicContextBudgetV1();
  for (let client = 0; client < 15; client++) {
    for (let i = 0; i < 10; i++) budget.reserveSearch(`public-ip:203.0.113.${client}`);
  }
  assert.throws(() => budget.reserveSearch('public-ip:203.0.113.200'), (error) =>
    error instanceof B20PublicContextBudgetError && error.reason === 'daily_limit');
  // A connected grant still has its own ten.
  for (let i = 0; i < 10; i++) budget.reserveSearch('private:["eip155:8453:0xabc","grant-1"]');
});

test('a client’s share returns with the UTC day', () => {
  let now = Date.parse('2026-11-14T23:59:00Z');
  const budget = new B20PublicContextBudgetV1({ now: () => now });
  for (let i = 0; i < 10; i++) budget.reserveSearch('public-ip:192.0.2.1');
  assert.throws(() => budget.reserveSearch('public-ip:192.0.2.1'), B20PublicContextBudgetError);
  now = Date.parse('2026-11-15T00:00:01Z');
  budget.reserveSearch('public-ip:192.0.2.1');
});

const tokenAddress = `0x${'5'.repeat(40)}`;
const input = { chainId: 8453, tokenAddress, name: 'Budget fixture', symbol: 'BUDGET' };

test('precise and widened searches each reserve once, while a cache hit reserves nothing', async (t) => {
  clearB20PublicContextCacheV1();
  t.after(clearB20PublicContextCacheV1);
  const budget = new B20PublicContextBudgetV1({ dailySearchMax: 2 });
  let attempts = 0;
  const deps = {
    search: async () => { attempts++; return []; }, now: () => new Date('2026-11-10T12:00:00Z'),
    beforeSearch: () => budget.reserveSearch(),
  };
  const first = await readB20PublicContextV1({ ...input, deps });
  assert.equal(attempts, 2);
  assert.equal(await readB20PublicContextV1({ ...input, deps }), first);
  assert.equal(attempts, 2);
  assert.throws(() => budget.reserveSearch(), B20PublicContextBudgetError);
});

test('a refusal before the widened search is not swallowed or cached as an empty answer', async (t) => {
  clearB20PublicContextCacheV1();
  t.after(clearB20PublicContextCacheV1);
  const budget = new B20PublicContextBudgetV1({ dailySearchMax: 1 });
  let attempts = 0;
  const deps = {
    search: async () => { attempts++; return []; }, now: () => new Date('2026-11-10T12:00:00Z'),
    beforeSearch: () => budget.reserveSearch(),
  };
  await assert.rejects(readB20PublicContextV1({ ...input, deps }), B20PublicContextBudgetError);
  assert.equal(attempts, 1);
  await assert.rejects(readB20PublicContextV1({ ...input, deps }), B20PublicContextBudgetError);
  assert.equal(attempts, 1, 'a budget refusal never reaches the paid provider');
  const retry = await readB20PublicContextV1({ ...input, deps: { ...deps, beforeSearch: undefined } });
  assert.ok(retry);
  assert.equal(attempts, 3, 'the refused lookup did not leave a cached empty answer');
});

test('failed upstream searches count, and a supplied domain never reserves a search', async (t) => {
  clearB20PublicContextCacheV1();
  t.after(clearB20PublicContextCacheV1);
  const budget = new B20PublicContextBudgetV1({ dailySearchMax: 1 });
  const deps = {
    search: async () => { throw new Error('test upstream failure'); }, now: () => new Date('2026-11-10T12:00:00Z'),
    beforeSearch: () => budget.reserveSearch(),
  };
  await readB20PublicContextV1({ ...input, deps });
  assert.throws(() => budget.reserveSearch(), B20PublicContextBudgetError);
  // Invalid/private domains are refused without DNS or an HTTP request. Even
  // with the daily budget spent, the domain path never tries a paid search.
  await assert.rejects(readB20PublicContextV1({ ...input, domain: '127.0.0.1', deps }), error =>
    !(error instanceof B20PublicContextBudgetError));
});
