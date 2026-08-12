import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

function drizzlePath(file: string): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle', file);
  return resolve(cwd, 'lib', 'db', 'drizzle', file);
}

test('migration 0038 keeps direct actions tenant-scoped, idempotent and append-only', async () => {
  const sql = await readFile(drizzlePath('0038_base_mcp_action_receipts.sql'), 'utf8');

  assert.match(sql, /CREATE TABLE "base_mcp_action_receipts"/);
  assert.match(sql, /FOREIGN KEY \("tenant_id"\)[\s\S]*REFERENCES "public"\."users"/);
  assert.match(sql, /UNIQUE INDEX "base_mcp_action_receipts_tenant_idempotency_unique"/);
  assert.match(sql, /"action_type" IN \('send', 'x402'\)/);
  assert.match(sql, /"chain_id" = 8453/);
  assert.match(sql, /base_mcp_action_receipts_completed_check/);
  assert.match(sql, /"action_type" = 'send' AND "reconciliation_state" = 'matched'/);
  assert.match(sql, /"action_type" = 'x402' AND "reconciliation_state" = 'provider_confirmed'/);
  assert.match(sql, /CREATE TRIGGER base_mcp_action_receipt_events_no_update/);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);

  // Approval links and paid response bodies are deliberately ephemeral.
  assert.doesNotMatch(sql, /approval_url/i);
  assert.doesNotMatch(sql, /response_body/i);
  assert.match(sql, /"response_hash" text/);
});

test('migration 0039 expands only the closed Routes provider constraint set', async () => {
  const sql = await readFile(drizzlePath('0039_swap_pending_intent_providers.sql'), 'utf8');
  for (const provider of ['uniswap', 'kyberswap', 'aerodrome', 'balancer', 'hydrex', 'o1-exchange']) {
    assert.match(sql, new RegExp(`'${provider.replace('-', '\\-')}'`));
  }
  assert.doesNotMatch(sql, /sushiswap|unknown|dynamic/i);
});

test('the migration journal registers 0038 and 0039 in append-only order', async () => {
  const journal = JSON.parse(await readFile(drizzlePath('meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  assert.equal(journal.entries[38]?.tag, '0038_base_mcp_action_receipts');
  assert.equal(journal.entries[39]?.tag, '0039_swap_pending_intent_providers');
  assert.equal(journal.entries[38]?.idx, 38);
  assert.equal(journal.entries[39]?.idx, 39);
});
