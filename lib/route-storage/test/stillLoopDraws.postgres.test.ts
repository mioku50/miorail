import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';
import { createDatabaseStillLoopDrawRepositoryV1 } from '../src/stillLoopDraws.js';
import { stillLoopDrawsContractV1 } from './stillLoopDraws.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. It DROPS the tables, so it runs
// only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/stillLoopDraws.postgres.test.ts
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
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS still_loop_draws, still_loop_free_entries, still_loop_entries CASCADE');
  // Applied in order, and each twice: they must re-run.
  for (const file of ['0103_still_loop_draws.sql', '0104_still_loop_draw_entries.sql']) {
    for (let pass = 0; pass < 2; pass += 1) {
      await sql.unsafe((await readFile(resolve(drizzleDir(), file), 'utf8')).replaceAll('--> statement-breakpoint', ''));
    }
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres Still Loop draws', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  stillLoopDrawsContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE still_loop_draws, still_loop_entries');
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return createDatabaseStillLoopDrawRepositoryV1(executor);
  });
}
