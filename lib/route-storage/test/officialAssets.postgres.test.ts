import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseOfficialAssetRepository } from '../src/officialAssetsDatabase.js';
import { officialAssetContractV1 } from './officialAssets.contract.js';

// ---------------------------------------------------------------------------
// The same contract the in-memory repository is held to, run against real
// Postgres -- because half of this guarantee is CHECK constraints and a
// foreign key, and a zod schema alone cannot prove those exist.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/officialAssets.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS official_assets CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS official_asset_sources CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0050_official_assets.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres official assets', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  officialAssetContractV1('postgres', async () => {
    // The sources table is truncated too, and CASCADE takes membership with
    // it: a test that started with yesterday's snapshot still standing would
    // measure a different definition of "currently listed".
    await sql!.unsafe('TRUNCATE official_asset_sources, official_assets RESTART IDENTITY CASCADE');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseOfficialAssetRepository(executor) };
  });
}
