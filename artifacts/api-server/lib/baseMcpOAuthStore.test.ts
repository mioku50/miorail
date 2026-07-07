import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { baseMcpOauthStates, baseMcpOauthTokens } from '@mioagent/db';
import {
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

  await clearBaseMcpCredentialScope({ userId: 'user-1', scope: 'tokens' });
  const afterInvalidation = await getBaseMcpAuthStatus('user-1');
  assert.strictEqual(afterInvalidation.connected, false);
  assert.strictEqual(afterInvalidation.needsReauth, true);
});
