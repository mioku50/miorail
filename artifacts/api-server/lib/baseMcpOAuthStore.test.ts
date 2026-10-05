import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { baseMcpOauthStates, baseMcpOauthTokens } from '@mioagent/db';
import {
  baseMcpGrantProviderV1,
  baseMcpOAuthStoreRuntime,
  clearBaseMcpCredentialScope,
  getBaseMcpAuthStatus,
  loadBaseMcpOAuthState,
  loadBaseMcpTokens,
  saveBaseMcpOAuthState,
  saveBaseMcpTokens,
  sanitizeReturnTo,
} from './baseMcpOAuthStore.js';

const originalDb = baseMcpOAuthStoreRuntime.db;

function createFakeDb() {
  const states = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();

  function apply(table: unknown, values: Record<string, unknown>, set?: Record<string, unknown>) {
    if (table === baseMcpOauthStates) {
      const key = String(values.stateHash);
      states.set(key, { ...(states.get(key) || {}), ...values, ...(set || {}) });
      return;
    }
    if (table === baseMcpOauthTokens) {
      const key = String(values.id);
      tokens.set(key, { ...(tokens.get(key) || {}), ...values, ...(set || {}) });
    }
  }

  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: async () => undefined,
        onConflictDoUpdate: async ({ set }: { set?: Record<string, unknown> }) => apply(table, values, set),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === baseMcpOauthStates) return Array.from(states.values());
          if (table === baseMcpOauthTokens) return Array.from(tokens.values());
          return [];
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === baseMcpOauthStates) states.clear();
        if (table === baseMcpOauthTokens) tokens.clear();
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          const target = table === baseMcpOauthStates ? states : tokens;
          for (const [key, row] of target.entries()) target.set(key, { ...row, ...set });
        },
      }),
    }),
  };

  return { db: db as unknown as typeof originalDb, states, tokens };
}

afterEach(() => {
  baseMcpOAuthStoreRuntime.db = originalDb;
});

test('sanitizeReturnTo accepts only local return paths', () => {
  assert.strictEqual(sanitizeReturnTo('/base-mcp'), '/base-mcp');
  assert.strictEqual(sanitizeReturnTo('https://evil.example'), '/base-mcp');
  assert.strictEqual(sanitizeReturnTo('//evil.example/path'), '/base-mcp');
});

test('Base MCP OAuth state stores hashed state and encrypted verifier', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;

  await saveBaseMcpOAuthState({
    userId: 'user-1',
    sessionSecret: 'test-session-secret',
    state: 'plain-state',
    codeVerifier: 'plain-verifier',
    returnTo: '/base-mcp?tab=connect',
  });

  assert.strictEqual(fake.states.size, 1);
  const row = Array.from(fake.states.values())[0];
  assert.strictEqual(row.stateHash === 'plain-state', false);
  assert.strictEqual(String(row.encryptedCodeVerifier).includes('plain-verifier'), false);

  const loaded = await loadBaseMcpOAuthState({
    userId: 'user-1',
    sessionSecret: 'test-session-secret',
    state: 'plain-state',
  });
  assert.strictEqual(loaded?.codeVerifier, 'plain-verifier');
  assert.strictEqual(loaded?.returnTo, '/base-mcp?tab=connect');
});

test('Base MCP OAuth state rejects expired verifier records', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;

  await saveBaseMcpOAuthState({
    userId: 'user-1',
    sessionSecret: 'test-session-secret',
    state: 'expired-state',
    codeVerifier: 'plain-verifier',
    expiresAt: new Date(Date.now() - 1000),
  });

  const loaded = await loadBaseMcpOAuthState({
    userId: 'user-1',
    sessionSecret: 'test-session-secret',
    state: 'expired-state',
  });
  assert.strictEqual(loaded, null);
});

test('Base MCP OAuth tokens are encrypted and status exposes no plaintext token', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;

  await saveBaseMcpTokens({
    userId: 'user-1',
    sessionSecret: 'test-session-secret',
    tokens: {
      access_token: 'plain-access-token',
      refresh_token: 'plain-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    },
  });

  const row = Array.from(fake.tokens.values())[0];
  assert.strictEqual(String(row.encryptedTokens).includes('plain-access-token'), false);
  assert.strictEqual(String(row.encryptedTokens).includes('plain-refresh-token'), false);

  const loaded = await loadBaseMcpTokens({ userId: 'user-1', sessionSecret: 'test-session-secret' });
  assert.strictEqual(loaded?.access_token, 'plain-access-token');

  const status = await getBaseMcpAuthStatus('user-1');
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.needsReauth, false);
  assert.strictEqual(JSON.stringify(status).includes('plain-access-token'), false);
  assert.strictEqual(status.expired, false);

  const tokenRow = Array.from(fake.tokens.values())[0];
  tokenRow.tokenExpiresAt = new Date(Date.now() - 1_000);
  const expiredStatus = await getBaseMcpAuthStatus('user-1');
  assert.strictEqual(expiredStatus.connected, true);
  assert.strictEqual(expiredStatus.expired, true);
  assert.strictEqual(expiredStatus.needsReauth, false);

  await clearBaseMcpCredentialScope({ userId: 'user-1', scope: 'tokens' });
  const afterInvalidation = await getBaseMcpAuthStatus('user-1');
  assert.strictEqual(afterInvalidation.connected, false);
  assert.strictEqual(afterInvalidation.needsReauth, true);
});

test('T43: Base MCP OAuth credentials are stored in distinct authenticated user scopes', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const walletA = 'eip155:8453:0x1111111111111111111111111111111111111111';
  const walletB = 'eip155:8453:0x2222222222222222222222222222222222222222';

  await saveBaseMcpTokens({
    userId: walletA,
    sessionSecret: 'test-session-secret',
    tokens: { access_token: 'wallet-a-token', token_type: 'Bearer' },
  });
  await saveBaseMcpTokens({
    userId: walletB,
    sessionSecret: 'test-session-secret',
    tokens: { access_token: 'wallet-b-token', token_type: 'Bearer' },
  });

  assert.equal(fake.tokens.size, 2);
  assert.ok(fake.tokens.has(`${walletA}:base-mcp`));
  assert.ok(fake.tokens.has(`${walletB}:base-mcp`));
  assert.notEqual(
    fake.tokens.get(`${walletA}:base-mcp`)?.encryptedTokens,
    fake.tokens.get(`${walletB}:base-mcp`)?.encryptedTokens,
  );
});

test('a grant belongs to the server that issued it', async () => {
  // The original host keeps the original key, so grants made before hosts
  // were told apart are still found.
  assert.equal(baseMcpGrantProviderV1(new URL('https://mcp.base.org')), 'base-mcp');
  assert.equal(baseMcpGrantProviderV1(new URL('https://wallet-mcp.coinbase.com')), 'base-mcp@wallet-mcp.coinbase.com');
  assert.equal(baseMcpGrantProviderV1(null), 'base-mcp');

  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const previous = process.env.BASE_MCP_SERVER_URL;
  try {
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
    await saveBaseMcpTokens({ userId: 'user-1', sessionSecret: 's', tokens: { access_token: 'old', token_type: 'Bearer' } });
    process.env.BASE_MCP_SERVER_URL = 'https://wallet-mcp.coinbase.com';
    await saveBaseMcpTokens({ userId: 'user-1', sessionSecret: 's', tokens: { access_token: 'new', token_type: 'Bearer' } });
    // Two grants, one per server: the move wrote a new row and left the old one.
    assert.deepEqual([...fake.tokens.keys()].sort(), ['user-1:base-mcp', 'user-1:base-mcp@wallet-mcp.coinbase.com']);
    assert.equal(fake.tokens.get('user-1:base-mcp@wallet-mcp.coinbase.com')?.provider, 'base-mcp@wallet-mcp.coinbase.com');
    assert.equal(fake.tokens.get('user-1:base-mcp')?.provider, 'base-mcp');
  } finally {
    if (previous === undefined) delete process.env.BASE_MCP_SERVER_URL;
    else process.env.BASE_MCP_SERVER_URL = previous;
  }
});
