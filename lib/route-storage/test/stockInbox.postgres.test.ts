import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, after, test } from 'node:test';
import postgres from 'postgres';
import { createDatabaseStockInboxRepositoryV1 } from '../src/stockInboxDatabase.js';
import { stockInboxContract } from './stockInbox.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
// This suite truncates tables. Require the named disposable database and local endpoint.
const temporary =
  !!url && /^postgres:\/\/.*@127\.0\.0\.1:\d+\/miorail_shared_inbox_test$/.test(url);
let sql: ReturnType<typeof postgres>;
before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  const root = process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  for (const file of [
    '0051_market_tail.sql',
    '0055_rwa_signals.sql',
    '0069_b20_corporate_actions.sql',
    '0077_stock_inbox.sql',
  ]) {
    await sql.unsafe(
      (await readFile(resolve(root, file), 'utf8')).replaceAll('--> statement-breakpoint', ''),
    );
  }
});
after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});
if (!temporary) test('disposable Postgres inbox test', { skip: true }, () => {});
else
  stockInboxContract('postgres', async () => {
    await sql`TRUNCATE stock_inbox_reads, stock_inbox_state, rwa_signals RESTART IDENTITY CASCADE`;
    return {
      repository: createDatabaseStockInboxRepositoryV1(
        (strings, ...values) => sql(strings, ...values) as any,
      ),
      async add(rows) {
        for (const row of rows)
          await sql`INSERT INTO rwa_signals
        (id,chain_id,kind,subject_address,official_address,occurred_at,recorded_at,dedupe_key,facts)
        VALUES (${row.signalId},8453,${row.kind},${row.subjectAddress},${row.officialAddress},${row.occurredAt},${row.recordedAt},${row.signalId},${JSON.stringify(row.facts)}::text::jsonb)`;
      },
    };
  });
