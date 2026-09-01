import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL?.trim();
const throwaway = Boolean(
  url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  return resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle' : 'lib/db/drizzle');
}

async function migration(name: string): Promise<string> {
  return readFile(resolve(drizzleDir(), name), 'utf8');
}

test('migration 0064 has no plaintext OAuth credential column and binds grants to wallet tenants', async () => {
  const text = await migration('0064_connected_apps_oauth.sql');
  assert.doesNotMatch(text, /"(access_token|refresh_token|authorization_code)"/);
  assert.match(text, /"token_hash" text PRIMARY KEY/);
  assert.match(text, /"tenant_id" = 'eip155:8453:' \|\| "wallet_address"/);
  assert.match(text, /jsonb_array_length\("scopes"\) > 0/);
  assert.match(text, /CREATE TABLE IF NOT EXISTS "web_sessions"/);
});

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  for (const table of [
    'mcp_oauth_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_grants',
    'mcp_oauth_clients',
    'web_sessions',
    'mcp_handoff_revocations',
    'mcp_execution_audit',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  for (const name of ['0031_t72c_mcp_execution_audit.sql', '0064_connected_apps_oauth.sql']) {
    await sql.unsafe((await migration(name)).replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  if (!sql) return;
  for (const table of [
    'mcp_oauth_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_grants',
    'mcp_oauth_clients',
    'web_sessions',
    'mcp_handoff_revocations',
    'mcp_execution_audit',
  ]) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await sql.end({ timeout: 5 });
});

async function refuses(statement: string, expected: RegExp): Promise<void> {
  await assert.rejects(
    () => sql!.unsafe(statement),
    (error: unknown) => {
      assert.match(String((error as { message?: string }).message ?? error), expected);
      return true;
    },
  );
}

if (!throwaway) {
  describe('migration 0064 database constraints', () => {
    test('skipped: TEST_DATABASE_URL must be a throwaway local database', () => {});
  });
} else {
  describe('migration 0064 database constraints', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const tenant = `eip155:8453:${wallet}`;

    before(async () => {
      await sql!`INSERT INTO users (id) VALUES (${tenant}) ON CONFLICT DO NOTHING`;
      await sql!`INSERT INTO mcp_oauth_clients (client_id, encrypted_metadata)
        VALUES ('client-1', 'encrypted-only')`;
    });

    test('browser sessions are durable server-side rows with an explicit expiry', async () => {
      await sql!`INSERT INTO web_sessions (sid, session, expires_at)
        VALUES ('session-1', ${sql!.json({ cookie: { maxAge: 60_000 } })}, now() + interval '1 hour')`;
      const rows = await sql!`SELECT session FROM web_sessions WHERE sid = 'session-1'`;
      assert.equal((rows[0]?.session as { cookie?: { maxAge?: number } }).cookie?.maxAge, 60_000);
    });

    test('a durable grant must match its exact wallet tenant and resource', async () => {
      const insert = (tenantId: string, resource: string) => `INSERT INTO mcp_oauth_grants (
        id, tenant_id, wallet_address, client_id, client_name, scopes, resource, expires_at
      ) VALUES ('oauth-grant-1', '${tenantId}', '${wallet}', 'client-1', 'Claude',
        '["miorail:connected"]', '${resource}', now() + interval '30 days')`;
      await refuses(insert(`eip155:8453:0x${'2'.repeat(40)}`, 'https://miorail.xyz/mcp/private'), /tenant_wallet/);
      await refuses(insert(tenant, 'https://evil.example/mcp/other'), /resource_check/);
      await sql!.unsafe(insert(tenant, 'https://miorail.xyz/mcp/private'));
    });

    test('only hashes are stored and legacy expiry belongs only to issuance', async () => {
      await sql!`INSERT INTO mcp_oauth_tokens (
        token_hash, token_id, grant_id, client_id, kind, expires_at
      ) VALUES (${'a'.repeat(64)}, 'token-id-1', 'oauth-grant-1', 'client-1', 'access',
        now() + interval '15 minutes')`;
      await refuses(
        `INSERT INTO mcp_execution_audit (
          id, token_id, tenant_id, wallet_address, tool_name, outcome, expires_at
        ) VALUES ('audit-1', 'token-id-1', '${tenant}', '${wallet}', 'status', 'plan_read',
          now() + interval '15 minutes')`,
        /mcp_execution_audit_expiry_check/,
      );
    });
  });
}
