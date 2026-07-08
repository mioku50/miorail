import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { baseMcpOauthStates, baseMcpOauthTokens } from '@mioagent/db';
import { mcpBaseRouteRuntime } from './mcpBase.js';
import { clearBaseMcpStatusForTests } from '../lib/baseMcpStatus.js';
import {
  baseMcpOAuthStoreRuntime,
  getBaseMcpAuthStatus,
  saveBaseMcpOAuthState,
} from '../lib/baseMcpOAuthStore.js';

const originalAuth = mcpBaseRouteRuntime.auth;
const originalLogger = mcpBaseRouteRuntime.logger;
const originalProbeBaseMcpTools = mcpBaseRouteRuntime.probeBaseMcpTools;
const originalDb = baseMcpOAuthStoreRuntime.db;
const originalFetch = globalThis.fetch;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createFakeDb() {
  const states = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();

  function apply(table: unknown, values: Record<string, unknown>, set?: Record<string, unknown>) {
    if (table === baseMcpOauthStates) {
      states.set(String(values.stateHash), { ...values, ...(set || {}) });
    } else if (table === baseMcpOauthTokens) {
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
  mcpBaseRouteRuntime.auth = originalAuth;
  mcpBaseRouteRuntime.logger = originalLogger;
  mcpBaseRouteRuntime.probeBaseMcpTools = originalProbeBaseMcpTools;
  baseMcpOAuthStoreRuntime.db = originalDb;
  globalThis.fetch = originalFetch;
  clearBaseMcpStatusForTests();
});

test('GET /api/mcp/base/connect returns safe missing_config when Base MCP config is absent', async () => {
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalMcpUrl = process.env.MCP_SERVER_URL;
  const originalBaseMcpUrl = process.env.BASE_MCP_URL;
  const originalSecret = process.env.SESSION_SECRET;
  delete process.env.BASE_MCP_ENABLED;
  delete process.env.BASE_MCP_SERVER_URL;
  delete process.env.MCP_SERVER_URL;
  delete process.env.BASE_MCP_URL;
  delete process.env.SESSION_SECRET;

  const response = await request(app).get('/api/mcp/base/connect');
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error, 'missing_config');
  assert.deepStrictEqual(response.body.missing_config.sort(), ['BASE_MCP_ENABLED', 'BASE_MCP_SERVER_URL', 'SESSION_SECRET'].sort());
  assert.strictEqual(JSON.stringify(response.body).includes('mcp.base.org'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('MCP_SERVER_URL', originalMcpUrl);
  restoreEnv('BASE_MCP_URL', originalBaseMcpUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/connect reports missing SESSION_SECRET without leaking server URL details', async () => {
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org/private/path?debug_token=secret';
  delete process.env.SESSION_SECRET;

  const response = await request(app).get('/api/mcp/base/connect');
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.error, 'missing_config');
  assert.deepStrictEqual(response.body.missing_config, ['SESSION_SECRET']);
  assert.strictEqual(JSON.stringify(response.body).includes('debug_token'), false);
  assert.strictEqual(JSON.stringify(response.body).includes('private/path'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/connect redirects to Base auth without leaking verifier', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mcpBaseRouteRuntime.logger = {
    info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
  } as any;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';

  mcpBaseRouteRuntime.auth = async (provider: any) => {
    const state = await provider.state();
    await provider.saveCodeVerifier('plain-code-verifier');
    await provider.redirectToAuthorization(new URL(`https://mcp.base.org/authorize?state=${state}&code_challenge=challenge`));
    return 'REDIRECT';
  };

  const response = await request(app).get('/api/mcp/base/connect?returnTo=/base-mcp');
  assert.strictEqual(response.status, 302);
  assert.ok(response.headers.location.startsWith('https://mcp.base.org/authorize?'));
  assert.strictEqual(response.headers.location.includes('plain-code-verifier'), false);
  assert.strictEqual(fake.states.size, 1);
  assert.strictEqual(JSON.stringify(Array.from(fake.states.values())).includes('plain-code-verifier'), false);
  assert.strictEqual(logs.some((entry) => entry.message === 'base-mcp-oauth-started'), true);
  assert.strictEqual(JSON.stringify(logs).includes('plain-code-verifier'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/callback rejects missing or invalid state', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';

  const missing = await request(app).get('/api/mcp/base/callback?code=abc');
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.error, /Missing OAuth code or state/);

  const invalid = await request(app).get('/api/mcp/base/callback?code=abc&state=wrong');
  assert.strictEqual(invalid.status, 400);
  assert.match(invalid.body.error, /Invalid or expired OAuth state/);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/callback stores encrypted tokens and redirects locally', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mcpBaseRouteRuntime.logger = {
    info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
  } as any;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';

  await saveBaseMcpOAuthState({
    userId: 'default-user',
    sessionSecret: 'test-session-secret',
    state: 'valid-state',
    codeVerifier: 'plain-code-verifier',
    returnTo: '/base-mcp',
  });

  mcpBaseRouteRuntime.auth = async (provider: any, options: { authorizationCode?: string }) => {
    assert.strictEqual(options.authorizationCode, 'auth-code');
    assert.strictEqual(await provider.codeVerifier(), 'plain-code-verifier');
    await provider.saveTokens({
      access_token: 'plain-access-token',
      refresh_token: 'plain-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    return 'AUTHORIZED';
  };

  const response = await request(app).get('/api/mcp/base/callback?code=auth-code&state=valid-state');
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, '/base-mcp?mcp=connected');
  assert.strictEqual(fake.states.size, 0);
  assert.strictEqual(JSON.stringify(Array.from(fake.tokens.values())).includes('plain-access-token'), false);

  const status = await getBaseMcpAuthStatus('default-user');
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.needsReauth, false);

  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  } as Response);
  clearBaseMcpStatusForTests();
  const statusResponse = await request(app).get('/api/status');
  assert.strictEqual(statusResponse.status, 200);
  assert.strictEqual(statusResponse.body.baseMcp.status, 'connected');
  assert.strictEqual(statusResponse.body.baseMcp.auth.connected, true);
  assert.strictEqual(statusResponse.body.baseMcp.auth.needsReauth, false);
  const publicStatusJson = JSON.stringify(statusResponse.body);
  assert.strictEqual(publicStatusJson.includes('plain-access-token'), false);
  assert.strictEqual(publicStatusJson.includes('plain-refresh-token'), false);
  assert.strictEqual(publicStatusJson.includes('auth-code'), false);
  assert.strictEqual(logs.some((entry) => entry.message === 'base-mcp-oauth-callback-success'), true);
  assert.strictEqual(JSON.stringify(logs).includes('plain-access-token'), false);
  assert.strictEqual(JSON.stringify(logs).includes('auth-code'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/callback handles user cancel without calling token exchange', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';

  await saveBaseMcpOAuthState({
    userId: 'default-user',
    sessionSecret: 'test-session-secret',
    state: 'valid-state',
    codeVerifier: 'plain-code-verifier',
    returnTo: '/configure',
  });

  mcpBaseRouteRuntime.auth = async () => {
    throw new Error('auth_should_not_be_called');
  };

  const response = await request(app).get('/api/mcp/base/callback?error=access_denied&state=valid-state');
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, '/configure?mcp=cancelled');
  assert.strictEqual(fake.states.size, 0);
  const status = await getBaseMcpAuthStatus('default-user');
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.needsReauth, true);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/callback marks needs_reauth and redirects safely when token exchange fails', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  mcpBaseRouteRuntime.logger = {
    info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
  } as any;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';

  await saveBaseMcpOAuthState({
    userId: 'default-user',
    sessionSecret: 'test-session-secret',
    state: 'valid-state',
    codeVerifier: 'plain-code-verifier',
  });

  mcpBaseRouteRuntime.auth = async () => {
    throw new Error('token exchange failed plain-access-token');
  };

  const response = await request(app).get('/api/mcp/base/callback?code=auth-code&state=valid-state');
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, '/base-mcp?mcp=error');
  assert.strictEqual(fake.states.size, 0);
  const status = await getBaseMcpAuthStatus('default-user');
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.needsReauth, true);
  assert.strictEqual(JSON.stringify(Array.from(fake.tokens.values())).includes('plain-access-token'), false);
  assert.strictEqual(logs.some((entry) => entry.message === 'base-mcp-oauth-callback-failed'), true);
  assert.strictEqual(JSON.stringify(logs).includes('plain-access-token'), false);
  assert.strictEqual(JSON.stringify(logs).includes('auth-code'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/tools returns sanitized user-scoped tool inventory', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  let receivedRedirectUrl = '';
  mcpBaseRouteRuntime.probeBaseMcpTools = async (input) => {
    receivedRedirectUrl = input.redirectUrl;
    return {
      status: 'connected',
      endpointHost: 'mcp.base.org',
      toolsCount: 2,
      capabilities: {
        readOnly: 1,
        userConfirmedTransaction: 1,
        forbidden: 0,
        unknown: 0,
      },
      tools: [
        {
          name: 'get_wallets',
          description: 'Wallet inventory',
          capability: 'read_only',
          enabled: true,
          reason: 'read_only_allowlist',
        },
        {
          name: 'send_calls',
          description: 'Listed only, never invoked by probe',
          capability: 'user_confirmed_transaction',
          enabled: false,
          reason: 'transaction_tool_user_confirmation_required',
        },
      ],
      checkedAt: '2026-07-08T00:00:00.000Z',
    };
  };

  const response = await request(app).get('/api/mcp/base/tools');
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(response.body, {
    status: 'connected',
    endpointHost: 'mcp.base.org',
    toolsCount: 2,
    capabilities: {
      readOnly: 1,
      userConfirmedTransaction: 1,
      forbidden: 0,
      unknown: 0,
    },
    tools: [
      {
        name: 'get_wallets',
        description: 'Wallet inventory',
        capability: 'read_only',
        enabled: true,
        reason: 'read_only_allowlist',
      },
      {
        name: 'send_calls',
        description: 'Listed only, never invoked by probe',
        capability: 'user_confirmed_transaction',
        enabled: false,
        reason: 'transaction_tool_user_confirmation_required',
      },
    ],
    checkedAt: '2026-07-08T00:00:00.000Z',
  });
  assert.match(receivedRedirectUrl, /\/api\/mcp\/base\/callback$/);
  assert.strictEqual(JSON.stringify(response.body).includes('test-session-secret'), false);

  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/probe returns needs_reauth when stored token is absent', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  mcpBaseRouteRuntime.probeBaseMcpTools = async () => ({
    status: 'needs_reauth',
    endpointHost: 'mcp.base.org',
    toolsCount: 0,
    capabilities: {
      readOnly: 0,
      userConfirmedTransaction: 0,
      forbidden: 0,
      unknown: 0,
    },
    tools: [],
    checkedAt: '2026-07-08T00:01:00.000Z',
    errorCode: 'needs_reauth',
  });

  const response = await request(app).get('/api/mcp/base/probe');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'needs_reauth');
  assert.strictEqual(response.body.toolsCount, 0);
  assert.deepStrictEqual(response.body.tools, []);
  assert.strictEqual(JSON.stringify(response.body).includes('test-session-secret'), false);

  restoreEnv('SESSION_SECRET', originalSecret);
});
