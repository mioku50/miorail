import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseRwaSignalRepository } from '../src/rwaSignalsDatabase.js';
import { rwaSignalContractV1 } from './rwaSignals.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres.
//
// It DROPS the two signal tables, so it runs only against a throwaway local
// database. Pointing it at a database a worker is writing to would delete that
// worker's feed mid-pass.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/rwaSignals.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS rwa_signals CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS rwa_signal_watch CASCADE');
  // Both migrations, in order. 0069 widens the kind CHECK that 0055 created,
  // so replaying the pair is also the proof that its ALTER lands on the
  // constraint that actually exists rather than on one this file invented.
  for (const name of ['0055_rwa_signals.sql', '0069_b20_corporate_actions.sql']) {
    const migration = await readFile(resolve(drizzleDir(), name), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres rwa signals', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  rwaSignalContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE rwa_signals RESTART IDENTITY CASCADE');
    await sql!.unsafe('TRUNCATE rwa_signal_watch CASCADE');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseRwaSignalRepository(executor) };
  });
}
