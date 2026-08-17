import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

import { createDatabaseB20ObservationRepository } from '../src/index.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import { describeB20ObservationRepositoryV1, observationHashV1 } from './b20Observations.contract.js';

// ---------------------------------------------------------------------------
// T69-B §16.30/§16.31 — migration 0029 tested by violating it, and the shared
// repository contract run against the real thing.
//
// The two constraints worth the trip:
//
//   * THERE IS NO `qualified`. A background worker with no wallet cannot
//     observe a sequential execution, and the database will not store the word
//     even if some future caller tries.
//
//   * OBSERVATIONS ARE IMMUTABLE. A trigger refuses every UPDATE. "We corrected
//     it later" destroys the only record of what was true when somebody looked.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL:
//
//   docker run -d --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 55437:5432 postgres:16-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/b20Observations.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0xb200000000000000000000d6f666fe8b27595c01';
const FACTORY = '0xb20f000000000000000000000000000000000000';
const LAUNCH_ID = `${observationHashV1('1')}:0`;
const T0 = '2026-08-04T00:00:00.000Z';

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

function observationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'obs-1',
    launch_id: LAUNCH_ID,
    chain_id: 8453,
    token_address: TOKEN,
    reference_quote_asset: USDC,
    reference_position_atomic: '100000000',
    max_round_trip_bps: 300,
    max_exit_slippage_bps: 300,
    profile_identity: `${USDC}:100000000:300:300`,
    state: 'provisional',
    reason_code: 'quoted_pre_entry',
    factory_confirmed: true,
    initialized: true,
    entry_route_found: true,
    exit_route_found: true,
    entry_output_atomic: '4000000000000000000000',
    optimistic_exit_return_atomic: '99000000',
    optimistic_round_trip_bps: 100,
    largest_passing_size_atomic: '4000000000000000000000',
    first_failing_size_atomic: '8000000000000000000000',
    capacity_probe_count: 4,
    capacity_tolerance_bps: 300,
    capacity_stable: true,
    route_coverage: 'complete',
    viable_route_confirmed: true,
    best_route_confirmed: true,
    transfers_paused: false,
    transfer_policy_state: 'open',
    controls_complete: true,
    observation_block_number: '49500000',
    observation_block_hash: observationHashV1('e'),
    quote_alignment: 'latest_not_anchored',
    measured_at: T0,
    stale_after: '2026-08-04T00:30:00.000Z',
    measurement_version: 'b20-observation/v1',
    evidence_hash: observationHashV1('f'),
    ...overrides,
  };
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    // `b20_launch_buyers` belongs here too: without it the second run against
    // the same throwaway database fails at `CREATE TABLE`, which reads as a
    // broken test rather than as a stale schema.
    'DROP TABLE IF EXISTS b20_opportunity_observations, b20_measure_leases, b20_launch_buyers, b20_launches, b20_discover_cursors, b20_discover_runs CASCADE',
  );
  await sql.unsafe('DROP FUNCTION IF EXISTS b20_launches_immutable_identity() CASCADE');
  await sql.unsafe('DROP FUNCTION IF EXISTS b20_observations_immutable() CASCADE');
  for (const file of [
    '0028_t69a_b20_discover_ingestion.sql',
    '0029_t69b_b20_opportunity_observations.sql',
    '0030_t69c1_b20_launch_block_timestamp.sql',
    // 0032 was missing here, so this suite had been asserting against a schema
    // narrower than production's since the day ETH-quoted pools were allowed.
    '0032_b20_observation_quote_assets.sql',
    '0033_b20_observation_pool_hook.sql',
    // 0043 and 0045 were missing for the same reason 0032 was, and with the
    // same effect: this suite ran against a schema narrower than production's,
    // so every contract test that touches `venues_consulted` or the live/
    // backfill split failed against Postgres the moment anybody pointed a
    // throwaway database at it. Nobody saw it, because with no
    // MIOAGENT_MIGRATION_TEST_URL the whole file skips.
    '0035_b20_launch_buyers.sql',
    '0043_b20_observation_venues_consulted.sql',
    '0045_b20_launch_ingestion_source.sql',
  ]) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

async function reset(): Promise<void> {
  await sql!.unsafe('TRUNCATE b20_opportunity_observations, b20_measure_leases, b20_launches CASCADE');
}

/** A launch for the foreign key to point at. */
async function seedLaunchRow(
  overrides: {
    id?: string;
    blockNumber?: string;
    tokenAddress?: string;
    detectedAt?: string;
    ingestionSource?: 'live' | 'backfill';
  } = {},
): Promise<void> {
  // `tokenAddress` and `detectedAt` used to be ignored here while the harness
  // interface promised them, which made any contract test that depended on
  // either one vacuous against Postgres — it silently seeded the same token at
  // the same instant every time.
  const id = overrides.id ?? LAUNCH_ID;
  const [transactionHash] = id.split(':') as [string, string];
  await sql!`INSERT INTO b20_launches ${sql!({
    id,
    chain_id: 8453,
    factory_address: FACTORY,
    token_address: overrides.tokenAddress ?? TOKEN,
    variant: 'asset',
    name: 'o1 mascot',
    symbol: 'DINo1',
    decimals: 18,
    block_number: overrides.blockNumber ?? '1050',
    block_hash: observationHashV1('a'),
    transaction_hash: transactionHash,
    log_index: 0,
    detected_at: overrides.detectedAt ?? T0,
    ingestion_source: overrides.ingestionSource ?? 'live',
    confirmation_count: 12,
    decoder_version: 'b20-created/v1',
  })} ON CONFLICT (id) DO NOTHING`;
}

async function refuses(insert: () => Promise<unknown>, hint: string): Promise<void> {
  await assert.rejects(insert, (error: unknown) => {
    assert.ok(error instanceof Error, `${hint} must be refused by the database`);
    return true;
  });
}

describe('migration 0029: a background observation cannot certify', { skip: !throwaway }, () => {
  test('a well-formed provisional observation is accepted', async () => {
    await reset();
    await seedLaunchRow();
    await sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow())}`;
    const rows = await sql!`SELECT state, reason_code FROM b20_opportunity_observations`;
    assert.equal(rows[0]?.state, 'provisional');
    assert.equal(rows[0]?.reason_code, 'quoted_pre_entry');
  });

  test('the word qualified cannot be stored', async () => {
    // The single most important constraint in this migration.
    await reset();
    await seedLaunchRow();
    await refuses(
      () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow({ state: 'qualified' }))}`,
      'a qualified state',
    );
  });

  test('a pass must be labelled as a pre-entry measurement', async () => {
    await reset();
    await seedLaunchRow();
    await refuses(
      () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow({ reason_code: 'no_exit_route' }))}`,
      'a provisional row with the wrong reason',
    );
  });

  test('a rejection with no reason is refused', async () => {
    await reset();
    await seedLaunchRow();
    await refuses(
      () =>
        sql!`INSERT INTO b20_opportunity_observations ${sql!(
          observationRow({ state: 'rejected', reason_code: null }),
        )}`,
      'an unexplained rejection',
    );
  });

  test('a pass without both legs, complete controls or unpaused transfers is refused', async () => {
    await reset();
    await seedLaunchRow();
    for (const [hint, overrides] of [
      ['a missing entry leg', { entry_route_found: false }],
      ['a missing exit leg', { exit_route_found: false }],
      ['an unconfirmed token', { factory_confirmed: false }],
      ['no measured cost', { optimistic_round_trip_bps: null }],
      ['no measured capacity', { largest_passing_size_atomic: null }],
      ['incomplete controls', { controls_complete: false }],
      ['paused transfers', { transfers_paused: true }],
      ['a cost above its own tolerance', { optimistic_round_trip_bps: 900 }],
    ] as const) {
      await refuses(
        () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow(overrides))}`,
        hint,
      );
    }
  });

  test('a best-route claim needs complete coverage and a proven route', async () => {
    await reset();
    await seedLaunchRow();
    await refuses(
      () =>
        sql!`INSERT INTO b20_opportunity_observations ${sql!(
          observationRow({ route_coverage: 'partial', best_route_confirmed: true }),
        )}`,
      'a best-route claim on a partial search',
    );
  });

  test('an observation cannot be edited after the fact', async () => {
    // A changed measurement is a NEW observation.
    await reset();
    await seedLaunchRow();
    await sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow())}`;
    await refuses(
      () => sql!`UPDATE b20_opportunity_observations SET state = 'rejected' WHERE id = 'obs-1'`,
      'an edit to a stored observation',
    );
    await refuses(
      () => sql!`UPDATE b20_opportunity_observations SET measured_at = ${T0} WHERE id = 'obs-1'`,
      'even a no-op edit',
    );
  });

  test('one identity holds one observation', async () => {
    await reset();
    await seedLaunchRow();
    await sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow())}`;
    await refuses(
      () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow({ id: 'obs-2' }))}`,
      'a second observation at the same launch, block, version and profile',
    );
  });

  test('a different block is a different observation', async () => {
    await reset();
    await seedLaunchRow();
    await sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow())}`;
    await sql!`INSERT INTO b20_opportunity_observations ${sql!(
      observationRow({ id: 'obs-2', observation_block_number: '49500100' }),
    )}`;
    const rows = await sql!`SELECT count(*)::int AS n FROM b20_opportunity_observations`;
    assert.equal(rows[0]?.n, 2);
  });

  test('an observation cannot hang off a launch that does not exist', async () => {
    await reset();
    await refuses(
      () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow())}`,
      'an observation with no launch',
    );
  });

  test('malformed values are refused rather than normalised', async () => {
    await reset();
    await seedLaunchRow();
    for (const [hint, overrides] of [
      ['another chain', { chain_id: 1 }],
      ['another quote asset', { reference_quote_asset: '0x4200000000000000000000000000000000000006' }],
      ['an unknown coverage', { route_coverage: 'mostly' }],
      ['an unknown policy state', { transfer_policy_state: 'maybe' }],
      ['an unknown quote alignment', { quote_alignment: 'close_enough' }],
      ['an upper-case token', { token_address: TOKEN.toUpperCase() }],
      ['a truncated block hash', { observation_block_hash: '0xabc' }],
      ['staleness before measurement', { stale_after: '2026-08-03T00:00:00.000Z' }],
      ['a zero position', { reference_position_atomic: '0' }],
    ] as const) {
      await refuses(
        () => sql!`INSERT INTO b20_opportunity_observations ${sql!(observationRow(overrides))}`,
        hint,
      );
    }
  });
});

// §16.30 — the same contract the in-memory store satisfies, against Postgres.
if (throwaway) {
  describeB20ObservationRepositoryV1('postgres', async () => {
    await reset();
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return {
      repository: createDatabaseB20ObservationRepository(executor),
      async seedLaunch(input) {
        await seedLaunchRow({
          id: input.id,
          blockNumber: input.blockNumber,
          tokenAddress: input.tokenAddress,
          detectedAt: input.detectedAt,
          ingestionSource: input.ingestionSource,
        });
      },
    };
  });
}
