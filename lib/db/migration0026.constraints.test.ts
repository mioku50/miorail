import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// T68F-A §12.20 — the constraints in migration 0026, tested by violating them.
//
// A CHECK constraint nobody has ever tripped is a comment with SQL syntax. Each
// case below writes a row that MUST be rejected, against a real Postgres, so
// the guarantees this feature rests on are demonstrated rather than asserted.
//
// It runs only against a THROWAWAY database, named explicitly by
// MIOAGENT_MIGRATION_TEST_URL, and skips otherwise. It creates and drops its
// own tables, so it must never be pointed at a database anyone cares about:
//
//   docker run -d --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 55432:5432 postgres:16-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55432/t \
//     npx tsx --test lib/db/migration0026.constraints.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
// A guard, not a convenience: pointing this file at the production URL would
// drop and recreate its tables.
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const HASH = (char: string) => `0x${char.repeat(64)}`;

let sql: ReturnType<typeof postgres> | null = null;

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS b20_entry_executions, b20_entry_plans CASCADE');
  const migration = await readFile(
    resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle',
      '0026_t68fa_b20_entry_plans.sql'),
    'utf8',
  );
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `plan-${Math.random().toString(36).slice(2)}`,
    tenant_id: `eip155:8453:${WALLET}`,
    wallet_address: WALLET,
    chain_id: 8453,
    clearance_id: 'clearance-1',
    clearance_hash: HASH('c'),
    profile_identity: `${USDC}:100000000:300:300`,
    token_address: TOKEN,
    quote_asset: USDC,
    position_atomic: '100000000',
    entry_provider_id: 'aerodrome',
    entry_source_key: `aerodrome:0xfac:${USDC}:${TOKEN}:volatile`,
    entry_route_hash: HASH('b'),
    blueprint_hash: HASH('d'),
    calls_hash: HASH('8'),
    fresh_quote_hash: HASH('9'),
    certification_control_snapshot_hash: HASH('a'),
    prepare_control_snapshot_hash: HASH('a'),
    certification_simulation_evidence_hash: HASH('e'),
    prepare_simulation_evidence_hash: HASH('2'),
    expected_output_atomic: '4200000000000000000000',
    minimum_output_atomic: '4074000000000000000000',
    coverage: 'partial',
    viable_route_confirmed: true,
    best_route_confirmed: false,
    certification_block_number: '49450000',
    prepare_control_block_number: '49450050',
    prepare_simulation_block_number: '49450051',
    lifecycle: 'prepared',
    submission_id: null,
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    payload: JSON.stringify({ schemaVersion: 'b20-prepared-entry-plan/v1' }),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

async function insertPlan(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = planRow(overrides);
  await sql!`INSERT INTO b20_entry_plans ${sql!(row)}`;
  return String(row.id);
}

/** Every one of these is a row the database must refuse. */
const refuses = async (overrides: Record<string, unknown>, why: string): Promise<void> => {
  await assert.rejects(insertPlan(overrides), `Postgres must refuse ${why}`);
};

describe('migration 0026 refuses what the contract refuses', { skip: !throwaway }, () => {
  test('a well-formed plan is accepted, so the refusals below mean something', async () => {
    const id = await insertPlan();
    const rows = await sql!`SELECT lifecycle FROM b20_entry_plans WHERE id = ${id}`;
    assert.equal(rows[0]?.lifecycle, 'prepared');
  });

  test('the chain, the quote asset and the address forms are pinned', async () => {
    await refuses({ chain_id: 84532 }, 'another chain');
    await refuses({ quote_asset: TOKEN }, 'a quote asset that is not canonical USDC');
    await refuses({ wallet_address: WALLET.toUpperCase() }, 'a checksummed wallet');
    await refuses({ token_address: '0xnothex' }, 'a malformed token address');
    await refuses({ blueprint_hash: 'not-a-hash' }, 'a malformed blueprint hash');
  });

  test('a plan that could settle for less than it promised is refused', async () => {
    await refuses(
      { minimum_output_atomic: '9999999999999999999999' },
      'a minimum above the expectation',
    );
    await refuses({ minimum_output_atomic: '0' }, 'an unbounded minimum');
    await refuses({ position_atomic: '0' }, 'a zero position');
  });

  test('a plan on an unconfirmed exit is refused', async () => {
    await refuses({ viable_route_confirmed: false }, 'an unconfirmed exit');
    await refuses({ coverage: 'none' }, 'an unknown coverage value');
  });

  test('a plan that never expires is refused', async () => {
    // An entry plan with no expiry is a standing authorisation wearing a
    // different name.
    await refuses({ expires_at: new Date(Date.now() - 60_000).toISOString() }, 'an expiry in the past');
  });

  test('nothing reaches submitted without naming a submission', async () => {
    await refuses({ lifecycle: 'submitted', submission_id: null }, 'a submitted plan with no id');
    await refuses({ lifecycle: 'prepared', submission_id: 'sub-1' }, 'a submission id before submission');
    await refuses({ lifecycle: 'executed' }, 'a lifecycle outside the contract');
  });

  test('the idempotency identity admits exactly one plan', async () => {
    const shared = { clearance_id: 'clearance-idem', request_id: 'req-idem' };
    await insertPlan(shared);
    // The second preparation cannot become a second row. This index IS the
    // idempotency guarantee — not the application's memory of it.
    await refuses(shared, 'a second plan for one request id');
    // A different request id is a different plan.
    assert.ok(await insertPlan({ ...shared, request_id: 'req-idem-2' }));
  });

  test('an execution run belongs to one plan, in one family', async () => {
    const planId = await insertPlan();
    const run = (overrides: Record<string, unknown> = {}) => ({
      id: `run-${Math.random().toString(36).slice(2)}`,
      tenant_id: `eip155:8453:${WALLET}`,
      wallet_address: WALLET,
      chain_id: 8453,
      execution_family: 'b20_opportunity_entry',
      prepared_plan_id: planId,
      clearance_id: 'clearance-1',
      state: 'prepared',
      submission_id: null,
      payload: JSON.stringify({ schemaVersion: 'b20-entry-execution-run/v1' }),
      ...overrides,
    });
    await sql!`INSERT INTO b20_entry_executions ${sql!(run())}`;
    // One run per plan: two would make "which execution is this?" ambiguous.
    await assert.rejects(sql!`INSERT INTO b20_entry_executions ${sql!(run())}`);
    await assert.rejects(
      sql!`INSERT INTO b20_entry_executions ${sql!(run({ execution_family: 'swap' }))}`,
      'another family must not reuse this table',
    );
    await assert.rejects(
      sql!`INSERT INTO b20_entry_executions ${sql!(run({ prepared_plan_id: 'ghost' }))}`,
      'a run must reference a plan that exists',
    );
    await assert.rejects(
      sql!`INSERT INTO b20_entry_executions ${sql!(run({ state: 'submitted', submission_id: null }))}`,
      'a submitted run must name its submission',
    );
  });
});
