import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

import {
  createDatabaseMcpExecutionAuditRepository,
  createDatabaseMcpHandoffRevocationRepository,
  mcpAuditRowV1,
} from '../src/index.js';
import type { SqlTemplateExecutor } from '../src/types.js';

// ---------------------------------------------------------------------------
// T72-C §9 — migration 0031 tested by violating it.
//
// The guarantees worth the trip are the ones that make this table safe to hold
// an execution trail:
//
//   * THERE IS NOWHERE TO PUT A CREDENTIAL. Every column is either a bounded
//     identifier or an enumerated outcome. A bearer token does not fit in
//     `token_id`, and calldata does not fit in `calls_hash`.
//
//   * THE OUTCOME VOCABULARY IS CLOSED. An invented outcome is refused by the
//     database, not merely by the zod schema in front of it.
//
//   * AUDIT ROWS ARE APPEND-ONLY. A row that can be rewritten is not an audit
//     row, so UPDATE and DELETE both raise.
//
// Runs only against a THROWAWAY database named by MIOAGENT_MIGRATION_TEST_URL:
//
//   docker run -d --name mio-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t \
//     -p 55437:5432 postgres:16-alpine
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/mcpExecutionAudit.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const HASH = `0x${'a'.repeat(64)}`;
const NOW = new Date('2026-08-06T12:00:00.000Z');

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS mcp_execution_audit, mcp_handoff_revocations CASCADE');
  await sql.unsafe('DROP FUNCTION IF EXISTS mcp_execution_audit_append_only() CASCADE');
  const migration = await readFile(resolve(drizzleDir(), '0031_t72c_mcp_execution_audit.sql'), 'utf8');
  await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

async function reset(): Promise<void> {
  await sql!.unsafe('TRUNCATE mcp_execution_audit, mcp_handoff_revocations');
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'audit-1',
    token_id: 'token-1',
    tenant_id: TENANT,
    wallet_address: WALLET,
    tool_name: 'miorail_get_base_mcp_action',
    plan_id: 'plan-1',
    calls_hash: HASH,
    batch_id: null,
    outcome: 'action_released',
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

describe('migration 0031 — the audit table refuses what it must', { skip: !throwaway }, () => {
  test('an accepted row round-trips through the repository', async () => {
    await reset();
    const repository = createDatabaseMcpExecutionAuditRepository(sql as unknown as SqlTemplateExecutor);
    const stored = await repository.record(
      mcpAuditRowV1({
        id: 'audit-live-1',
        tokenId: 'token-1',
        tenantId: TENANT,
        walletAddress: WALLET,
        toolName: 'miorail_get_base_mcp_action',
        outcome: 'action_released',
        planId: 'plan-1',
        callsHash: HASH,
        now: NOW,
      }),
    );
    assert.equal(stored.outcome, 'action_released');
    assert.equal(stored.callsHash, HASH);
    const listed = await repository.listForTenant({ tenantId: TENANT });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'audit-live-1');
  });

  test('an invented outcome is refused by the database, not only by zod', async () => {
    await reset();
    await assert.rejects(
      sql!`INSERT INTO mcp_execution_audit ${sql!(row({ outcome: 'entry_probably_fine' }))}`,
      /mcp_execution_audit_outcome/,
    );
  });

  test('a bearer token does not fit in the token id column', async () => {
    await reset();
    // A real handoff token is prefix + base64url claims + signature. The bound
    // is what makes "we never store the token" a property of the schema.
    const token = `miorail-mcp-v1.${'a'.repeat(120)}.${'b'.repeat(43)}`;
    await assert.rejects(
      sql!`INSERT INTO mcp_execution_audit ${sql!(row({ token_id: token }))}`,
      /mcp_execution_audit_token_id_bounded/,
    );
  });

  test('calldata does not fit in the calls hash column', async () => {
    await reset();
    const calldata = `0x095ea7b3${'0'.repeat(128)}`;
    await assert.rejects(
      sql!`INSERT INTO mcp_execution_audit ${sql!(row({ calls_hash: calldata }))}`,
      /mcp_execution_audit_calls_hash_shape/,
    );
  });

  test('a wallet address must be a wallet address', async () => {
    await reset();
    await assert.rejects(
      sql!`INSERT INTO mcp_execution_audit ${sql!(row({ wallet_address: 'https://rpc.example/v2/key' }))}`,
      /mcp_execution_audit_wallet_shape/,
    );
  });

  test('an audit row cannot be rewritten or removed', async () => {
    await reset();
    await sql!`INSERT INTO mcp_execution_audit ${sql!(row())}`;
    await assert.rejects(
      sql!`UPDATE mcp_execution_audit SET outcome = 'refused' WHERE id = 'audit-1'`,
      /append-only/,
    );
    await assert.rejects(sql!`DELETE FROM mcp_execution_audit WHERE id = 'audit-1'`, /append-only/);
  });

  test('recording the same id twice is one row', async () => {
    await reset();
    const repository = createDatabaseMcpExecutionAuditRepository(sql as unknown as SqlTemplateExecutor);
    const entry = mcpAuditRowV1({
      id: 'audit-idem',
      tokenId: 'token-1',
      tenantId: TENANT,
      walletAddress: WALLET,
      toolName: 'miorail_get_base_mcp_action',
      outcome: 'action_released',
      planId: 'plan-1',
      callsHash: HASH,
      now: NOW,
    });
    const first = await repository.record(entry);
    const second = await repository.record(entry);
    assert.deepEqual(second, first);
    const listed = await repository.listForPlan({ tenantId: TENANT, planId: 'plan-1' });
    assert.equal(listed.length, 1);
  });

  test('one tenant cannot read another tenant’s trail', async () => {
    await reset();
    await sql!`INSERT INTO mcp_execution_audit ${sql!(row({ id: 'mine' }))}`;
    await sql!`INSERT INTO mcp_execution_audit ${sql!(
      row({ id: 'theirs', tenant_id: 'eip155:8453:0x2222222222222222222222222222222222222222' }),
    )}`;
    const repository = createDatabaseMcpExecutionAuditRepository(sql as unknown as SqlTemplateExecutor);
    const listed = await repository.listForTenant({ tenantId: TENANT });
    assert.deepEqual(
      listed.map((entry) => entry.id),
      ['mine'],
    );
  });
});

describe('migration 0031 — revocation', { skip: !throwaway }, () => {
  test('a revoked token reads back as revoked, for its tenant only', async () => {
    await reset();
    const repository = createDatabaseMcpHandoffRevocationRepository(sql as unknown as SqlTemplateExecutor);
    await repository.revoke({
      tokenId: 'token-1',
      tenantId: TENANT,
      revokedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    assert.equal(await repository.isRevoked({ tokenId: 'token-1', tenantId: TENANT }), true);
    // The tenant is part of the key: revoking is not a global namespace one
    // wallet can reach into.
    assert.equal(
      await repository.isRevoked({
        tokenId: 'token-1',
        tenantId: 'eip155:8453:0x2222222222222222222222222222222222222222',
      }),
      false,
    );
  });

  test('revoking twice keeps the first time', async () => {
    await reset();
    const repository = createDatabaseMcpHandoffRevocationRepository(sql as unknown as SqlTemplateExecutor);
    const first = NOW.toISOString();
    const expiresAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    await repository.revoke({ tokenId: 'token-2', tenantId: TENANT, revokedAt: first, expiresAt });
    await repository.revoke({
      tokenId: 'token-2',
      tenantId: TENANT,
      revokedAt: new Date(NOW.getTime() + 60_000).toISOString(),
      expiresAt,
    });
    const listed = await repository.listForTenant(TENANT);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revokedAt, first);
  });

  test('there is no column a bearer token could be revoked into', async () => {
    await reset();
    const columns = await sql!`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'mcp_handoff_revocations'`;
    assert.deepEqual(
      columns.map((column) => String((column as Record<string, unknown>).column_name)).sort(),
      ['expires_at', 'revoked_at', 'tenant_id', 'token_id'],
    );
  });
});
