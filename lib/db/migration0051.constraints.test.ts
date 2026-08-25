import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// The constraints in migration 0051, tested by violating them.
//
// The repository refuses these rows in TypeScript and the contract test proves
// it. This proves the DATABASE refuses them with the repository out of the way,
// because a backfill script is exactly the caller that will not go through it.
//
//   docker run -d --rm --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 127.0.0.1:55437:5432 postgres:17-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/db/migration0051.constraints.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const POOL = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}`;

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS market_venue_transfers, market_venues, market_tail_cursors CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0051_market_tail.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('migration 0051 constraints', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('migration 0051 constraints', () => {
    const venue = async (overrides: Record<string, unknown> = {}) => {
      const row = {
        chain_id: 8453,
        address: POOL,
        kind: 'paired_pool',
        token0: USDC,
        token1: AAPL,
        first_seen_at: '2026-08-25T09:00:00.000Z',
        identified_at: '2026-08-25T09:00:00.000Z',
        ...overrides,
      };
      await sql!`
        INSERT INTO market_venues (chain_id, address, kind, token0, token1, first_seen_at, identified_at)
        VALUES (
          ${row.chain_id as number}, ${row.address as string}, ${row.kind as string},
          ${row.token0 as string | null}, ${row.token1 as string | null},
          ${row.first_seen_at as string}::timestamptz, ${row.identified_at as string | null}
        )`;
    };

    test('a paired pool without its pair is refused', async () => {
      await assert.rejects(venue({ token1: null }), /market_venues_pair_complete/);
    });

    test('anything that has been asked carries when', async () => {
      await assert.rejects(
        venue({ address: WALLET, kind: 'not_a_venue', token0: null, token1: null, identified_at: null }),
        /market_venues_identified/,
      );
    });

    test('a checksummed address is refused, so a venue has one spelling', async () => {
      await assert.rejects(
        venue({ address: '0xA3B1E3F9747065E2073722FF4C9027D3EA4994F0' }),
        /market_venues_address_lower/,
      );
    });

    const event = async (overrides: Record<string, unknown> = {}) => {
      const row = {
        chain_id: 8453,
        token_address: AAPL,
        venue_address: POOL,
        direction: 'out_of_venue',
        counterparty: WALLET,
        amount_atomic: '322751470',
        block_number: 50_428_000,
        transaction_hash: TX,
        log_index: 7,
        observed_at: '2026-08-25T09:00:00.000Z',
        ...overrides,
      };
      await sql!`
        INSERT INTO market_venue_transfers (
          chain_id, token_address, venue_address, direction, counterparty,
          amount_atomic, block_number, transaction_hash, log_index, observed_at
        ) VALUES (
          ${row.chain_id as number}, ${row.token_address as string}, ${row.venue_address as string},
          ${row.direction as string}, ${row.counterparty as string}, ${row.amount_atomic as string},
          ${row.block_number as number}::bigint, ${row.transaction_hash as string},
          ${row.log_index as number}, ${row.observed_at as string}::timestamptz
        )`;
    };

    test('one log is one event, however often the range is re-read', async () => {
      await event();
      await assert.rejects(event(), /market_venue_transfers_log_unique/);
    });

    test('a venue on both sides is routing, not a movement anybody made', async () => {
      await assert.rejects(
        event({ log_index: 8, counterparty: POOL }),
        /market_venue_transfers_counterparty_is_not_the_venue/,
      );
    });

    test('a direction outside the two observable ones is refused', async () => {
      await assert.rejects(event({ log_index: 9, direction: 'buy' }), /market_venue_transfers_direction/);
    });

    test('an amount that is not digits is refused', async () => {
      await assert.rejects(event({ log_index: 10, amount_atomic: '3.2e8' }), /market_venue_transfers_amount_digits/);
    });

    test('a cursor cannot start at block zero', async () => {
      await assert.rejects(
        sql!`
          INSERT INTO market_tail_cursors (tail_key, chain_id, last_block, last_run_at)
          VALUES ('t', 8453, 0::bigint, now())`,
        /market_tail_cursors_block_positive/,
      );
    });
  });
}
