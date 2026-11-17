import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import assert from 'node:assert/strict';

import { createDatabaseStillLoanAlertRepositoryV1 } from '../src/stillLoanAlerts.js';
import { stillLoanAlertsContractV1 } from './stillLoanAlerts.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. It DROPS the table, so it runs
// only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/stillLoanAlerts.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS still_loan_alerts, still_loan_notices, lending_executions CASCADE');
  // The alerts table as 0093 made it, then 0099, 0100 and 0101 on top, each twice: they must re-run.
  for (const file of ['0093_still_loan_alerts.sql', '0099_still_loan_notices.sql', '0099_still_loan_notices.sql',
    '0100_still_loan_closed_recovered_rate.sql', '0100_still_loan_closed_recovered_rate.sql',
    '0101_still_loan_weekend_notices.sql', '0101_still_loan_weekend_notices.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
  // The borrows a loan opened is told from: 0091 needs only the users it points at.
  await sql.unsafe('CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY)');
  await sql.unsafe((await readFile(resolve(drizzleDir(), '0091_lending_executions.sql'), 'utf8')).replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres Still loan alerts', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  stillLoanAlertsContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE still_loan_alerts, still_loan_notices');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return createDatabaseStillLoanAlertRepositoryV1(executor);
  });

  describe('postgres: the borrows a channel has not told', () => {
    const WALLET = '0x1111111111111111111111111111111111111111';
    const MARKET = `0x${'ab'.repeat(32)}`;
    const executor = (): SqlTemplateExecutor => (strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(strings, ...values);
    const insert = async (id: string, state: 'confirmed' | 'submitted', updatedAt: string, operation: 'borrow' | 'repay' = 'borrow',
      remainingDebtAssets = '46800001') => {
      const hash = `0x${'cd'.repeat(32)}`;
      await sql!.unsafe(`
        INSERT INTO lending_executions (execution_id, tenant_id, wallet_address, draft_id, venue, operation, market_id, calls_hash, run_json,
          state, attempt_id, transaction_hash, verification_json, created_at, updated_at, expires_at)
        VALUES ('${id}', 'eip155:8453:${WALLET}', '${WALLET}', 'draft-${id.slice(-4)}', 'morpho', '${operation}', '${MARKET}', '${hash}',
          jsonb_build_object('state', 'ready', 'callsHash', '${hash}', 'facts', jsonb_build_object('venue', 'morpho', 'operation', '${operation}',
            'marketId', '${MARKET}', 'requestedAssets', '46800000', 'collateralSymbol', 'PAXG')),
          '${state}', '00000000-0000-4000-8000-0000000000aa', ${state === 'confirmed' ? `'0x${'ef'.repeat(32)}'` : 'NULL'},
          ${state === 'confirmed' ? `'{"effect":{"appliedAssets":"46800000","remainingDebtAssets":"${remainingDebtAssets}"}}'::jsonb` : 'NULL'},
          '${updatedAt}', '${updatedAt}', '${updatedAt}'::timestamptz + interval '1 day')`);
    };

    test('confirmed, recent, of a given wallet, untold on this channel; with its facts and verified effect', async () => {
      await sql!.unsafe('TRUNCATE lending_executions, still_loan_notices');
      await sql!.unsafe(`INSERT INTO users (id) VALUES ('eip155:8453:${WALLET}') ON CONFLICT DO NOTHING`);
      await insert('00000000-0000-4000-8000-000000000001', 'confirmed', '2026-11-17T10:00:00.000Z');
      await insert('00000000-0000-4000-8000-000000000002', 'confirmed', '2026-11-17T01:00:00.000Z');
      await insert('00000000-0000-4000-8000-000000000003', 'submitted', '2026-11-17T10:00:00.000Z');
      const alerts = createDatabaseStillLoanAlertRepositoryV1(executor());
      const since = new Date('2026-11-17T04:00:00.000Z');
      const [due, ...rest] = await alerts.openedDue({ channel: 'telegram', wallets: [WALLET], since });
      assert.equal(rest.length, 0);
      assert.deepEqual([due!.executionId, due!.venue, due!.marketId, due!.confirmedAt, due!.facts.requestedAssets, due!.proof?.appliedAssets],
        ['00000000-0000-4000-8000-000000000001', 'morpho', MARKET, '2026-11-17T10:00:00.000Z', '46800000', '46800000']);
      assert.deepEqual(await alerts.openedDue({ channel: 'telegram', wallets: ['0x2222222222222222222222222222222222222222'], since }), []);
      await alerts.recordNotice({ channel: 'telegram', kind: 'opened', key: due!.executionId, walletAddress: WALLET, market: MARKET, at: since });
      assert.deepEqual(await alerts.openedDue({ channel: 'telegram', wallets: [WALLET], since }), []);
      assert.equal((await alerts.openedDue({ channel: 'base_app', wallets: [WALLET], since })).length, 1);
    });

    test('a repayment is told when it is confirmed, recent and left no debt; a borrow is not one', async () => {
      await sql!.unsafe('TRUNCATE lending_executions, still_loan_notices');
      await sql!.unsafe(`INSERT INTO users (id) VALUES ('eip155:8453:${WALLET}') ON CONFLICT DO NOTHING`);
      await insert('00000000-0000-4000-8000-000000000011', 'confirmed', '2026-11-17T10:00:00.000Z', 'repay', '0');
      await insert('00000000-0000-4000-8000-000000000012', 'confirmed', '2026-11-17T10:00:00.000Z', 'repay', '26810000');
      await insert('00000000-0000-4000-8000-000000000013', 'confirmed', '2026-11-17T01:00:00.000Z', 'repay', '0');
      await insert('00000000-0000-4000-8000-000000000014', 'confirmed', '2026-11-17T10:00:00.000Z', 'borrow', '0');
      await insert('00000000-0000-4000-8000-000000000015', 'submitted', '2026-11-17T10:00:00.000Z', 'repay');
      const alerts = createDatabaseStillLoanAlertRepositoryV1(executor());
      const since = new Date('2026-11-17T04:00:00.000Z');
      const due = await alerts.closedDue({ channel: 'telegram', wallets: [WALLET], since });
      assert.deepEqual(due.map((row) => [row.executionId, row.facts.operation, row.proof?.remainingDebtAssets]),
        [['00000000-0000-4000-8000-000000000011', 'repay', '0']]);
      await alerts.recordNotice({ channel: 'telegram', kind: 'closed', key: due[0]!.executionId, walletAddress: WALLET, market: MARKET, at: since });
      assert.deepEqual(await alerts.closedDue({ channel: 'telegram', wallets: [WALLET], since }), []);
      assert.equal((await alerts.closedDue({ channel: 'base_app', wallets: [WALLET], since })).length, 1);
    });
  });
}
