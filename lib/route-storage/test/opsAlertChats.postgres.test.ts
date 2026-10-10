import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';
import postgres from 'postgres';

import { createDatabaseOpsAlertChatRepositoryV1 } from '../src/opsAlertChats.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import { opsAlertChatContractV1 } from './opsAlertChats.contract.js';

// ---------------------------------------------------------------------------
// The service-alert chats contract against real Postgres, with migration 0085
// applied twice (it is re-runnable) — the one-statement redeem and the CHECKs
// are the tables' to keep, and only a database can show they do.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/opsAlertChats.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 2, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS ops_alert_chats, ops_alert_codes CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0085_ops_alert_chats.sql'), 'utf8');
  for (let pass = 0; pass < 2; pass += 1) await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres service alert chats', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  opsAlertChatContractV1('postgres', async () => {
    await sql!.unsafe('TRUNCATE ops_alert_chats, ops_alert_codes');
    return createDatabaseOpsAlertChatRepositoryV1(sql as unknown as SqlTemplateExecutor);
  });
}
