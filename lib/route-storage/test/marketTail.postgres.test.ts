import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import assert from 'node:assert/strict';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { MarketVenueUnidentifiedError } from '../src/marketTail.js';
import { createDatabaseMarketTailRepository, type MarketTailTransactionV1 } from '../src/marketTailDatabase.js';
import { marketTailContractV1 } from './marketTail.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. Half of this guarantee is a unique
// index and a set of CHECK constraints, and a zod schema cannot prove those
// exist.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/marketTail.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'DROP TABLE IF EXISTS market_venue_activity_totals, market_venue_transfers, market_venues, market_tail_cursors CASCADE',
  );
  // 0097 twice: applied by hand it must find its trigger and change nothing.
  for (const file of ['0051_market_tail.sql', '0097_market_venue_activity_totals.sql', '0097_market_venue_activity_totals.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres market tail', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  const asExecutor = (run: unknown): SqlTemplateExecutor => (strings, ...values) =>
    (run as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(strings, ...values);
  // What scripts/market_tail.ts passes: each pass in one transaction.
  const transaction: MarketTailTransactionV1 = async (work) =>
    (await sql!.begin((inside) => work(asExecutor(inside)))) as unknown as Awaited<ReturnType<typeof work>>;
  const truncate = () =>
    sql!.unsafe(
      'TRUNCATE market_venue_activity_totals, market_venue_transfers, market_venues, market_tail_cursors RESTART IDENTITY CASCADE',
    );

  marketTailContractV1('postgres', async () => {
    await truncate();
    return { repository: createDatabaseMarketTailRepository(asExecutor(sql)) };
  });
  marketTailContractV1('postgres, one transaction per pass', async () => {
    await truncate();
    return { repository: createDatabaseMarketTailRepository(asExecutor(sql), transaction) };
  });

  describe('postgres market tail, one transaction per pass', () => {
    test('a pass that fails part way stores none of its events and leaves the cursor where it was', async () => {
      await truncate();
      const repository = createDatabaseMarketTailRepository(asExecutor(sql), transaction);
      const pool = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
      const event = (logIndex: number, venueAddress: string) => ({
        chainId: 8453 as const, tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb', venueAddress,
        direction: 'out_of_venue' as const, counterparty: '0x1111111111111111111111111111111111111111',
        amountAtomic: '322751470', blockNumber: 50_428_000, transactionHash: `0x${'ab'.repeat(32)}`, logIndex,
        observedAt: '2026-08-25T09:00:00.000Z',
      });
      await assert.rejects(
        repository.recordPass({
          tailKey: 'official_asset_ledger', chainId: 8453, toBlock: 50_428_100, observedAt: '2026-08-25T09:05:00.000Z',
          logCalls: 1, identityCalls: 2,
          venues: [{ chainId: 8453, address: pool, kind: 'paired_pool', token0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            token1: '0xb200000000000000000000c2e324d24d7eecd1fb', firstSeenAt: '2026-08-25T09:00:00.000Z', identifiedAt: '2026-08-25T09:00:00.000Z' }],
          // The first event is through the pool this pass names; the second through an address nobody identified.
          events: [event(7, pool), event(8, '0x9999999999999999999999999999999999999999')],
        }),
        MarketVenueUnidentifiedError,
      );
      const [counts] = await sql!`SELECT (SELECT count(*) FROM market_venue_transfers)::int AS events,
        (SELECT count(*) FROM market_venues)::int AS venues, (SELECT count(*) FROM market_tail_cursors)::int AS cursors,
        (SELECT count(*) FROM market_venue_activity_totals)::int AS totals`;
      // The total is added to by a trigger inside the same transaction, so the event that was
      // rolled back is not counted either.
      assert.deepEqual({ ...counts }, { events: 0, venues: 0, cursors: 0, totals: 0 });
    });
  });

  describe('migration 0097 on a table that already holds transfers', () => {
    test('counts the rows that were there, once, and every row stored after it', async () => {
      // As production met it: millions of rows, no total, no trigger.
      await sql!.unsafe('DROP TABLE IF EXISTS market_venue_activity_totals CASCADE');
      await sql!.unsafe('DROP TRIGGER IF EXISTS market_venue_transfers_totals ON market_venue_transfers');
      await sql!.unsafe('TRUNCATE market_venue_transfers, market_venues, market_tail_cursors RESTART IDENTITY CASCADE');
      const pool = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
      const aapl = '0xb200000000000000000000c2e324d24d7eecd1fb';
      const nvda = '0xb20000000000000000000078ee7ce2fe4908108c';
      await sql!`INSERT INTO market_venues (chain_id, address, kind, token0, token1, first_seen_at, identified_at)
        VALUES (8453, ${pool}, 'paired_pool', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ${aapl}, now(), now())`;
      const store = async (token: string, logIndex: number, direction: string, block: number) => {
        await sql!`INSERT INTO market_venue_transfers
          (chain_id, token_address, venue_address, direction, counterparty, amount_atomic, block_number, transaction_hash, log_index, observed_at)
          VALUES (8453, ${token}, ${pool}, ${direction}, '0x1111111111111111111111111111111111111111', '1', ${block},
            ${`0x${'ab'.repeat(32)}`}, ${logIndex}, now())`;
      };
      await store(aapl, 1, 'out_of_venue', 50_428_010);
      await store(aapl, 2, 'into_venue', 50_428_020);
      await store(nvda, 3, 'out_of_venue', 50_428_030);

      const migration = (await readFile(resolve(drizzleDir(), '0097_market_venue_activity_totals.sql'), 'utf8'))
        .replaceAll('--> statement-breakpoint', '');
      await sql!.unsafe(migration);
      // Again: it finds its trigger and counts nothing twice.
      await sql!.unsafe(migration);
      await store(aapl, 4, 'out_of_venue', 50_428_040);

      const repository = createDatabaseMarketTailRepository(asExecutor(sql));
      assert.deepEqual(await repository.venueActivityAllTime({ chainId: 8453, tokenAddresses: [aapl, nvda] }), [
        { tokenAddress: nvda, transfers: 1, acquired: 1, disposed: 0, firstBlock: 50_428_030, lastBlock: 50_428_030 },
        { tokenAddress: aapl, transfers: 3, acquired: 2, disposed: 1, firstBlock: 50_428_010, lastBlock: 50_428_040 },
      ]);
      // The total cannot hold a count with nothing behind it.
      await assert.rejects(
        sql!`UPDATE market_venue_activity_totals SET acquired = acquired + 1 WHERE token_address = ${aapl}`,
        /market_venue_activity_totals_counts/,
      );
    });
  });
}
