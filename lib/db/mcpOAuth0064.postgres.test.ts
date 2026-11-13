import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it, test } from 'node:test';
import postgres from 'postgres';
import { assertSafeTestDatabaseEnvironment } from './testDatabaseGuard.js';

/**
 * The provider, loaded at run time. Imported by name, this package's type check would follow it into the
 * API's express session types, which only the API resolves; these are the few members the test uses.
 */
interface ProviderModuleV1 {
  mcpOAuthProviderV1: {
    exchangeRefreshToken(client: { client_id: string }, token: string): Promise<{ access_token: string; refresh_token?: string }>;
    verifyAccessToken(token: string): Promise<unknown>;
  };
  mcpOAuthRuntimeV1: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]> };
  revokeMcpOAuthGrantForTenantV1(input: { tenantId: string; grantId: string }): Promise<boolean>;
  REFRESH_REUSE_GRACE_SECONDS_V1: number;
}
const providerPathV1 = resolve(process.cwd(), process.cwd().endsWith('lib/db') ? '../../artifacts/api-server/lib/mcpOAuthProvider.ts' : 'artifacts/api-server/lib/mcpOAuthProvider.ts');
const providerModuleV1 = (): Promise<ProviderModuleV1> => import(pathToFileURL(providerPathV1).href) as Promise<ProviderModuleV1>;

// ---------------------------------------------------------------------------
// Audit N13-7, 2026-11-13; RFC 9700 §4.14.2. A refresh token the client had
// already exchanged, presented again, was refused alone: its successor kept
// refreshing for the rest of the grant's 30 days. Now the grant it belongs to
// ends, with every token of it. The provider's own SQL runs here against a real
// PostgreSQL, in a temporary schema made of migration 0064's OAuth tables.
// Every client, wallet and token here is synthetic.
// ---------------------------------------------------------------------------

const migrationUrl = resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle/0064_connected_apps_oauth.sql' : 'lib/db/drizzle/0064_connected_apps_oauth.sql');
const hash = (value: string) => createHash('sha256').update(`miorail-mcp-oauth-credential/v1:${value}`).digest('hex');

test('the rotation stamps a token used and ended at once, which is what tells a copy from an owner’s revocation', async () => {
  const source = await readFile(providerPathV1, 'utf8');
  assert.match(source, /UPDATE mcp_oauth_tokens SET revoked_at = \$\{now\}, last_used_at = \$\{now\}/);
  assert.match(source, /AND revoked_at IS NOT NULL AND last_used_at IS NOT NULL AND revoked_at = last_used_at/);
  assert.equal((await providerModuleV1()).REFRESH_REUSE_GRACE_SECONDS_V1, 30);
});

const enabled = process.env.MIOAGENT_TEST_SUITE === 'db' && Boolean(process.env.TEST_DATABASE_URL);
describe('a used refresh token presented again ends its grant (audit N13-7)', { skip: !enabled }, () => {
  const schema = `oauth_test_${randomUUID().replaceAll('-', '')}`;
  const WALLET = `0x${'ab'.repeat(20)}`, TENANT = `eip155:8453:${WALLET}`, CLIENT = 'synthetic-public-client', RESOURCE = 'https://miorail.xyz/mcp/private';
  let provider: ProviderModuleV1;
  let original: ProviderModuleV1['mcpOAuthRuntimeV1']['sql'];
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;

  before(async () => {
    provider = await providerModuleV1();
    original = provider.mcpOAuthRuntimeV1.sql;
    const safe = assertSafeTestDatabaseEnvironment(process.env);
    assert.equal(safe.source, 'TEST_DATABASE_URL');
    admin = postgres(safe.url!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = postgres(safe.url!, { max: 4, prepare: false, connection: { search_path: schema }, onnotice: () => {} });
    await sql.unsafe('CREATE TABLE users (id text PRIMARY KEY)');
    const migration = await readFile(migrationUrl, 'utf8');
    for (const table of ['mcp_oauth_clients', 'mcp_oauth_grants', 'mcp_oauth_tokens']) {
      const block = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
      assert.ok(block, `migration 0064 creates ${table}`);
      await sql.unsafe(block.replaceAll('"public".', ''));
    }
    await sql`INSERT INTO users (id) VALUES (${TENANT})`;
    await sql`INSERT INTO mcp_oauth_clients (client_id, encrypted_metadata) VALUES (${CLIENT}, 'synthetic')`;
    provider.mcpOAuthRuntimeV1.sql = async (strings, ...values) => await sql(strings, ...(values as never[])) as unknown as Record<string, unknown>[];
  });
  after(async () => {
    if (provider) provider.mcpOAuthRuntimeV1.sql = original;
    if (sql) await sql.end({ timeout: 5 });
    if (admin) { await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end({ timeout: 5 }); }
  });

  /** A grant made ten minutes ago, with its first refresh token. */
  async function grant(): Promise<{ grantId: string; refresh: string }> {
    const grantId = `oauth-grant_${randomUUID()}`, refresh = `synthetic-refresh-${randomUUID()}`;
    const created = new Date(Date.now() - 10 * 60_000), expires = new Date(Date.now() + 30 * 86_400_000);
    await sql`INSERT INTO mcp_oauth_grants (id, tenant_id, wallet_address, client_id, client_name, scopes, resource, created_at, expires_at)
      VALUES (${grantId}, ${TENANT}, ${WALLET}, ${CLIENT}, 'Synthetic client', ${JSON.stringify(['miorail:connected', 'offline_access'])}::text::jsonb, ${RESOURCE}, ${created}, ${expires})`;
    await sql`INSERT INTO mcp_oauth_tokens (token_hash, token_id, grant_id, client_id, kind, created_at, expires_at)
      VALUES (${hash(refresh)}, ${randomUUID()}, ${grantId}, ${CLIENT}, 'refresh', ${created}, ${expires})`;
    return { grantId, refresh };
  }
  const exchange = (token: string, client = CLIENT) => provider.mcpOAuthProviderV1.exchangeRefreshToken({ client_id: client }, token);
  const ended = async (grantId: string) => (await sql`SELECT revoked_at FROM mcp_oauth_grants WHERE id = ${grantId}`)[0]!.revoked_at !== null;
  const liveTokens = async (grantId: string) => Number((await sql`SELECT count(*)::int AS n FROM mcp_oauth_tokens WHERE grant_id = ${grantId} AND revoked_at IS NULL`)[0]!.n);
  /** The exchange happened long enough ago to be past the grace. */
  const aged = (token: string) => sql`UPDATE mcp_oauth_tokens SET revoked_at = revoked_at - interval '2 minutes', last_used_at = last_used_at - interval '2 minutes'
    WHERE token_hash = ${hash(token)}`;
  const refused = (error: unknown) => error instanceof Error && error.name === 'InvalidGrantError';

  it('ends the grant and every token of it when a token exchanged a while ago comes back', async () => {
    const { grantId, refresh } = await grant();
    const successor = await exchange(refresh);
    await aged(refresh);
    await assert.rejects(exchange(refresh), refused);
    assert.equal(await ended(grantId), true);
    assert.equal(await liveTokens(grantId), 0);
    // The successor, whoever holds it, stops working.
    await assert.rejects(exchange(successor.refresh_token!), refused);
    await assert.rejects(provider.mcpOAuthProviderV1.verifyAccessToken(successor.access_token));
  });

  it('a retry within seconds of the exchange is the client’s own, and ends nothing', async () => {
    const { grantId, refresh } = await grant();
    const successor = await exchange(refresh);
    await assert.rejects(exchange(refresh), refused);
    assert.equal(await ended(grantId), false);
    assert.ok((await exchange(successor.refresh_token!)).refresh_token);
  });

  it('two exchanges sent together: one rotates, the other is refused, and the grant stays', async () => {
    const { grantId, refresh } = await grant();
    const both = await Promise.allSettled([exchange(refresh), exchange(refresh)]);
    assert.deepEqual(both.map((one) => one.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(await ended(grantId), false);
    const winner = both.find((one) => one.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof exchange>>>;
    assert.ok((await exchange(winner.value.refresh_token!)).refresh_token);
  });

  it('an unknown token, or a used one shown by another client, ends nothing', async () => {
    const { grantId, refresh } = await grant();
    await exchange(refresh);
    await aged(refresh);
    await assert.rejects(exchange(`synthetic-refresh-${randomUUID()}`), refused);
    await assert.rejects(exchange(refresh, 'another-client'), refused);
    assert.equal(await ended(grantId), false);
  });

  it('a token whose grant its owner ended is refused, and that ending is not moved', async () => {
    const { grantId, refresh } = await grant();
    assert.equal(await provider.revokeMcpOAuthGrantForTenantV1({ tenantId: TENANT, grantId }), true);
    const at = (await sql`SELECT revoked_at FROM mcp_oauth_grants WHERE id = ${grantId}`)[0]!.revoked_at;
    await assert.rejects(exchange(refresh), refused);
    assert.deepEqual((await sql`SELECT revoked_at FROM mcp_oauth_grants WHERE id = ${grantId}`)[0]!.revoked_at, at);
  });
});
