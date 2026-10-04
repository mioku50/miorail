import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import postgres from 'postgres';

import { createDatabasePoolYieldReadingRepository } from '../src/poolYieldsDatabase.js';
import { poolYieldsContract } from './poolYields.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
// This suite truncates a table. Require the named disposable database and a local endpoint.
const temporary = !!url && /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_pool_yields_test$/.test(url);
let sql: ReturnType<typeof postgres>;
before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  const root = process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  // Twice: the migration must run again over itself without failing.
  for (let pass = 0; pass < 2; pass += 1) {
    await sql.unsafe(await readFile(resolve(root, '0082_pool_yield_readings.sql'), 'utf8'));
  }
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});
if (!temporary) test('disposable Postgres pool yields test', { skip: true }, () => {});
else
  poolYieldsContract('postgres', async () => {
    await sql`TRUNCATE pool_yield_readings RESTART IDENTITY`;
    return createDatabasePoolYieldReadingRepository((strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
        strings,
        ...values,
      ),
    );
  });
