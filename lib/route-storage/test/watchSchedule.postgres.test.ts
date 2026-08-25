import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseWatchScheduleRepository } from '../src/watchScheduleDatabase.js';
import { watchScheduleContractV1 } from './watchSchedule.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. It DROPS the table, so it runs
// only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/watchSchedule.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS watch_schedule CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0056_watch_schedule.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres watch schedule', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  watchScheduleContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE watch_schedule');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseWatchScheduleRepository(executor) };
  });
}
