import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import postgres from 'postgres';

import { createDatabaseReopenGameRepositoryV1 } from '../src/reopenGameDatabase.js';
import { reopenGameContract } from './reopenGame.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
// This suite truncates tables. Require the named disposable database and local endpoint.
const temporary = !!url && /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_reopen_game_test$/.test(url);
let sql: ReturnType<typeof postgres>;
before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  const root = process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  // Twice: the migration must run again over itself without failing.
  for (let pass = 0; pass < 2; pass += 1) {
    await sql.unsafe(await readFile(resolve(root, '0079_reopen_game.sql'), 'utf8'));
  }
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});
if (!temporary) test('disposable Postgres reopen game test', { skip: true }, () => {});
else
  reopenGameContract('postgres', async () => {
    await sql`TRUNCATE reopen_picks, reopen_players, reopen_rounds`;
    return createDatabaseReopenGameRepositoryV1((strings, ...values) =>
      (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
        strings,
        ...values,
      ),
    );
  });
