import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// T68F-B §15.20 — the constraints in migration 0027, tested by violating them.
//
// The two that matter most are the partial unique indexes. "One live attempt
// per plan" and "one attempt per wallet batch" are the difference between a
// double click costing nothing and a double click costing a second position.
// Asserting them in TypeScript proves the application intends them; writing the
// rows proves the database enforces them.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL,
// and skips otherwise. It drops and recreates its own tables:
//
//   docker run -d --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 55433:5432 postgres:16-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55433/t \
//     npx tsx --test lib/db/migration0027.constraints.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const TENANT = `eip155:8453:${WALLET}`;
const HASH = (char: string) => `0x${char.repeat(64)}`;

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'DROP TABLE IF EXISTS b20_entry_submissions, b20_entry_executions, b20_entry_plans CASCADE',
  );
  for (const file of ['0026_t68fa_b20_entry_plans.sql', '0027_t68fb_b20_entry_submissions.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
  // One plan, so the foreign key below has something real to point at.
  await sql`INSERT INTO b20_entry_plans ${sql({
    id: 'plan-1',
    tenant_id: TENANT,
    wallet_address: WALLET,
    chain_id: 8453,
    clearance_id: 'clearance-1',
    clearance_hash: HASH('c'),
    profile_identity: 'p',
    token_address: TOKEN,
    quote_asset: USDC,
    position_atomic: '100000000',
    entry_provider_id: 'aerodrome',
    entry_source_key: 'k',
    entry_route_hash: HASH('b'),
    blueprint_hash: HASH('d'),
    calls_hash: HASH('8'),
    fresh_quote_hash: HASH('9'),
    certification_control_snapshot_hash: HASH('a'),
    prepare_control_snapshot_hash: HASH('a'),
    certification_simulation_evidence_hash: HASH('e'),
    prepare_simulation_evidence_hash: HASH('2'),
    expected_output_atomic: '100',
    minimum_output_atomic: '100',
    coverage: 'partial',
    viable_route_confirmed: true,
    best_route_confirmed: false,
    certification_block_number: '1',
    prepare_control_block_number: '1',
    prepare_simulation_block_number: '1',
    lifecycle: 'prepared',
    submission_id: null,
    request_id: 'r',
    payload: JSON.stringify({}),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  })}`;
});

after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

function attemptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `attempt-${Math.random().toString(36).slice(2)}`,
    tenant_id: TENANT,
    wallet_address: WALLET,
    chain_id: 8453,
    plan_id: 'plan-1',
    clearance_id: 'clearance-1',
    submitted_calls_hash: HASH('8'),
    batch_id: null,
    status: 'awaiting_wallet_approval',
    terminal_outcome: null,
    error_code: null,
    submitted_at: null,
    payload: JSON.stringify({ schemaVersion: 'b20-entry-submission/v1' }),
    ...overrides,
  };
}

async function insert(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = attemptRow(overrides);
  await sql!`INSERT INTO b20_entry_submissions ${sql!(row)}`;
  return String(row.id);
}

const refuses = async (overrides: Record<string, unknown>, why: string): Promise<void> => {
  await assert.rejects(insert(overrides), `Postgres must refuse ${why}`);
};

describe('migration 0027 refuses what the contract refuses', { skip: !throwaway }, () => {
  test('a well-formed attempt is accepted, so the refusals below mean something', async () => {
    const id = await insert({ id: 'attempt-baseline', plan_id: 'plan-1' });
    const rows = await sql!`SELECT status FROM b20_entry_submissions WHERE id = ${id}`;
    assert.equal(rows[0]?.status, 'awaiting_wallet_approval');
    await sql!`DELETE FROM b20_entry_submissions WHERE id = ${id}`;
  });

  test('one live attempt per plan — the guarantee a double click rests on', async () => {
    const first = await insert();
    await refuses({}, 'a second live attempt for one plan');
    // A declined prompt sent nothing, so it releases the slot.
    await sql!`UPDATE b20_entry_submissions
      SET status = 'terminal', terminal_outcome = 'user_rejected' WHERE id = ${first}`;
    const retry = await insert();
    // ...but an attempt that reached the chain holds it forever.
    await sql!`UPDATE b20_entry_submissions
      SET status = 'submitted', batch_id = 'batch-1', submitted_at = now() WHERE id = ${retry}`;
    await refuses({}, 'a second attempt once one has been submitted');
    await sql!`DELETE FROM b20_entry_submissions`;
  });

  test('one wallet batch belongs to exactly one attempt', async () => {
    await insert({ status: 'submitted', batch_id: 'batch-x', submitted_at: new Date().toISOString() });
    await refuses(
      {
        status: 'terminal',
        terminal_outcome: 'entry_reverted',
        batch_id: 'batch-x',
        submitted_at: new Date().toISOString(),
      },
      'two attempts naming one batch',
    );
    await sql!`DELETE FROM b20_entry_submissions`;
  });

  test('a state that presupposes a batch cannot exist without its id', async () => {
    await refuses({ status: 'submitted' }, 'a submitted attempt with no batch');
    await refuses({ status: 'reconciling' }, 'a reconciling attempt with no batch');
    await refuses({ batch_id: 'b1' }, 'a batch id with no submission time');
  });

  test('an outcome exists exactly when the attempt is terminal', async () => {
    await refuses({ status: 'terminal' }, 'a terminal attempt with no outcome');
    await refuses({ terminal_outcome: 'entry_succeeded' }, 'an outcome on a live attempt');
    await refuses({ status: 'terminal', terminal_outcome: 'failed' }, 'a generic failure');
  });

  test('an outcome must match whether anything was actually sent', async () => {
    await refuses(
      {
        status: 'terminal',
        terminal_outcome: 'user_rejected',
        batch_id: 'batch-r',
        submitted_at: new Date().toISOString(),
      },
      'a rejection that names a batch',
    );
    await refuses(
      { status: 'terminal', terminal_outcome: 'entry_succeeded' },
      'a success with no batch',
    );
  });

  test('the chain, the address form and the plan reference are pinned', async () => {
    await refuses({ chain_id: 84532 }, 'another chain');
    await refuses({ wallet_address: WALLET.toUpperCase() }, 'a checksummed wallet');
    await refuses({ submitted_calls_hash: 'nope' }, 'a malformed calls hash');
    await refuses({ plan_id: 'ghost' }, 'an attempt for a plan that does not exist');
  });
});
