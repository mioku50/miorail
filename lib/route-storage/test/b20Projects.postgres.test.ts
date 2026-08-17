import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';

import { createDatabaseB20ProjectRepository } from '../src/b20ProjectsDatabase.js';
import { b20ProjectContractV1 } from './b20Projects.contract.js';

// ---------------------------------------------------------------------------
// The same contract the in-memory repository is held to, run against real
// Postgres — because half the guarantee here is CHECK constraints and a
// foreign key, and a zod schema alone cannot prove those exist.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/b20Projects.postgres.test.ts
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
  await sql.unsafe('DROP TABLE IF EXISTS b20_project_evidence CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS b20_project_claims CASCADE');
  // Every migration, in order. 0047 widens the reference constraint, and a
  // contract run against 0046 alone would pass on a shape production refuses.
  for (const file of [
    '0046_b20_project_claims.sql',
    '0047_b20_project_evidence_domain_reference.sql',
    '0048_b20_project_evidence_predicate_index.sql',
  ]) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres project claims', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  b20ProjectContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE b20_project_claims CASCADE');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return { repository: createDatabaseB20ProjectRepository(executor) };
  });
}
