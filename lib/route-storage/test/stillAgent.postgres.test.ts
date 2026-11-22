import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';
import { createDatabaseStillAgentRepositoryV1 } from '../src/stillAgent.js';
import { stillAgentContractV1 } from './stillAgent.contract.js';

// ---------------------------------------------------------------------------
// The same contract, against real Postgres. It DROPS the tables, so it runs
// only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/stillAgent.postgres.test.ts
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

const TABLES = 'still_agent_passes, still_agent_link_codes, still_agent_errand_runs, still_agent_errands, still_agents';

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 4, prepare: false, onnotice: () => {} });
  await sql.unsafe(`DROP TABLE IF EXISTS ${TABLES} CASCADE`);
  // Applied twice: it must re-run.
  for (let pass = 0; pass < 2; pass += 1) {
    await sql.unsafe((await readFile(resolve(drizzleDir(), '0110_still_agent.sql'), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres Still Agent', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  stillAgentContractV1('postgres', async () => {
    await sql!.unsafe(`TRUNCATE ${TABLES} CASCADE`);
    const executor: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(strings, ...values);
    return createDatabaseStillAgentRepositoryV1(executor);
  });
}
