import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';
import postgres from 'postgres';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(
  url
  && (/(localhost|127\.0\.0\.1)/u.test(url) || /host=\/var\/run\/postgresql/u.test(url))
  && !/neon|amazonaws/iu.test(url),
);
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  const parsed = new URL(url!);
  const socketHost = parsed.searchParams.get('host');
  sql = socketHost
    ? postgres({
        host: socketHost,
        database: parsed.pathname.replace(/^\//u, ''),
        username: decodeURIComponent(parsed.username || 'postgres'),
        max: 16,
        onnotice: () => {},
      })
    : postgres(url!, { max: 16, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS base_mcp_action_receipt_events CASCADE');
  await sql.unsafe('DROP TABLE IF EXISTS base_mcp_action_receipts CASCADE');
  await sql.unsafe(`
    CREATE TABLE base_mcp_action_receipts (id text PRIMARY KEY, tenant_id text NOT NULL);
    CREATE TABLE base_mcp_action_receipt_events (
      id text PRIMARY KEY, receipt_id text NOT NULL, tenant_id text NOT NULL,
      sequence integer NOT NULL, event_hash text NOT NULL, status text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL,
      UNIQUE (receipt_id, sequence)
    );
    INSERT INTO base_mcp_action_receipts (id, tenant_id) VALUES ('receipt-1', 'tenant-1');
  `);
  const migration = await readFile(resolve(drizzleDir(), '0040_base_mcp_action_event_sequence.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => { await sql?.end({ timeout: 5 }); });

if (!throwaway) {
  describe('atomic Base MCP Action Receipt event allocation', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  test('concurrent appenders retain every event with a gapless unique sequence', async () => {
    const total = 48;
    const writes = Array.from({ length: total }, (_, index) => sql!`
      WITH allocated AS (
        UPDATE base_mcp_action_receipts
        SET next_event_sequence = next_event_sequence + 1
        WHERE id = 'receipt-1' AND tenant_id = 'tenant-1'
        RETURNING next_event_sequence - 1 AS sequence
      )
      INSERT INTO base_mcp_action_receipt_events (
        id, receipt_id, tenant_id, sequence, event_hash, status, payload, created_at
      )
      SELECT
        ${`event-${index}`}, 'receipt-1', 'tenant-1', allocated.sequence,
        ${`hash-${index}`}, 'pending', '{}'::jsonb, now()
      FROM allocated
      RETURNING sequence
    `);
    const results = await Promise.all(writes);
    assert.equal(results.length, total);
    assert.ok(results.every((rows) => rows.length === 1));

    const events = await sql!`
      SELECT sequence FROM base_mcp_action_receipt_events
      WHERE receipt_id = 'receipt-1' ORDER BY sequence
    `;
    assert.deepEqual(events.map((row) => row.sequence), Array.from({ length: total }, (_, index) => index));
    const receipts = await sql!`SELECT next_event_sequence FROM base_mcp_action_receipts WHERE id = 'receipt-1'`;
    assert.equal(receipts[0]?.next_event_sequence, total);
  });
}
