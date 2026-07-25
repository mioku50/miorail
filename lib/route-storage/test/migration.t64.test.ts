import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// T64.2: the durable commerce tables. These assertions are about the SHAPE of
// the migration, not about a live database — they catch a schema/migration
// drift before it ever reaches Postgres.

const T64_TABLES = [
  'commerce_candidates',
  'commerce_evidence',
  'commerce_route_cards',
  'commerce_orders',
  'commerce_order_events',
  'commerce_proofs',
];

async function migration(): Promise<string> {
  return readFile(resolve(process.cwd(), '../db/drizzle/0015_t64_commerce_storage.sql'), 'utf8');
}

test('the migration creates every commerce table', async () => {
  const sql = await migration();
  for (const table of T64_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`), `${table} must be created`);
  }
});

test('the migration is additive: it creates and re-checks, it never drops a table', async () => {
  const sql = await migration();
  assert.ok(!/DROP TABLE/i.test(sql), 'no table may be dropped');
  assert.ok(!/DELETE FROM/i.test(sql), 'no row may be deleted');
  // The only DROP is the goal CHECK constraint, immediately re-added wider.
  const drops = sql.match(/DROP CONSTRAINT "([^"]+)"/g) ?? [];
  assert.deepEqual(drops, ['DROP CONSTRAINT "route_runs_goal_check"']);
  assert.match(sql, /route_runs_goal_check" CHECK \("route_runs"\."goal" IN \('swap', 'earn', 'commerce'\)\)/);
});

test('one order per idempotency key is a DATABASE guarantee, not application logic', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "commerce_orders_user_idempotency_unique" ON "commerce_orders" USING btree \("user_id", "idempotency_key"\)/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "commerce_orders_user_invoice_unique" ON "commerce_orders" USING btree \("user_id", "invoice_id"\)/,
  );
});

test('the order row can exist before an invoice does', async () => {
  const sql = await migration();
  // invoice_id / exact_amount_atomic / pay_to are nullable on purpose: the row
  // is reserved BEFORE the provider is called, which is what makes an
  // uncertain result durable instead of lost.
  assert.match(sql, /"invoice_id" text,/);
  assert.match(sql, /"exact_amount_atomic" text,/);
  assert.match(sql, /'pending', 'created'/);
  assert.match(sql, /'creation_unknown'/);
});

test('every commerce table is tenant-scoped', async () => {
  const sql = await migration();
  for (const table of T64_TABLES) {
    const block = sql.slice(sql.indexOf(`CREATE TABLE "${table}"`));
    assert.match(block.slice(0, 2000), /"user_id" text NOT NULL/, `${table} must carry user_id`);
  }
});

test('no commerce table has a column for a delivery secret', async () => {
  const sql = await migration();
  for (const forbidden of ['redemption', 'pin', 'secret', 'code', 'api_key', 'access_token']) {
    assert.ok(
      !new RegExp(`"[a-z_]*${forbidden}[a-z_]*" text`).test(sql),
      `no column may be named after "${forbidden}"`,
    );
  }
});

test('the drizzle schema declares the same commerce tables', async () => {
  const schema = await readFile(resolve(process.cwd(), '../db/schema.ts'), 'utf8');
  for (const table of T64_TABLES) {
    assert.match(schema, new RegExp(`pgTable\\(\\s*['"]${table}['"]`));
  }
});

test('_journal.json registers 0015 as the newest entry', async () => {
  const journalRaw = await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8');
  const journal = JSON.parse(journalRaw) as { entries: Array<{ idx: number; tag: string }> };
  const last = journal.entries.at(-1);
  assert.equal(last?.tag, '0015_t64_commerce_storage');
  assert.equal(last?.idx, 15);
});
