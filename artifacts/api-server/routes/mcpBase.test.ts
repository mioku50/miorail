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
const originalPluginDrift = mcpBaseRouteRuntime.baseMcpPluginDriftV1;
const originalConsole = mcpBaseRouteRuntime.runBaseMcpConsoleV1;
const originalReviewedConsole = mcpBaseRouteRuntime.runReviewedBaseMcpPluginReadV1;
const originalClassifyExtension = mcpBaseRouteRuntime.classifyBaseMcpExtensionIntentV1;
const originalResolveBaseName = mcpBaseRouteRuntime.resolveBaseNameV1;
const originalPrepareExtension = mcpBaseRouteRuntime.prepareBaseMcpSendActionV1;
const originalPrepareX402Extension = mcpBaseRouteRuntime.prepareBaseMcpX402ActionV1;
const originalPrepareVirtualsExtension = mcpBaseRouteRuntime.prepareBaseMcpVirtualsAgentCreateV1;
const originalReconcileExtension = mcpBaseRouteRuntime.reconcileBaseMcpActionV1;
const originalListExtension = mcpBaseRouteRuntime.listBaseMcpActionReceiptsV1;
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
  mcpBaseRouteRuntime.baseMcpPluginDriftV1 = originalPluginDrift;
  mcpBaseRouteRuntime.runBaseMcpConsoleV1 = originalConsole;
  mcpBaseRouteRuntime.runReviewedBaseMcpPluginReadV1 = originalReviewedConsole;
  mcpBaseRouteRuntime.classifyBaseMcpExtensionIntentV1 = originalClassifyExtension;
  mcpBaseRouteRuntime.resolveBaseNameV1 = originalResolveBaseName;
  mcpBaseRouteRuntime.prepareBaseMcpSendActionV1 = originalPrepareExtension;
  mcpBaseRouteRuntime.prepareBaseMcpX402ActionV1 = originalPrepareX402Extension;
  mcpBaseRouteRuntime.prepareBaseMcpVirtualsAgentCreateV1 = originalPrepareVirtualsExtension;
  mcpBaseRouteRuntime.reconcileBaseMcpActionV1 = originalReconcileExtension;
  mcpBaseRouteRuntime.listBaseMcpActionReceiptsV1 = originalListExtension;
  baseMcpOAuthStoreRuntime.db = originalDb;
  globalThis.fetch = originalFetch;
  clearBaseMcpStatusForTests();
});

test('GET /api/mcp/base/connect redirects with safe missing_config when Base MCP config is absent', async () => {
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
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, '/base-mcp?mcp=error&code=missing_config');

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('MCP_SERVER_URL', originalMcpUrl);
  restoreEnv('BASE_MCP_URL', originalBaseMcpUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/connect reports missing SESSION_SECRET through a safe redirect', async () => {
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org/private/path?debug_token=secret';
  delete process.env.SESSION_SECRET;

  const response = await request(app).get('/api/mcp/base/connect');
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, '/base-mcp?mcp=error&code=missing_config');
  assert.strictEqual(response.headers.location.includes('debug_token'), false);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/connect preserves a popup return target on safe errors', async () => {
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  delete process.env.BASE_MCP_ENABLED;
  delete process.env.BASE_MCP_SERVER_URL;
  delete process.env.SESSION_SECRET;

  const response = await request(app).get('/api/mcp/base/connect?returnTo=/configure&popup=1');
  assert.strictEqual(response.status, 302);
  const location = new URL(response.headers.location, 'http://local');
  assert.strictEqual(location.pathname, '/configure');
  assert.strictEqual(location.searchParams.get('mcpPopup'), '1');
  assert.strictEqual(location.searchParams.get('mcp'), 'error');
  assert.strictEqual(location.searchParams.get('code'), 'missing_config');

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

test('GET /api/mcp/base/connect clears stale encrypted credentials before reconnecting', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  fake.tokens.set('default-user:base-mcp', {
    id: 'default-user:base-mcp',
    userId: 'default-user',
    provider: 'base-mcp',
    encryptedTokens: 'encrypted-with-an-old-session-secret',
    encryptedClientInfo: 'also-stale',
    encryptedDiscoveryState: 'also-stale',
    status: 'needs_reauth',
  });
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'new-session-secret';

  mcpBaseRouteRuntime.auth = async (provider: any) => {
    assert.equal(await provider.tokens(), undefined);
    assert.equal(await provider.clientInformation(), undefined);
    assert.equal(await provider.discoveryState(), undefined);
    const state = await provider.state();
    await provider.saveCodeVerifier('new-verifier');
    await provider.redirectToAuthorization(new URL(`https://mcp.base.org/authorize?state=${state}`));
    return 'REDIRECT';
  };

  const response = await request(app).get('/api/mcp/base/connect?returnTo=/stream');
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^https:\/\/mcp\.base\.org\/authorize\?/);
  const row = fake.tokens.get('default-user:base-mcp');
  assert.equal(row?.encryptedTokens, null);
  assert.equal(row?.encryptedClientInfo, null);
  assert.equal(row?.encryptedDiscoveryState, null);

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('GET /api/mcp/base/connect never exposes an OAuth failure as HTTP 500', async () => {
  const fake = createFakeDb();
  baseMcpOAuthStoreRuntime.db = fake.db;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  const originalSecret = process.env.SESSION_SECRET;
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  process.env.SESSION_SECRET = 'test-session-secret';
  mcpBaseRouteRuntime.auth = async () => {
    throw new Error('Unsupported state or unable to authenticate data');
  };

  const response = await request(app).get('/api/mcp/base/connect');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/base-mcp?mcp=error&code=credentials_invalid');
  assert.equal(JSON.stringify(response.headers).includes('authenticate data'), false);

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
  assert.strictEqual(missing.status, 302);
  assert.equal(missing.headers.location, '/stream?mcp=error&code=authorization_failed');

  const invalid = await request(app).get('/api/mcp/base/callback?code=abc&state=wrong');
  assert.strictEqual(invalid.status, 302);
  assert.equal(invalid.headers.location, '/stream?mcp=error&code=authorization_failed');

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
  assert.strictEqual(statusResponse.body.baseMcp.status, 'degraded');
  assert.strictEqual(statusResponse.body.baseMcp.readiness, 'oauth_connected');
  assert.strictEqual(statusResponse.body.baseMcp.usable, false);
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
  assert.strictEqual(response.headers.location, '/configure?mcp=error&code=authorization_failed');
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
  assert.strictEqual(response.headers.location, '/base-mcp?mcp=error&code=authorization_failed');
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
      routing: { read: 1, action: 0, routable: 0, blocked: 1 },
      tools: [
        {
          name: 'get_wallets',
          description: 'Wallet inventory',
          capability: 'read_only',
          scope: 'wallet',
          enabled: true,
          reason: 'read_only_allowlist',
          surface: 'read',
          surfaceEnabled: true,
          surfaceReason: 'read_in_extensions',
        },
        {
          name: 'send_calls',
          description: 'Listed only, never invoked by probe',
          capability: 'user_confirmed_transaction',
          scope: 'wallet',
          enabled: false,
          reason: 'transaction_tool_user_confirmation_required',
          surface: 'blocked',
          surfaceEnabled: false,
          surfaceReason: 'explicit_extension_adapter_required',
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
    routing: { read: 1, action: 0, routable: 0, blocked: 1 },
    tools: [
      {
        name: 'get_wallets',
        description: 'Wallet inventory',
        capability: 'read_only',
        scope: 'wallet',
        enabled: true,
        reason: 'read_only_allowlist',
        surface: 'read',
        surfaceEnabled: true,
        surfaceReason: 'read_in_extensions',
      },
      {
        name: 'send_calls',
        description: 'Listed only, never invoked by probe',
        capability: 'user_confirmed_transaction',
        scope: 'wallet',
        enabled: false,
        reason: 'transaction_tool_user_confirmation_required',
        surface: 'blocked',
        surfaceEnabled: false,
        surfaceReason: 'explicit_extension_adapter_required',
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
    routing: { read: 0, action: 0, routable: 0, blocked: 0 },
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

test('GET /api/mcp/base/plugins lists the catalogue without a Base MCP session', async () => {
  // The whole point of splitting this from the tool probe: which plugins Base
  // publishes is public, and a user whose token expired should still see them.
  // Hiding the catalogue behind the connection is what produced a page about
  // Base MCP with no plugin on it.
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  delete process.env.BASE_MCP_ENABLED;
  mcpBaseRouteRuntime.baseMcpPluginDriftV1 = async () => ({
    status: 'in_sync' as const,
    knownCount: 20,
    publishedCount: 20,
    added: [],
    removed: [],
    checkedAt: '2026-08-09T12:00:00.000Z',
    reason: null,
  });

  const response = await request(app).get('/api/mcp/base/plugins');
  assert.strictEqual(response.status, 200);
  assert.ok(response.body.plugins.length >= 20);
  assert.strictEqual(response.body.drift.status, 'in_sync');
  const uniswap = response.body.plugins.find((plugin: { id: string }) => plugin.id === 'uniswap');
  assert.ok(uniswap, 'uniswap must be in the catalogue');
  assert.ok(uniswap.hosts.includes('trade-api.gateway.uniswap.org'));

  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
});

test('the public catalogue does not make OAuth, console or actions public', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDevSingleUser = process.env.DEV_SINGLE_USER;
  process.env.NODE_ENV = 'production';
  delete process.env.DEV_SINGLE_USER;
  mcpBaseRouteRuntime.baseMcpPluginDriftV1 = async () => ({
    status: 'unchecked' as const,
    knownCount: 20,
    publishedCount: null,
    added: [],
    removed: [],
    checkedAt: null,
    reason: 'check_disabled',
  });

  try {
    const catalogue = await request(app).get('/api/mcp/base/plugins');
    const probe = await request(app).get('/api/mcp/base/probe');
    const consoleAnswer = await request(app).post('/api/mcp/base/console').send({ message: 'What do I hold?' });
    const actions = await request(app).get('/api/mcp/base/actions');

    assert.strictEqual(catalogue.status, 200);
    assert.ok(catalogue.body.plugins.length >= 20);
    assert.strictEqual(probe.status, 401);
    assert.strictEqual(consoleAnswer.status, 401);
    assert.strictEqual(actions.status, 401);
  } finally {
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('DEV_SINGLE_USER', originalDevSingleUser);
  }
});

test('GET /api/mcp/base/plugins still lists the catalogue when the drift check fails', async () => {
  // A failed drift check must degrade the INDICATOR, never the list. Returning
  // no plugins because github was unreachable would be the same defect as
  // reporting "no plugins exist" — our outage wearing Base's name.
  mcpBaseRouteRuntime.baseMcpPluginDriftV1 = async () => ({
    status: 'unchecked' as const,
    knownCount: 20,
    publishedCount: null,
    added: [],
    removed: [],
    checkedAt: null,
    reason: 'source_unreachable',
  });

  const response = await request(app).get('/api/mcp/base/plugins');
  assert.strictEqual(response.status, 200);
  assert.ok(response.body.plugins.length >= 20);
  assert.strictEqual(response.body.drift.status, 'unchecked');
  assert.strictEqual(response.body.drift.publishedCount, null);
});

test('POST /api/mcp/base/console returns the answer with its trace', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  let receivedEnabled: boolean | undefined;
  mcpBaseRouteRuntime.runBaseMcpConsoleV1 = async (input) => {
    receivedEnabled = input.enabled;
    return {
      status: 'answered' as const,
      reply: 'Your Base Account holds 12 USDC.',
      trace: [{ tool: 'get_portfolio', args: '{}', ok: true, result: '{"usd":"12"}', errorCode: null }],
      toolsAvailable: 15,
      truncated: false,
      elapsedMs: 1200,
      errorCode: null,
      checkedAt: '2026-08-09T12:00:00.000Z',
    };
  };

  const response = await request(app).post('/api/mcp/base/console').send({ message: 'what do I hold?' });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'answered');
  assert.strictEqual(response.body.trace.length, 1);
  assert.strictEqual(response.body.trace[0].tool, 'get_portfolio');
  assert.strictEqual(typeof receivedEnabled, 'boolean');
  assert.strictEqual(JSON.stringify(response.body).includes('test-session-secret'), false);

  restoreEnv('SESSION_SECRET', originalSecret);
});

test('POST /api/mcp/base/console rejects an empty message before running anything', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  let called = false;
  mcpBaseRouteRuntime.runBaseMcpConsoleV1 = async () => {
    called = true;
    throw new Error('must not run');
  };

  const response = await request(app).post('/api/mcp/base/console').send({ message: '' });
  assert.ok(response.status >= 400, `expected a validation failure, got ${response.status}`);
  assert.strictEqual(called, false);

  restoreEnv('SESSION_SECRET', originalSecret);
});

const ACTION_RECEIPT = {
  schemaVersion: 'base-mcp-action-receipt/v1' as const,
  id: 'base-mcp-action:1',
  actionHash: `0x${'a'.repeat(64)}` as const,
  actionType: 'send' as const,
  provider: 'base-mcp' as const,
  chainId: 8453 as const,
  walletAddress: '0x1111111111111111111111111111111111111111' as const,
  status: 'approval_required' as const,
  capabilityPolicy: 'passed' as const,
  asset: {
    symbol: 'USDC' as const,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    decimals: 6 as const,
  },
  amount: '5',
  recipient: '0x2222222222222222222222222222222222222222' as const,
  recipientName: null,
  approvalRequired: true as const,
  reconciliationState: 'not_started' as const,
  transactionHash: null,
  blockNumber: null,
  errorCode: null,
  createdAt: '2026-08-12T12:00:00.000Z',
  updatedAt: '2026-08-12T12:00:00.000Z',
  finalizedAt: null,
  routeVerified: false as const,
  reconciliationBasis: 'erc20_transfer_event' as const,
};

test('POST /api/mcp/base/console hands swaps and Flaunch token buys to Routes AI before any Base MCP tool runs', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  let consoleCalled = false;
  let actionCalled = false;
  mcpBaseRouteRuntime.runBaseMcpConsoleV1 = async () => {
    consoleCalled = true;
    throw new Error('must not run');
  };
  mcpBaseRouteRuntime.prepareBaseMcpSendActionV1 = async () => {
    actionCalled = true;
    throw new Error('must not run');
  };

  for (const [message, provider] of [
    ['Swap 100 USDC to ETH', null],
    ['Buy this Flaunch token with 0.001 ETH', 'flaunch'],
  ] as const) {
    const response = await request(app)
      .post('/api/mcp/base/console')
      .send({ message, requestId: `handoff-${provider ?? 'swap'}` });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'handoff');
    assert.equal(response.body.handoff.target, 'routes');
    assert.equal(response.body.handoff.provider, provider);
    assert.equal(response.body.action, null);
  }
  assert.equal(consoleCalled, false);
  assert.equal(actionCalled, false);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('POST /api/mcp/base/console returns an approval Action Receipt for exact send', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  mcpBaseRouteRuntime.prepareBaseMcpSendActionV1 = async (input) => {
    assert.equal(input.idempotencyKey, 'send-1');
    assert.equal(input.intent.amountAtomic, '5000000');
    return {
      kind: 'action',
      reply: 'Review in Base Account.',
      errorCode: null,
      toolsAvailable: 15,
      receipt: ACTION_RECEIPT,
      approvalUrl: 'https://keys.coinbase.com/approve/send-1',
    };
  };

  const response = await request(app)
    .post('/api/mcp/base/console')
    .send({
      message: `Send 5 USDC to ${ACTION_RECEIPT.recipient}`,
      requestId: 'send-1',
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'action');
  assert.equal(response.body.action.receipt.routeVerified, false);
  assert.equal(response.body.action.approvalUrl, 'https://keys.coinbase.com/approve/send-1');
  assert.equal(response.body.handoff, null);
  restoreEnv('SESSION_SECRET', originalSecret);
  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
});

test('POST /api/mcp/base/console exposes reviewed Virtuals sign-in as an Action Receipt', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  mcpBaseRouteRuntime.prepareBaseMcpVirtualsAgentCreateV1 = async (input) => ({
    kind: 'action',
    reply: 'Approve only this Virtuals sign-in message.',
    errorCode: null,
    toolsAvailable: 2,
    approvalUrl: 'https://keys.coinbase.com/approve/virtuals-sign-1',
    resultPreview: null,
    receipt: {
      schemaVersion: 'base-mcp-action-receipt/v1',
      id: 'base-mcp-action:virtuals-1',
      actionHash: `0x${'b'.repeat(64)}`,
      actionType: 'virtuals',
      provider: 'base-mcp',
      chainId: 8453,
      walletAddress: (input.walletAddress ?? '0x1111111111111111111111111111111111111111').toLowerCase() as `0x${string}`,
      status: 'approval_required',
      capabilityPolicy: 'passed',
      approvalRequired: true,
      reconciliationState: 'not_started',
      transactionHash: null,
      blockNumber: null,
      errorCode: null,
      createdAt: '2026-08-20T20:00:00.000Z',
      updatedAt: '2026-08-20T20:00:00.000Z',
      finalizedAt: null,
      routeVerified: false,
      extensionProvider: 'virtuals',
      operation: 'agent_create',
      agentName: input.intent.agentName,
      agentDescription: input.intent.agentDescription,
      providerObjectId: null,
      reconciliationBasis: 'virtuals_provider_response',
    },
  });

  const response = await request(app).post('/api/mcp/base/console').send({
    message: 'Create a Virtuals agent called Mio Researcher to summarize Base research',
    requestId: 'virtuals-create-1',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'action');
  assert.equal(response.body.action.receipt.actionType, 'virtuals');
  assert.equal(response.body.action.receipt.agentName, 'Mio Researcher');
  assert.equal(response.body.action.approvalUrl, 'https://keys.coinbase.com/approve/virtuals-sign-1');
  restoreEnv('SESSION_SECRET', originalSecret);
  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
});

test('POST /api/mcp/base/console resolves a Basename before preparing the exact send', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalEnabled = process.env.BASE_MCP_ENABLED;
  const originalUrl = process.env.BASE_MCP_SERVER_URL;
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.BASE_MCP_ENABLED = 'true';
  process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org';
  mcpBaseRouteRuntime.resolveBaseNameV1 = async (name) => ({
    outcome: 'resolved', name, address: ACTION_RECEIPT.recipient,
  });
  mcpBaseRouteRuntime.prepareBaseMcpSendActionV1 = async (input) => {
    assert.equal(input.intent.recipientName, 'mioku.base.eth');
    assert.equal(input.intent.recipient, ACTION_RECEIPT.recipient);
    return {
      kind: 'action', reply: 'Review in Base Account.', errorCode: null,
      toolsAvailable: 15,
      receipt: { ...ACTION_RECEIPT, recipientName: 'mioku.base.eth' },
      approvalUrl: 'https://keys.coinbase.com/approve/send-name-1',
    };
  };

  const response = await request(app).post('/api/mcp/base/console').send({
    message: 'Send 5 USDC to mioku.base.eth', requestId: 'send-name-1',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'action');
  assert.equal(response.body.action.receipt.recipientName, 'mioku.base.eth');
  assert.equal(response.body.action.receipt.recipient, ACTION_RECEIPT.recipient);
  restoreEnv('SESSION_SECRET', originalSecret);
  restoreEnv('BASE_MCP_ENABLED', originalEnabled);
  restoreEnv('BASE_MCP_SERVER_URL', originalUrl);
});

test('POST /api/mcp/base/console never prepares a send when the Basename is unresolved', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  let prepared = false;
  mcpBaseRouteRuntime.resolveBaseNameV1 = async (name) => ({
    outcome: 'unresolved', name, errorCode: 'base_name_unresolved',
  });
  mcpBaseRouteRuntime.prepareBaseMcpSendActionV1 = async () => {
    prepared = true;
    throw new Error('must not prepare');
  };
  const response = await request(app).post('/api/mcp/base/console').send({
    message: 'Send 5 USDC to missing.base.eth', requestId: 'send-name-missing',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'needs_input');
  assert.equal(response.body.errorCode, 'base_name_unresolved');
  assert.equal(prepared, false);
  restoreEnv('SESSION_SECRET', originalSecret);
});

test('Action Receipt list and reconcile routes remain tenant-scoped projections', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-session-secret';
  mcpBaseRouteRuntime.listBaseMcpActionReceiptsV1 = async (userId) => {
    assert.equal(userId, 'default-user');
    return [ACTION_RECEIPT];
  };
  mcpBaseRouteRuntime.reconcileBaseMcpActionV1 = async (input) => {
    assert.equal(input.userId, 'default-user');
    assert.equal(input.receiptId, ACTION_RECEIPT.id);
    return {
      kind: 'action',
      reply: 'pending',
      errorCode: null,
      toolsAvailable: 1,
      receipt: ACTION_RECEIPT,
      approvalUrl: null,
    };
  };

  const list = await request(app).get('/api/mcp/base/actions');
  assert.equal(list.status, 200);
  assert.equal(list.body.receipts[0].id, ACTION_RECEIPT.id);
  const reconciled = await request(app).post(`/api/mcp/base/actions/${encodeURIComponent(ACTION_RECEIPT.id)}/reconcile`);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.receipt.id, ACTION_RECEIPT.id);
  restoreEnv('SESSION_SECRET', originalSecret);
});
