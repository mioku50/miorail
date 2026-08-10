import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import { createDatabaseB20LaunchPoolRepository } from '../src/b20LaunchPoolsDatabase.js';
import { b20LaunchPoolContractV1 } from './b20LaunchPools.contract.js';

// ---------------------------------------------------------------------------
// The same contract the in-memory repository is held to, run against real
// Postgres — because the CHECK constraints are half of the guarantee and a
// zod schema alone cannot prove they exist.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL:
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/b20LaunchPools.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS b20_launch_pools CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0034_b20_launch_pools.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres launch pool cache', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  b20LaunchPoolContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE b20_launch_pools');
    return { repository: createDatabaseB20LaunchPoolRepository(sql!) };
  });
}
