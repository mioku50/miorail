import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryMarketTailRepository } from '../lib/route-storage/src/marketTailMemory.js';
import {
  MARKET_TAIL_RETENTION_BATCH_V1,
  MARKET_TAIL_RETENTION_MIN_DAYS_V1,
  MARKET_TAIL_RETENTION_STATEMENTS_V1,
  marketTailRetentionDaysV1,
  marketTailRetentionLineV1,
  pruneOldVenueTransfersV1,
} from './marketTailRetention.js';

const env = (value?: string) => ({ ...(value === undefined ? {} : { MARKET_TAIL_RETENTION_DAYS: value }) }) as NodeJS.ProcessEnv;

test('retention is off until a whole number of days, no fewer than a week, turns it on', () => {
  assert.equal(marketTailRetentionDaysV1(env()), null, 'unset: a deploy removes nothing by itself');
  assert.equal(marketTailRetentionDaysV1(env('')), null);
  assert.equal(marketTailRetentionDaysV1(env('30')), 30);
  assert.equal(marketTailRetentionDaysV1(env(' 14 ')), 14);
  assert.equal(marketTailRetentionDaysV1(env(String(MARKET_TAIL_RETENTION_MIN_DAYS_V1))), 7);
  for (const value of ['6', '1', '0', '-30', '30.5', '30d', 'true', '1e2', '99999']) {
    assert.equal(marketTailRetentionDaysV1(env(value)), null, value);
  }
});

test('a run removes full batches until one comes back short, and never more statements than its budget', async () => {
  const now = Date.parse('2026-11-12T10:00:00.000Z');
  const asked: Array<{ chainId: number; before: string; limit: number }> = [];
  const answers = [50_000, 50_000, 12_345];
  const outcome = await pruneOldVenueTransfersV1({
    days: 30,
    nowMs: now,
    prune: async (input) => {
      asked.push(input);
      return { removed: answers[asked.length - 1] ?? 0 };
    },
  });
  assert.deepEqual(outcome, { removed: 112_345, statements: 3, more: false });
  assert.deepEqual(asked[0], { chainId: 8453, before: '2026-10-13T10:00:00.000Z', limit: MARKET_TAIL_RETENTION_BATCH_V1 });
  assert.ok(asked.every((input) => input.before === asked[0]!.before));

  // A backlog: every statement comes back full, and the run stops at its budget and says so.
  let calls = 0;
  const backlog = await pruneOldVenueTransfersV1({
    days: 30,
    nowMs: now,
    prune: async (input) => {
      calls += 1;
      return { removed: input.limit };
    },
  });
  assert.equal(calls, MARKET_TAIL_RETENTION_STATEMENTS_V1);
  assert.deepEqual(backlog, {
    removed: MARKET_TAIL_RETENTION_BATCH_V1 * MARKET_TAIL_RETENTION_STATEMENTS_V1,
    statements: MARKET_TAIL_RETENTION_STATEMENTS_V1,
    more: true,
  });
  // More leaves each hour than arrives in a busy one (355,000 a day on 2026-11-09).
  assert.ok(MARKET_TAIL_RETENTION_BATCH_V1 * MARKET_TAIL_RETENTION_STATEMENTS_V1 >= 10 * Math.ceil(355_000 / 24));

  // Nothing old: one statement, nothing removed.
  assert.deepEqual(
    await pruneOldVenueTransfersV1({ days: 30, nowMs: now, prune: async () => ({ removed: 0 }) }),
    { removed: 0, statements: 1, more: false },
  );
});

test('fewer days than the floor, or a clock that is not a number, removes nothing', async () => {
  const never = async (): Promise<{ removed: number }> => {
    throw new Error('must not be asked');
  };
  assert.equal(await pruneOldVenueTransfersV1({ days: 6, nowMs: Date.now(), prune: never }), null);
  assert.equal(await pruneOldVenueTransfersV1({ days: 30.5, nowMs: Date.now(), prune: never }), null);
  assert.equal(await pruneOldVenueTransfersV1({ days: 30, nowMs: Number.NaN, prune: never }), null);
});

test('against the repository: the old transfers go, the recent stay, and the all-time count does not move', async () => {
  const repository = createMemoryMarketTailRepository();
  const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
  const POOL = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
  const event = (logIndex: number, blockNumber: number, observedAt: string) => ({
    chainId: 8453 as const, tokenAddress: AAPL, venueAddress: POOL, direction: 'out_of_venue' as const,
    counterparty: '0x1111111111111111111111111111111111111111', amountAtomic: '1', blockNumber,
    transactionHash: `0x${'ab'.repeat(32)}`, logIndex, observedAt,
  });
  const pass = (toBlock: number, observedAt: string, events: ReturnType<typeof event>[]) =>
    repository.recordPass({ tailKey: 'official_asset_ledger', chainId: 8453, toBlock, observedAt, logCalls: 1, identityCalls: 0,
      venues: [{ chainId: 8453, address: POOL, kind: 'paired_pool', token0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', token1: AAPL,
        firstSeenAt: '2026-08-25T09:00:00.000Z', identifiedAt: '2026-08-25T09:00:00.000Z' }], events });
  const old = '2026-09-01T09:00:00.000Z';
  const recent = '2026-11-12T09:00:00.000Z';
  await pass(50_500_000, old, [1, 2, 3, 4, 5].map((n) => event(n, 50_400_000 + n, old)));
  await pass(56_400_000, recent, [6, 7].map((n) => event(n, 56_300_000 + n, recent)));

  const outcome = await pruneOldVenueTransfersV1({
    days: 30,
    nowMs: Date.parse('2026-11-12T10:00:00.000Z'),
    batch: 2,
    statements: 10,
    prune: (input) => repository.pruneTransfersObservedBefore(input),
  });
  // 2 + 2 + 1: the third statement comes back short and ends the run.
  assert.deepEqual(outcome, { removed: 5, statements: 3, more: false });
  const kept = await repository.recentTransfers({ chainId: 8453, tokenAddress: AAPL, limit: 50 });
  assert.deepEqual(kept.map((row) => row.logIndex), [7, 6]);
  const [total] = await repository.venueActivityAllTime({ chainId: 8453, tokenAddresses: [AAPL] });
  assert.equal(total!.transfers, 7);
  assert.equal(total!.firstBlock, 50_400_001);
});

test('the journal line says what was removed and whether more is waiting', () => {
  assert.equal(
    marketTailRetentionLineV1({ days: 30, removed: 200_000, statements: 4, more: true }),
    'retention: removed 200000 venue transfers observed more than 30 days ago; older ones remain for the next run',
  );
  assert.equal(
    marketTailRetentionLineV1({ days: 30, removed: 1, statements: 1, more: false }),
    'retention: removed 1 venue transfer observed more than 30 days ago',
  );
});
