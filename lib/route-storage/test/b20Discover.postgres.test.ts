import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

import { B20_DISCOVER_LANE_V1, createDatabaseB20DiscoverRepository } from '../src/index.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import { describeB20DiscoverRepositoryV1 } from './b20Discover.contract.js';

// ---------------------------------------------------------------------------
// T69-A §12.23/§12.24 — migration 0028 tested by violating it, and the shared
// repository contract run against the real thing.
//
// Asserting a constraint in TypeScript proves the application intends it.
// Writing the row proves the database enforces it — which is what still holds
// when a future task writes to these tables through some other path.
//
// The two that matter most:
//
//   * A FAILED RUN CANNOT HAVE MOVED THE CURSOR. Nothing re-reads an old range,
//     so a cursor past blocks nobody read is a permanent, invisible gap.
//
//   * LAUNCHES ARE IMMUTABLE. A trigger refuses the UPDATE outright, because
//     "we corrected the name later" turns every earlier measurement anchored to
//     that row into a claim about something that no longer exists.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL,
// and skips otherwise. It drops and recreates its own tables:
//
//   docker run -d --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 55433:5432 postgres:16-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55433/t \
//     npx tsx --test lib/route-storage/test/b20Discover.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const FACTORY = B20_DISCOVER_LANE_V1.factoryAddress;
const DECODER = B20_DISCOVER_LANE_V1.decoderVersion;
const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const TX = `0x${'cd'.repeat(32)}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const T0 = '2026-08-03T00:00:00.000Z';

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

function launchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const transaction_hash = (overrides.transaction_hash as string) ?? TX;
  const log_index = (overrides.log_index as number) ?? 0;
  return {
    id: `${transaction_hash}:${log_index}`,
    chain_id: 8453,
    factory_address: FACTORY,
    token_address: TOKEN,
    variant: 'asset',
    name: 'o1 mascot',
    symbol: 'DINo1',
    decimals: 18,
    block_number: '1050',
    block_hash: BLOCK_HASH,
    transaction_hash,
    transaction_index: 2,
    log_index,
    detected_at: T0,
    confirmation_count: 12,
    decoder_version: DECODER,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    chain_id: 8453,
    factory_address: FACTORY,
    decoder_version: DECODER,
    started_at: T0,
    finished_at: T0,
    start_cursor_block: '1000',
    end_cursor_block: '1100',
    launches_read: 1,
    launches_inserted: 1,
    duplicates: 0,
    budget_exhausted: false,
    result: 'success',
    ...overrides,
  };
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS b20_launches, b20_discover_cursors, b20_discover_runs CASCADE');
  await sql.unsafe('DROP FUNCTION IF EXISTS b20_launches_immutable_identity() CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0028_t69a_b20_discover_ingestion.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

/** Every constraint test starts from empty tables. */
async function reset(): Promise<void> {
  await sql!.unsafe('TRUNCATE b20_launches, b20_discover_cursors, b20_discover_runs');
}

async function refuses(insert: () => Promise<unknown>, hint: string): Promise<void> {
  await assert.rejects(insert, (error: unknown) => {
    assert.ok(error instanceof Error, `${hint} must be refused by the database`);
    return true;
  });
}

describe('migration 0028: a launch is chain evidence the database will not let anyone edit', { skip: !throwaway }, () => {
  test('a well-formed launch is accepted', async () => {
    await reset();
    await sql!`INSERT INTO b20_launches ${sql!(launchRow())}`;
    const rows = await sql!`SELECT canonical, non_canonical_at FROM b20_launches`;
    assert.equal(rows[0]?.canonical, true);
    assert.equal(rows[0]?.non_canonical_at, null);
  });

  test('one log is one launch', async () => {
    await reset();
    await sql!`INSERT INTO b20_launches ${sql!(launchRow())}`;
    await refuses(
      () => sql!`INSERT INTO b20_launches ${sql!(launchRow())}`,
      'a repeated transaction hash and log index',
    );
  });

  test('the same token from a different log is a different launch', async () => {
    // Identity is the LOG. Two events are two facts, and collapsing them by
    // token address would hide a relaunch entirely.
    await reset();
    await sql!`INSERT INTO b20_launches ${sql!(launchRow())}`;
    await sql!`INSERT INTO b20_launches ${sql!(launchRow({ log_index: 4 }))}`;
    const rows = await sql!`SELECT count(*)::int AS n FROM b20_launches WHERE token_address = ${TOKEN}`;
    assert.equal(rows[0]?.n, 2);
  });

  test('chain identity cannot be edited after the fact', async () => {
    await reset();
    await sql!`INSERT INTO b20_launches ${sql!(launchRow())}`;
    for (const [column, value] of [
      ['name', 'something else'],
      ['symbol', 'OTHER'],
      ['token_address', '0x1111111111111111111111111111111111111111'],
      ['decimals', 6],
      ['block_number', '2000'],
      ['block_hash', `0x${'11'.repeat(32)}`],
    ] as const) {
      await refuses(
        () => sql!.unsafe(`UPDATE b20_launches SET ${column} = $1 WHERE id = $2`, [value, `${TX}:0`]),
        `an edit to ${column}`,
      );
    }
  });

  test('a reorg may still mark a launch non-canonical', async () => {
    // The one mutation that is allowed, because it is not a correction: it
    // records that the chain took the block back.
    await reset();
    await sql!`INSERT INTO b20_launches ${sql!(launchRow())}`;
    await sql!`UPDATE b20_launches SET canonical = false, non_canonical_at = ${T0} WHERE id = ${`${TX}:0`}`;
    const rows = await sql!`SELECT canonical FROM b20_launches`;
    assert.equal(rows[0]?.canonical, false);
  });

  test('a launch from another chain or another factory is refused', async () => {
    await reset();
    await refuses(() => sql!`INSERT INTO b20_launches ${sql!(launchRow({ chain_id: 1 }))}`, 'another chain');
    await refuses(
      () => sql!`INSERT INTO b20_launches ${sql!(launchRow({ factory_address: '0x1111111111111111111111111111111111111111' }))}`,
      'another factory',
    );
  });

  test('malformed chain values are refused rather than normalised', async () => {
    await reset();
    for (const [hint, overrides] of [
      ['an upper-case token address', { token_address: TOKEN.toUpperCase() }],
      ['an unknown variant', { variant: 'wrapped' }],
      ['decimals above a uint8', { decimals: 256 }],
      ['a negative log index', { log_index: -1 }],
      ['a truncated block hash', { block_hash: '0xabc' }],
      ['an unknown decoder', { decoder_version: 'b20-created/v2' }],
      ['an id that does not match its own log', { id: 'made-up' }],
      ['canonical with a removal timestamp', { non_canonical_at: T0 }],
    ] as const) {
      await refuses(() => sql!`INSERT INTO b20_launches ${sql!(launchRow(overrides))}`, hint);
    }
  });
});

describe('migration 0028: a failed run cannot look like a quiet chain', { skip: !throwaway }, () => {
  test('a successful run is accepted', async () => {
    await reset();
    await sql!`INSERT INTO b20_discover_runs ${sql!(runRow())}`;
    assert.equal((await sql!`SELECT count(*)::int AS n FROM b20_discover_runs`)[0]?.n, 1);
  });

  test('an inert result may not have moved the cursor', async () => {
    // THE constraint. Advancing past a range that was never read produces a
    // gap that is both permanent and indistinguishable from a quiet hour.
    await reset();
    for (const result of [
      'endpoint_unavailable',
      'decoder_mismatch',
      'configuration_required',
      'storage_unavailable',
      'run_already_active',
    ]) {
      await refuses(
        () =>
          sql!`INSERT INTO b20_discover_runs ${sql!(
            runRow({ id: `run-${result}`, result, start_cursor_block: '1000', end_cursor_block: '1100', launches_read: 0, launches_inserted: 0 }),
          )}`,
        `${result} moving the cursor`,
      );
    }
  });

  test('an inert result may not have stored a launch', async () => {
    await reset();
    await refuses(
      () =>
        sql!`INSERT INTO b20_discover_runs ${sql!(
          runRow({ result: 'endpoint_unavailable', end_cursor_block: '1000', launches_read: 1, launches_inserted: 1 }),
        )}`,
      'a failed run claiming a stored launch',
    );
  });

  test('only a reorg rewind moves the cursor backwards', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_discover_runs ${sql!(runRow({ start_cursor_block: '1100', end_cursor_block: '1000' }))}`,
      'a successful run moving backwards',
    );
    await sql!`INSERT INTO b20_discover_runs ${sql!(
      runRow({
        id: 'run-reorg',
        result: 'reorg_rewound',
        start_cursor_block: '1100',
        end_cursor_block: '1000',
        launches_read: 0,
        launches_inserted: 0,
      }),
    )}`;
  });

  test('an error category is a code, never a provider message', async () => {
    // Provider messages carry endpoints, and endpoints carry keys.
    await reset();
    await refuses(
      () =>
        sql!`INSERT INTO b20_discover_runs ${sql!(
          runRow({ error_category: 'request to https://mainnet.example/v2/KEY failed' }),
        )}`,
      'a URL in the error category',
    );
    await refuses(
      () => sql!`INSERT INTO b20_discover_runs ${sql!(runRow({ error_category: 'Endpoint Unavailable!' }))}`,
      'a free-text error category',
    );
  });

  test('a run cannot claim more stored than it read, or finish before it started', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_discover_runs ${sql!(runRow({ launches_read: 1, launches_inserted: 2 }))}`,
      'more stored than read',
    );
    await refuses(
      () => sql!`INSERT INTO b20_discover_runs ${sql!(runRow({ started_at: '2026-08-03T01:00:00.000Z' }))}`,
      'a run finishing before it started',
    );
  });

  test('an unknown result is refused', async () => {
    await reset();
    await refuses(() => sql!`INSERT INTO b20_discover_runs ${sql!(runRow({ result: 'ok' }))}`, 'an unknown result');
  });
});

describe('migration 0028: a cursor is one lane, one lock', { skip: !throwaway }, () => {
  const cursorRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: `8453:${FACTORY}:${DECODER}`,
    chain_id: 8453,
    factory_address: FACTORY,
    decoder_version: DECODER,
    last_processed_block: '1000',
    ...overrides,
  });

  test('a well-formed cursor is accepted and has no lease', async () => {
    await reset();
    await sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow())}`;
    const rows = await sql!`SELECT lease_owner, last_processed_block_hash FROM b20_discover_cursors`;
    assert.equal(rows[0]?.lease_owner, null);
    assert.equal(rows[0]?.last_processed_block_hash, null, 'a cold cursor has no hash, so it is not a reorg');
  });

  test('one lane cannot have two cursors', async () => {
    await reset();
    await sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow())}`;
    await refuses(
      () => sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow({ id: 'other' }))}`,
      'a second cursor on one lane',
    );
  });

  test('a half-set lease is refused, because it could never be broken', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow({ lease_owner: 'worker-a' }))}`,
      'an owner with no expiry',
    );
    await refuses(
      () => sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow({ lease_expires_at: T0 }))}`,
      'an expiry with no owner',
    );
  });

  test('a cursor id must be derived from its own lane', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow({ id: 'discover' }))}`,
      'an invented cursor id',
    );
  });

  test('an unknown operator state is refused', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_discover_cursors ${sql!(cursorRow({ operator_state: 'confused' }))}`,
      'an unknown operator state',
    );
  });
});

// §12.23 — the same contract the in-memory store must satisfy, against
// Postgres. A disagreement between the two fails here rather than in
// production at 3am.
if (throwaway) {
  describeB20DiscoverRepositoryV1('postgres', async () => {
    await reset();
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      sql!(strings, ...values) as unknown as Promise<Record<string, unknown>[]>;
    return {
      repository: createDatabaseB20DiscoverRepository(executor),
      async breakWrites() {
        // A real statement failure inside the commit CTE, so "neither the
        // cursor nor the launches became durable" is tested against the
        // database's own transaction boundary rather than a mock's.
        await sql!.unsafe(`
          CREATE OR REPLACE FUNCTION b20_launches_break_writes() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'simulated storage failure'; END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER b20_launches_break_writes_trigger
            BEFORE INSERT ON b20_launches
            FOR EACH ROW EXECUTE FUNCTION b20_launches_break_writes();
        `);
      },
      async healWrites() {
        await sql!.unsafe('DROP TRIGGER IF EXISTS b20_launches_break_writes_trigger ON b20_launches');
      },
    };
  });
}
