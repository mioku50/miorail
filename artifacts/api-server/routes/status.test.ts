import test, { describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';
import { clearBaseMcpStatusForTests, recordBaseMcpToolProbe } from '../lib/baseMcpStatus.js';
import { statusRouteRuntime } from './status.js';
import {
  clearProviderCacheForTests,
  InMemoryProviderCacheStore,
  ProviderBudget,
  setProviderCacheForTests,
} from '../lib/providerCache.js';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const ORIGINAL_FETCH = global.fetch;
const DEFAULT_BASE_MCP_AUTH = {
  connected: false,
  needsReauth: false,
  userScoped: true as const,
};

describe('Status API', () => {
  beforeEach(() => {
    clearBaseMcpStatusForTests();
    clearProviderCacheForTests();
    setProviderCacheForTests(new InMemoryProviderCacheStore(), new ProviderBudget(20, 300));
    mock.restoreAll();
    global.fetch = ORIGINAL_FETCH;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => DEFAULT_BASE_MCP_AUTH;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  test('GET /api/status returns missing risk provider by default', async () => {
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    const originalApiKey = process.env.GOPLUS_API_KEY;
    delete process.env.TOKEN_SECURITY_PROVIDER;
    delete process.env.GOPLUS_API_KEY;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'none');
    assert.strictEqual(response.body.risk.status, 'missing');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
    restoreEnv('GOPLUS_API_KEY', originalApiKey);
  });

  test('GET /api/status returns GoPlus connected without requiring API key', async () => {
    clearTokenSecurityCacheForTests();
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    const originalApiKey = process.env.GOPLUS_API_KEY;
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
    delete process.env.GOPLUS_API_KEY;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'goplus');
    assert.strictEqual(response.body.risk.status, 'connected');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
    restoreEnv('GOPLUS_API_KEY', originalApiKey);
  });

  test('GET /api/status reports disabled (not failed) when providers are explicitly none', async () => {
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    const origApproval = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.tokenBalances.status, 'disabled');
    assert.strictEqual(response.body.prices.status, 'disabled');
    assert.strictEqual(response.body.risk.status, 'disabled');
    assert.strictEqual(response.body.approvals.status, 'disabled');

    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalances);
    restoreEnv('PRICE_PROVIDER', origPrice);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    restoreEnv('APPROVAL_PROVIDER', origApproval);
  });

  test('GET /api/status reports Moralis approval budget exhaustion without leaking secrets', async () => {
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origMoralisKey = process.env.MORALIS_API_KEY;
    process.env.APPROVAL_PROVIDER = 'moralis';
    process.env.MORALIS_API_KEY = 'moralis-secret-value';
    const budget = new ProviderBudget(20, 300);
    budget.markRemoteProviderIssue('moralis', {
      status: 'budget_exhausted',
      errorCode: 'moralis_auth_or_budget',
    });
    setProviderCacheForTests(new InMemoryProviderCacheStore(), budget);

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.approvals.provider, 'moralis');
    assert.strictEqual(response.body.approvals.status, 'budget_exhausted');
    assert.strictEqual(response.body.budgets.moralis.provider, 'moralis');
    assert.strictEqual(response.body.budgets.moralis.status, 'budget_exhausted');
    assert.strictEqual(response.body.budgets.moralis.budgetExhausted, true);
    assert.strictEqual(response.body.budgets.moralis.lastErrorCode, 'moralis_auth_or_budget');
    assert.strictEqual(JSON.stringify(response.body).includes('moralis-secret-value'), false);

    restoreEnv('APPROVAL_PROVIDER', origApproval);
    restoreEnv('MORALIS_API_KEY', origMoralisKey);
  });

  test('GET /api/status reports the T19.1 split execution flags with broadcast disabled', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origMainnetExec = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    const exec = response.body.execution;
    assert.strictEqual(exec.mode, 'user-confirmed');
    assert.strictEqual(exec.userConfirmedEnabled, true);
    assert.strictEqual(exec.serverBroadcastEnabled, false);
    assert.strictEqual(exec.mainnetExecutionEnabled, false);
    assert.strictEqual(exec.broadcastEnabled, false);
    // T19.1: the generic `enabled` flag is removed so the UI can never infer
    // "Execute" from a single flag.
    assert.strictEqual(exec.enabled, undefined);

    restoreEnv('CHAIN_ENV', origChain);
    restoreEnv('MAINNET_EXECUTION_ENABLED', origMainnetExec);
  });

  test('GET /api/status reports server-execution mode + broadcast enabled on sepolia', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origMainnetExec = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'sepolia';
    delete process.env.MAINNET_EXECUTION_ENABLED;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    const exec = response.body.execution;
    assert.strictEqual(exec.mode, 'server-execution');
    assert.strictEqual(exec.userConfirmedEnabled, true);
    assert.strictEqual(exec.serverBroadcastEnabled, true);
    assert.strictEqual(exec.mainnetExecutionEnabled, false);

    restoreEnv('CHAIN_ENV', origChain);
    restoreEnv('MAINNET_EXECUTION_ENABLED', origMainnetExec);
  });

  test('GET /api/status reports Base MCP missing when no env is configured', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const origLegacyUrl = process.env.BASE_MCP_URL;
    const origLegacyMcpUrl = process.env.MCP_SERVER_URL;
    delete process.env.BASE_MCP_ENABLED;
    delete process.env.BASE_MCP_SERVER_URL;
    delete process.env.BASE_MCP_URL;
    delete process.env.MCP_SERVER_URL;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.baseMcp, {
      status: 'missing',
      provider: 'base-mcp',
      configured: false,
      enabled: false,
      auth: DEFAULT_BASE_MCP_AUTH,
    });

    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
    restoreEnv('BASE_MCP_URL', origLegacyUrl);
    restoreEnv('MCP_SERVER_URL', origLegacyMcpUrl);
  });

  test('GET /api/status reports Base MCP disabled when env disables a configured endpoint', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const origLegacyUrl = process.env.BASE_MCP_URL;
    const origLegacyMcpUrl = process.env.MCP_SERVER_URL;
    process.env.BASE_MCP_ENABLED = 'false';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org/private/path?probe=1';
    delete process.env.BASE_MCP_URL;
    delete process.env.MCP_SERVER_URL;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.baseMcp, {
      status: 'disabled',
      provider: 'base-mcp',
      configured: true,
      enabled: false,
      endpointHost: 'mcp.base.org',
      auth: DEFAULT_BASE_MCP_AUTH,
    });
    assert.strictEqual(JSON.stringify(response.body.baseMcp).includes('private/path'), false);

    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
    restoreEnv('BASE_MCP_URL', origLegacyUrl);
    restoreEnv('MCP_SERVER_URL', origLegacyMcpUrl);
  });

  test('GET /api/status probes configured Base MCP and reports connected capabilities', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const origPath = process.env.BASE_MCP_STATUS_PATH;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.example.test/private/path?probe=1';
    process.env.BASE_MCP_STATUS_PATH = '/health';

    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      assert.strictEqual(String(url), 'https://mcp.example.test/health');
      return {
        ok: true,
        status: 200,
        json: async () => ({ tools: [{ name: 'get_portfolio' }, { name: 'help' }], resources: [{ uri: 'base://status' }] }),
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => ({
      connected: true,
      needsReauth: false,
      userScoped: true,
      expiresAt: '2026-07-07T18:00:00.000Z',
      connectedAt: '2026-07-07T17:00:00.000Z',
    });

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.baseMcp.status, 'connected');
    assert.strictEqual(response.body.baseMcp.provider, 'base-mcp');
    assert.strictEqual(response.body.baseMcp.configured, true);
    assert.strictEqual(response.body.baseMcp.enabled, true);
    assert.strictEqual(response.body.baseMcp.endpointHost, 'mcp.example.test');
    assert.deepStrictEqual(response.body.baseMcp.capabilities, { toolsCount: 2, resourcesCount: 1 });
    assert.ok(response.body.baseMcp.lastCheckedAt);
    assert.strictEqual(JSON.stringify(response.body.baseMcp).includes('private/path'), false);
    assert.deepStrictEqual(response.body.baseMcp.auth, {
      connected: true,
      needsReauth: false,
      userScoped: true,
      expiresAt: '2026-07-07T18:00:00.000Z',
      connectedAt: '2026-07-07T17:00:00.000Z',
    });
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
    restoreEnv('BASE_MCP_STATUS_PATH', origPath);
  });

  test('GET /api/status includes last successful Base MCP tool probe summary', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.example.test/private/path?probe=1';

    recordBaseMcpToolProbe({
      endpointHost: 'mcp.example.test',
      toolsCount: 7,
      checkedAt: '2026-07-08T00:00:00.000Z',
    });
    global.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response)) as unknown as typeof fetch;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => ({
      connected: true,
      needsReauth: false,
      userScoped: true,
      expiresAt: '2026-07-08T01:00:00.000Z',
      connectedAt: '2026-07-08T00:00:00.000Z',
    });

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.baseMcp.status, 'connected');
    assert.strictEqual(response.body.baseMcp.toolsCount, 7);
    assert.strictEqual(response.body.baseMcp.lastToolProbeAt, '2026-07-08T00:00:00.000Z');
    assert.strictEqual(JSON.stringify(response.body.baseMcp).includes('private/path'), false);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
  });

  test('GET /api/status reports configured Base MCP needs_reauth when user auth expired', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.example.test';

    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tools: [] }),
    } as Response)) as unknown as typeof fetch;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => ({
      connected: false,
      needsReauth: true,
      userScoped: true,
    });

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.baseMcp.status, 'needs_reauth');
    assert.strictEqual(response.body.baseMcp.auth.needsReauth, true);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
  });

  test('GET /api/status treats hosted Base MCP 404 probe as auth required, not unsupported', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const origPath = process.env.BASE_MCP_STATUS_PATH;
    const origLegacyUrl = process.env.BASE_MCP_URL;
    const origLegacyMcpUrl = process.env.MCP_SERVER_URL;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.base.org/private/path?probe=1';
    process.env.BASE_MCP_STATUS_PATH = '/health';
    delete process.env.BASE_MCP_URL;
    delete process.env.MCP_SERVER_URL;

    const mockFetch = mock.fn(async (url: string | URL | Request) => {
      assert.strictEqual(String(url), 'https://mcp.base.org/health');
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => DEFAULT_BASE_MCP_AUTH;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    const baseMcp = response.body.baseMcp;
    assert.strictEqual(baseMcp.status, 'needs_reauth');
    assert.notStrictEqual(baseMcp.status, 'unsupported');
    assert.strictEqual(baseMcp.provider, 'base-mcp');
    assert.strictEqual(baseMcp.configured, true);
    assert.strictEqual(baseMcp.enabled, true);
    assert.strictEqual(baseMcp.endpointHost, 'mcp.base.org');
    assert.strictEqual(baseMcp.errorCode, 'http_404');
    assert.deepStrictEqual(baseMcp.auth, {
      connected: false,
      needsReauth: true,
      userScoped: true,
    });
    assert.strictEqual(JSON.stringify(baseMcp).includes('https://mcp.base.org'), false);
    assert.strictEqual(JSON.stringify(baseMcp).includes('private/path'), false);
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
    restoreEnv('BASE_MCP_STATUS_PATH', origPath);
    restoreEnv('BASE_MCP_URL', origLegacyUrl);
    restoreEnv('MCP_SERVER_URL', origLegacyMcpUrl);
  });

  test('GET /api/status reports configured Base MCP timeout as unreachable', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.example.test';

    const mockFetch = mock.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.baseMcp.status, 'unreachable');
    assert.strictEqual(response.body.baseMcp.errorCode, 'timeout');
    assert.strictEqual(response.body.baseMcp.endpointHost, 'mcp.example.test');
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
  });

  test('GET /api/status reports Base MCP 429 as degraded rate_limited and caches cooldown', async () => {
    const origEnabled = process.env.BASE_MCP_ENABLED;
    const origUrl = process.env.BASE_MCP_SERVER_URL;
    const originalFetch = global.fetch;
    process.env.BASE_MCP_ENABLED = 'true';
    process.env.BASE_MCP_SERVER_URL = 'https://mcp.example.test';

    const mockFetch = mock.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate limited' }),
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;

    const first = await request(app).get('/api/status');
    const second = await request(app).get('/api/status');
    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(first.body.baseMcp.status, 'degraded');
    assert.strictEqual(first.body.baseMcp.errorCode, 'rate_limited');
    assert.strictEqual(second.body.baseMcp.status, 'degraded');
    assert.strictEqual(mockFetch.mock.calls.length, 1);

    global.fetch = originalFetch;
    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
  });
});
