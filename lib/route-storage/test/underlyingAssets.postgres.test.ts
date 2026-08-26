import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseUnderlyingAssetRepository } from '../src/underlyingAssetsDatabase.js';
import { underlyingAssetContractV1 } from './underlyingAssets.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. It DROPS the tables, so it runs
// only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55441/t \
//     npx tsx --test lib/route-storage/test/underlyingAssets.postgres.test.ts
//
// The in-memory twin is only worth having if it refuses what Postgres refuses.
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
  for (const table of [
    'representation_underlying',
    'underlying_asset',
    'issuer_representation',
    'issuer_membership_check',
    'representation_ratio_change',
    'representation_ratio',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const file of ['0057_representation_ratio.sql', '0058_issuer_membership.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres underlying assets', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  underlyingAssetContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE representation_underlying, underlying_asset');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseUnderlyingAssetRepository(executor) };
  });
}
