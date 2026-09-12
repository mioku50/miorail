import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseB20CorporateActionRepository } from '../src/b20CorporateActionsDatabase.js';
import { b20CorporateActionContractV1 } from './b20CorporateActions.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. Half of this guarantee is a unique
// index and a pair of CHECK constraints that spell out what "decoded" means,
// and a zod schema cannot prove those exist.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/b20CorporateActions.postgres.test.ts
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

async function applyV1(name: string): Promise<void> {
  const migration = await readFile(resolve(drizzleDir(), name), 'utf8');
  await sql!.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'DROP TABLE IF EXISTS b20_corporate_actions, rwa_signals, rwa_signal_watch, market_venue_transfers, market_venues, market_tail_cursors CASCADE',
  );
  // 0051 owns the cursor table this tail shares, and 0055 owns the two tables
  // 0069 widens. Replaying them in order is also the assertion that 0069's
  // ALTERs apply to the constraints those migrations actually created.
  await applyV1('0051_market_tail.sql');
  await applyV1('0055_rwa_signals.sql');
  await applyV1('0069_b20_corporate_actions.sql');
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres b20 corporate actions', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  b20CorporateActionContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE b20_corporate_actions, market_tail_cursors RESTART IDENTITY CASCADE');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseB20CorporateActionRepository(executor) };
  });
}
