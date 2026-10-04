import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import postgres from 'postgres';

import { createDatabaseMarketPoolReadingRepository } from '../src/poolReadingsDatabase.js';
import { poolReadingsContract } from './poolReadings.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
// This suite truncates a table. Require the named disposable database and a local endpoint.
const temporary = !!url && /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_pool_readings_test$/.test(url);
let sql: ReturnType<typeof postgres>;
before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  const root = process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  const [{ exists }] = await sql`SELECT to_regclass('market_pool_readings') IS NOT NULL AS exists`;
  if (!exists) await sql.unsafe(await readFile(resolve(root, '0068_market_pool_readings.sql'), 'utf8'));
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});
if (!temporary) test('disposable Postgres pool readings test', { skip: true }, () => {});
else
  poolReadingsContract('postgres', async () => {
    await sql`TRUNCATE market_pool_readings`;
    return createDatabaseMarketPoolReadingRepository((strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
        strings,
        ...values,
      ),
    );
  });
