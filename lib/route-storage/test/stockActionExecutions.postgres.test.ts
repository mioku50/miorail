import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { before, after } from 'node:test';
import postgres from 'postgres';
import { createDatabaseStockActionExecutionRepositoryV1 } from '../src/stockActionExecutions.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import { stockActionExecutionContract } from './stockActionExecutions.contract.js';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
const temporary = (() => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'postgres:' && parsed.hostname === '127.0.0.1'
      && parsed.port !== '' && parsed.pathname === '/miorail_agent_proof_test';
  } catch { return false; }
})();
let sql: ReturnType<typeof postgres>;

before(async () => {
  if (!temporary) return;
  sql = postgres(url!, { max: 1, onnotice() {} });
  await sql.unsafe('DO $$ BEGIN CREATE ROLE miorail_user; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
  await sql.unsafe('GRANT USAGE, CREATE ON SCHEMA public TO miorail_user');
  await sql.unsafe('SET ROLE miorail_user');
  await sql.unsafe('CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY)');
  const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '../db/drizzle')
    : resolve(process.cwd(), 'lib/db/drizzle');
  const migration = (await readFile(resolve(root, '0090_stock_action_executions.sql'), 'utf8'))
    .replaceAll('--> statement-breakpoint', '');
  await sql.unsafe(migration);
  await sql.unsafe(migration); // The application's own role can apply it twice.
  for (const digit of ['1', '2']) {
    await sql`INSERT INTO users (id) VALUES (${`eip155:8453:0x${digit.repeat(40)}`}) ON CONFLICT DO NOTHING`;
  }
});
after(async () => { if (sql) await sql.end({ timeout: 5 }); });

if (temporary) {
  stockActionExecutionContract('Postgres / app role', async () => {
    await sql.unsafe('TRUNCATE stock_action_executions RESTART IDENTITY');
    const execute: SqlTemplateExecutor = (strings, ...values) =>
      (sql as unknown as SqlTemplateExecutor)(strings, ...values);
    return createDatabaseStockActionExecutionRepositoryV1(execute);
  });
  test('database constraints refuse partial links and a mismatched tenant', async () => {
    const wallet = `0x${'1'.repeat(40)}`, tenant = `eip155:8453:${wallet}`;
    await assert.rejects(sql`INSERT INTO stock_action_executions
      (tenant_id, wallet_address, action_draft_id, clearance_id, created_at)
      VALUES (${tenant}, ${wallet}, 'partial', 'clearance', now())`);
    await assert.rejects(sql`INSERT INTO stock_action_executions
      (tenant_id, wallet_address, action_draft_id, created_at)
      VALUES (${tenant}, ${`0x${'2'.repeat(40)}`}, 'wrong-owner', now())`);
    const owner = await sql`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'stock_action_executions'`;
    assert.equal(owner[0]!.owner, 'miorail_user');
  });
} else {
  test('stock draft links require the named disposable local Postgres database', { skip: true }, () => {});
}
