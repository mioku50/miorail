import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  baseMcpOAuthLifecycleRuntime,
  clearBaseMcpRefreshLocksForTests,
  refreshBaseMcpOAuthIfNeeded,
} from './baseMcpOAuthLifecycle.js';

const originalRuntime = { ...baseMcpOAuthLifecycleRuntime };
const originalSkew = process.env.BASE_MCP_REFRESH_SKEW_MS;

afterEach(() => {
  Object.assign(baseMcpOAuthLifecycleRuntime, originalRuntime);
  clearBaseMcpRefreshLocksForTests();
  if (originalSkew === undefined) delete process.env.BASE_MCP_REFRESH_SKEW_MS;
  else process.env.BASE_MCP_REFRESH_SKEW_MS = originalSkew;
});

test('expired Base MCP token refreshes once under a per-user lock', async () => {
  let authCalls = 0;
  let savedAccessToken = '';
  const marks: string[] = [];
  baseMcpOAuthLifecycleRuntime.now = () => 1_000_000;
  baseMcpOAuthLifecycleRuntime.getAuthStatus = async () => ({
    connected: true,
    needsReauth: false,
    userScoped: true,
    expired: true,
    expiresAt: new Date(999_000).toISOString(),
  });
  baseMcpOAuthLifecycleRuntime.loadTokens = async () => ({
    access_token: 'expired-access',
    refresh_token: 'valid-refresh',
    token_type: 'Bearer',
  });
  baseMcpOAuthLifecycleRuntime.createProvider = (() => ({
    saveTokens: async (tokens: { access_token: string }) => { savedAccessToken = tokens.access_token; },
  })) as any;
  baseMcpOAuthLifecycleRuntime.auth = (async (provider: any) => {
    authCalls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    await provider.saveTokens({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', token_type: 'Bearer' });
    return 'AUTHORIZED';
  }) as any;
  baseMcpOAuthLifecycleRuntime.markNeedsReauth = async (input) => { marks.push(input.error || ''); };

  const input = {
    userId: 'user-1',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://app.example/api/mcp/base/callback',
    serverUrl: new URL('https://mcp.base.org'),
  };
  const [first, second] = await Promise.all([
    refreshBaseMcpOAuthIfNeeded(input),
    refreshBaseMcpOAuthIfNeeded(input),
  ]);

  assert.deepEqual(first, { status: 'refreshed' });
  assert.deepEqual(second, { status: 'refreshed' });
  assert.equal(authCalls, 1);
  assert.equal(savedAccessToken, 'fresh-access');
  assert.deepEqual(marks, []);
});

test('refresh failure marks the user for a clean reconnect', async () => {
  const marks: string[] = [];
  baseMcpOAuthLifecycleRuntime.now = () => 1_000_000;
  baseMcpOAuthLifecycleRuntime.getAuthStatus = async () => ({
    connected: true,
    needsReauth: false,
    userScoped: true,
    expired: true,
    expiresAt: new Date(999_000).toISOString(),
  });
  baseMcpOAuthLifecycleRuntime.loadTokens = async () => ({
    access_token: 'expired-access',
    refresh_token: 'invalid-refresh',
    token_type: 'Bearer',
  });
  baseMcpOAuthLifecycleRuntime.createProvider = (() => ({})) as any;
  baseMcpOAuthLifecycleRuntime.auth = (async () => {
    throw new Error('invalid_grant while refreshing');
  }) as any;
  baseMcpOAuthLifecycleRuntime.markNeedsReauth = async (input) => { marks.push(input.error || ''); };

  const result = await refreshBaseMcpOAuthIfNeeded({
    userId: 'user-2',
    sessionSecret: 'session-secret',
    redirectUrl: 'https://app.example/api/mcp/base/callback',
    serverUrl: new URL('https://mcp.base.org'),
  });

  assert.deepEqual(result, { status: 'needs_reauth', errorCode: 'refresh_failed' });
  assert.deepEqual(marks, ['refresh_failed']);
});
