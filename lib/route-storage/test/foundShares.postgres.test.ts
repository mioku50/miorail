import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';
import { createDatabaseFoundShareRepositoryV1 } from '../src/foundShares.js';

// ---------------------------------------------------------------------------
// Found's share cards against real Postgres: the receipt table they point at
// (0038 through 0087), then 0088, and 0089's wallet-carried claims. It DROPS
// tables, so it runs only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55438/t \
//     npx tsx --test lib/route-storage/test/foundShares.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));
const RECEIPT = 'base-mcp-action:2b8f0c1e-4d5a-4c3b-9a7e-1f2e3d4c5b6a';

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 4, onnotice: () => {} });
  await sql.unsafe(`DO $$ BEGIN CREATE ROLE miorail_user; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await sql.unsafe('DROP TABLE IF EXISTS found_shares, base_mcp_action_receipt_events, base_mcp_plugin_sessions, base_mcp_action_receipts, users CASCADE');
  await sql.unsafe('CREATE TABLE users ("id" text PRIMARY KEY)');
  for (const file of ['0038_base_mcp_action_receipts', '0040_base_mcp_action_event_sequence', '0049_base_mcp_reviewed_plugin_runtime',
    '0083_aerodrome_claim_receipts', '0087_uniswap_collect_receipts', '0088_found_shares', '0089_found_wallet_claims']) {
    await sql.unsafe((await readFile(resolve(drizzleDir(), `${file}.sql`), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
  await sql.unsafe(`INSERT INTO users VALUES ('tenant-a')`);
  await sql.unsafe(`INSERT INTO base_mcp_action_receipts (id, tenant_id, wallet_address, chain_id, schema_version, action_type, provider,
    status, idempotency_key, action_hash, intent_payload, reconciliation_state, created_at, updated_at, next_event_sequence)
    VALUES ('${RECEIPT}', 'tenant-a', '0x1111111111111111111111111111111111111111', 8453, 'base-mcp-action-receipt/v1',
    'uniswap_collect', 'base-mcp', 'completed', 'k', '0x${'a'.repeat(64)}', '{}', 'matched', now(), now(), 1)`);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

function repository() {
  const executor: SqlTemplateExecutor = (strings, ...values) =>
    (sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(strings, ...values);
  return createDatabaseFoundShareRepositoryV1(executor);
}

const card = { receiptId: RECEIPT, tenantId: 'tenant-a', protocol: 'uniswap' as const, usdCents: 1_153,
  tokens: [{ symbol: 'WETH', amount: '0.0042' }, { symbol: 'USDC', amount: '1.53' }], blockNumber: '37123456',
  at: new Date('2026-10-11T22:00:00.000Z') };

if (!throwaway) {
  describe('postgres Found share cards', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres Found share cards', () => {
    test('two racing clicks make one card; the code and the receipt read it back as made', async () => {
      const shares = repository();
      const [first, second] = await Promise.all([shares.make(card), shares.make({ ...card, usdCents: 9_999 })]);
      assert.equal(first.code, second.code);
      assert.deepEqual(first.tokens, card.tokens, 'jsonb comes back as the array it was');
      assert.deepEqual(await shares.byCode(first.code), first);
      assert.deepEqual(await shares.byReceipt(RECEIPT, 'tenant-a'), first);
      const rows = await sql!.unsafe('SELECT count(*)::int AS n, jsonb_typeof(min(tokens::text)::jsonb) AS kind FROM found_shares');
      assert.deepEqual([rows[0]!.n, rows[0]!.kind], [1, 'array']);
    });

    test('another tenant reads nothing and makes nothing on this receipt', async () => {
      const shares = repository();
      assert.equal(await shares.byReceipt(RECEIPT, 'tenant-b'), null);
      await assert.rejects(shares.make({ ...card, tenantId: 'tenant-b' }), /owner/);
    });

    test('the table refuses what the store refuses, and a receipt that does not exist', async () => {
      await assert.rejects(sql!.unsafe(`INSERT INTO found_shares VALUES ('short', '${RECEIPT}', 't', 'uniswap', 1, '[{}]', '1', now())`));
      await assert.rejects(sql!.unsafe(`INSERT INTO found_shares VALUES ('ZZZZZZZZZZZZ', 'base-mcp-action:nope', 't', 'uniswap', 1, '[{}]', '1', now())`));
      await assert.rejects(sql!.unsafe(`INSERT INTO found_shares VALUES ('YYYYYYYYYYYY', '${RECEIPT}x', 't', 'morpho', 1, '[{}]', '1', now())`));
    });

    test('0089: only Found\'s two claims may ride the person\'s own wallet, still one open per wallet', async () => {
      const insert = (id: string, actionType: string, provider: string) => sql!.unsafe(`INSERT INTO base_mcp_action_receipts (id, tenant_id,
        wallet_address, chain_id, schema_version, action_type, provider, status, idempotency_key, action_hash, intent_payload,
        reconciliation_state, created_at, updated_at, next_event_sequence) VALUES ('base-mcp-action:${id}', 'tenant-a',
        '0x1111111111111111111111111111111111111111', 8453, 'base-mcp-action-receipt/v1', '${actionType}', '${provider}',
        'approval_required', '${id}', '0x${'b'.repeat(64)}', '{}', 'not_started', now(), now(), 1)`);
      await insert('wallet-collect', 'uniswap_collect', 'wallet');
      await insert('wallet-claim', 'aerodrome_claim', 'wallet');
      await assert.rejects(insert('wallet-send', 'send', 'wallet'), /provider_check/);
      await assert.rejects(insert('wallet-x402', 'x402', 'wallet'), /provider_check/);
      await assert.rejects(insert('other-provider', 'uniswap_collect', 'coinbase'), /provider_check/);
      // Wallet MCP's own rows are untouched by the change.
      await insert('mcp-send', 'send', 'base-mcp');
      // An open wallet claim still blocks an open Wallet MCP one of its kind.
      await assert.rejects(insert('mcp-collect', 'uniswap_collect', 'base-mcp'), /active_wallet_unique/);
    });
  });
}
