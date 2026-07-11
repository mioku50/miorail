import test, { describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { app } from '../app.js';
import { clearTokenSecurityCacheForTests, getTokenSecurityProviderFromEnv, setTokenSecurityHealthStatus } from '@mioagent/data-providers';
import { clearX402FacilitatorStatusForTests } from '@mioagent/x402-gateway';
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
const X402_ENV_KEYS = [
  'X402_FACILITATOR_URL',
  'X402_FACILITATOR_AUTH_TOKEN',
  'X402_FACILITATOR_API_KEY',
  'X402_PAYTO_ADDRESS',
  'X402_NETWORK',
  'X402_AMOUNT_ATOMIC_USDC',
  'X402_FACILITATOR_TIMEOUT_MS',
  'CDP_API_KEY',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'BUILDER_CODE',
] as const;
const ORIGINAL_X402_ENV = Object.fromEntries(
  X402_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof X402_ENV_KEYS)[number], string | undefined>;
const DEFAULT_BASE_MCP_AUTH = {
  connected: false,
  needsReauth: false,
  userScoped: true as const,
};

function testEcPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function clearX402EnvForStatusTests() {
  for (const key of X402_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreOriginalX402Env() {
  for (const key of X402_ENV_KEYS) {
    restoreEnv(key, ORIGINAL_X402_ENV[key]);
  }
}

describe('Status API', () => {
  beforeEach(() => {
    clearBaseMcpStatusForTests();
    clearX402FacilitatorStatusForTests();
    clearX402EnvForStatusTests();
    clearProviderCacheForTests();
    setProviderCacheForTests(new InMemoryProviderCacheStore(), new ProviderBudget(20, 300));
    mock.restoreAll();
    global.fetch = ORIGINAL_FETCH;
    statusRouteRuntime.getBaseMcpAuthStatus = async () => DEFAULT_BASE_MCP_AUTH;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    restoreOriginalX402Env();
    clearX402FacilitatorStatusForTests();
  });

  test('GET /api/status returns missing risk provider by default', async () => {
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    delete process.env.TOKEN_SECURITY_PROVIDER;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'none');
    assert.strictEqual(response.body.risk.status, 'missing');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
  });

  test('GET /api/status reports GoPlus configured but unverified before a successful scan', async () => {
    clearTokenSecurityCacheForTests();
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'goplus');
    assert.strictEqual(response.body.risk.status, 'missing');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
  });

  test('GET /api/status reports GoPlus connected only after shared token-level health succeeds', async () => {
    clearTokenSecurityCacheForTests();
    const original = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'goplus';
    getTokenSecurityProviderFromEnv();
    setTokenSecurityHealthStatus('connected');

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.risk.provider, 'goplus');
    assert.strictEqual(response.body.risk.status, 'connected');

    restoreEnv('TOKEN_SECURITY_PROVIDER', original);
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

  test('GET /api/status reports autonomy persistence and mainnet gates without leaking database URL', async () => {
    const origMainnetExecution = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.MAINNET_EXECUTION_ENABLED = 'false';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.autonomy, {
      spendPermissionsPersistence: 'database',
      databaseConfigured: true,
      chainMode: response.body.chainEnv,
      mainnetExecutionEnabled: false,
      mainnetRequiresUserOptIn: true,
    });
    assert.strictEqual(JSON.stringify(response.body.autonomy).includes(process.env.DATABASE_URL || 'never-match'), false);

    restoreEnv('MAINNET_EXECUTION_ENABLED', origMainnetExecution);
  });

  test('GET /api/status reports x402 simulated when real settlement env is absent', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    const origBuilderCode = process.env.BUILDER_CODE;
    delete process.env.X402_FACILITATOR_URL;
    delete process.env.X402_PAYTO_ADDRESS;
    delete process.env.X402_NETWORK;
    delete process.env.BUILDER_CODE;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'simulated');
    assert.strictEqual(response.body.x402.configured, false);
    assert.strictEqual(response.body.x402.settleReady, false);
    assert.strictEqual(response.body.x402.settleBlockedReason, 'x402_not_configured');
    assert.deepStrictEqual(response.body.x402.missingConfig, []);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('facilitator'), true);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('https://'), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
    restoreEnv('BUILDER_CODE', origBuilderCode);
  });

  test('GET /api/status reports x402 missing for partial real settlement env', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.test/private?token=secret';
    delete process.env.X402_PAYTO_ADDRESS;
    delete process.env.X402_NETWORK;

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'missing');
    assert.strictEqual(response.body.x402.configured, false);
    assert.strictEqual(response.body.x402.settleReady, false);
    assert.ok(response.body.x402.missingConfig.includes('X402_PAYTO_ADDRESS'));
    assert.ok(response.body.x402.missingConfig.includes('X402_NETWORK'));
    assert.strictEqual(JSON.stringify(response.body.x402).includes('private?token=secret'), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
  });

  test('GET /api/status reports mainnet x402 auth required before facilitator probing', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    const origBuilderCode = process.env.BUILDER_CODE;
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.test/private?token=url-secret';
    process.env.X402_PAYTO_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.X402_NETWORK = 'eip155:8453';
    process.env.BUILDER_CODE = 'miorail';
    global.fetch = async () => {
      return new Response('{}', { status: 200 });
    };

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'facilitator_auth_required');
    assert.strictEqual(response.body.x402.configured, true);
    assert.strictEqual(response.body.x402.facilitatorAuthConfigured, false);
    assert.strictEqual(response.body.x402.settleReady, false);
    assert.strictEqual(response.body.x402.settleBlockedReason, 'facilitator_auth_missing');
    assert.strictEqual(response.body.x402.errorCode, 'facilitator_auth_missing');
    assert.strictEqual(JSON.stringify(response.body.x402).includes('url-secret'), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
    restoreEnv('BUILDER_CODE', origBuilderCode);
    global.fetch = ORIGINAL_FETCH;
  });

  test('GET /api/status reports x402 connected after successful facilitator probe', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    const origBuilderCode = process.env.BUILDER_CODE;
    const origAuthToken = process.env.X402_FACILITATOR_AUTH_TOKEN;
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.test';
    process.env.X402_PAYTO_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.X402_NETWORK = 'eip155:8453';
    process.env.BUILDER_CODE = 'miorail';
    process.env.X402_FACILITATOR_AUTH_TOKEN = 'secret-token';
    global.fetch = async (input, init) => {
      assert.ok(String(input).endsWith('/supported'));
      assert.strictEqual((init?.headers as Record<string, string>).Authorization, 'Bearer secret-token');
      return new Response(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'connected');
    assert.strictEqual(response.body.x402.configured, true);
    assert.strictEqual(response.body.x402.network, 'eip155:8453');
    assert.strictEqual(response.body.x402.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.strictEqual(response.body.x402.facilitatorConfigured, true);
    assert.strictEqual(response.body.x402.payToConfigured, true);
    assert.strictEqual(response.body.x402.builderCodeConfigured, true);
    assert.strictEqual(response.body.x402.facilitatorAuthConfigured, true);
    assert.strictEqual(response.body.x402.authSource, 'bearer_token');
    assert.strictEqual(response.body.x402.settleReady, true);
    assert.strictEqual(response.body.x402.probeStatus, 'connected');
    assert.strictEqual(response.body.x402.supportedKindsCount, 1);
    assert.deepStrictEqual(response.body.x402.supportedNetworks, ['eip155:8453']);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('facilitator.example.test'), false);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('secret-token'), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
    restoreEnv('BUILDER_CODE', origBuilderCode);
    restoreEnv('X402_FACILITATOR_AUTH_TOKEN', origAuthToken);
    global.fetch = ORIGINAL_FETCH;
  });

  test('GET /api/status reports x402 facilitator auth required without leaking secrets', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    const origBuilderCode = process.env.BUILDER_CODE;
    const origAuthToken = process.env.X402_FACILITATOR_AUTH_TOKEN;
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.test/private?token=url-secret';
    process.env.X402_PAYTO_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.X402_NETWORK = 'eip155:8453';
    process.env.BUILDER_CODE = 'miorail';
    process.env.X402_FACILITATOR_AUTH_TOKEN = 'secret-token';
    global.fetch = async () => new Response('Unauthorized secret-token', { status: 401 });

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'facilitator_auth_required');
    assert.strictEqual(response.body.x402.configured, true);
    assert.strictEqual(response.body.x402.facilitatorConfigured, true);
    assert.strictEqual(response.body.x402.payToConfigured, true);
    assert.strictEqual(response.body.x402.builderCodeConfigured, true);
    assert.strictEqual(response.body.x402.errorCode, 'facilitator_401');
    assert.strictEqual(response.body.x402.settleReady, false);
    assert.strictEqual(response.body.x402.settleBlockedReason, 'facilitator_401');
    assert.strictEqual(response.body.x402.probeStatus, 'facilitator_auth_required');
    assert.strictEqual(response.body.x402.authSource, 'bearer_token');
    assert.strictEqual(JSON.stringify(response.body.x402).includes('url-secret'), false);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('secret-token'), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
    restoreEnv('BUILDER_CODE', origBuilderCode);
    restoreEnv('X402_FACILITATOR_AUTH_TOKEN', origAuthToken);
    global.fetch = ORIGINAL_FETCH;
  });

  test('GET /api/status reports CDP key-pair x402 auth source without leaking JWT or secret', async () => {
    const origFacilitator = process.env.X402_FACILITATOR_URL;
    const origPayTo = process.env.X402_PAYTO_ADDRESS;
    const origNetwork = process.env.X402_NETWORK;
    const origBuilderCode = process.env.BUILDER_CODE;
    const origAuthToken = process.env.X402_FACILITATOR_AUTH_TOKEN;
    const origApiKey = process.env.X402_FACILITATOR_API_KEY;
    const origCdpApiKey = process.env.CDP_API_KEY;
    const origCdpId = process.env.CDP_API_KEY_ID;
    const origCdpSecret = process.env.CDP_API_KEY_SECRET;
    const secret = testEcPrivateKey();
    process.env.X402_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402?token=url-secret';
    process.env.X402_PAYTO_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.X402_NETWORK = 'eip155:8453';
    process.env.BUILDER_CODE = 'miorail';
    delete process.env.X402_FACILITATOR_AUTH_TOKEN;
    delete process.env.X402_FACILITATOR_API_KEY;
    delete process.env.CDP_API_KEY;
    process.env.CDP_API_KEY_ID = 'organizations/example/apiKeys/key';
    process.env.CDP_API_KEY_SECRET = secret.replace(/\n/g, '\\n');
    global.fetch = async (input, init) => {
      assert.ok(String(input).endsWith('/supported'));
      const authorization = (init?.headers as Record<string, string>).Authorization;
      assert.ok(authorization.startsWith('Bearer '));
      const jwt = authorization.replace(/^Bearer +/, '');
      const payload = decodeJwtPayload(jwt);
      assert.deepStrictEqual(payload.uris, ['GET api.cdp.coinbase.com/platform/v2/x402/supported']);
      return new Response(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.x402.status, 'connected');
    assert.strictEqual(response.body.x402.facilitatorAuthConfigured, true);
    assert.strictEqual(response.body.x402.authSource, 'cdp_api_key_pair');
    assert.strictEqual(response.body.x402.settleReady, true);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('url-secret'), false);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('organizations/example/apiKeys/key'), false);
    assert.strictEqual(JSON.stringify(response.body.x402).includes(secret), false);
    assert.strictEqual(JSON.stringify(response.body.x402).includes('Bearer '), false);

    restoreEnv('X402_FACILITATOR_URL', origFacilitator);
    restoreEnv('X402_PAYTO_ADDRESS', origPayTo);
    restoreEnv('X402_NETWORK', origNetwork);
    restoreEnv('BUILDER_CODE', origBuilderCode);
    restoreEnv('X402_FACILITATOR_AUTH_TOKEN', origAuthToken);
    restoreEnv('X402_FACILITATOR_API_KEY', origApiKey);
    restoreEnv('CDP_API_KEY', origCdpApiKey);
    restoreEnv('CDP_API_KEY_ID', origCdpId);
    restoreEnv('CDP_API_KEY_SECRET', origCdpSecret);
    global.fetch = ORIGINAL_FETCH;
  });

  test('GET /api/status reports the T19.1 split execution flags with broadcast disabled', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origMainnetExec = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    const exec = response.body.execution;
    assert.strictEqual(exec.mode, 'read-only');
    assert.strictEqual(exec.userConfirmedEnabled, false);
    assert.strictEqual(exec.serverBroadcastEnabled, false);
    assert.strictEqual(exec.mainnetExecutionEnabled, false);
    assert.strictEqual(exec.broadcastEnabled, false);
    // T19.1: the generic `enabled` flag is removed so the UI can never infer
    // "Execute" from a single flag.
    assert.strictEqual(exec.enabled, undefined);

    restoreEnv('CHAIN_ENV', origChain);
    restoreEnv('MAINNET_EXECUTION_ENABLED', origMainnetExec);
  });

  test('GET /api/status activates mainnet only as user-confirmed and never server-broadcast', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origMainnetExec = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';

    const response = await request(app).get('/api/status');
    assert.strictEqual(response.status, 200);
    const exec = response.body.execution;
    assert.strictEqual(exec.mode, 'user-confirmed');
    assert.strictEqual(exec.userConfirmedEnabled, true);
    assert.strictEqual(exec.serverBroadcastEnabled, false);
    assert.strictEqual(exec.mainnetExecutionEnabled, true);
    assert.strictEqual(exec.broadcastEnabled, false);

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
      readiness: 'not_configured',
      usable: false,
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
      readiness: 'configured',
      usable: false,
      auth: DEFAULT_BASE_MCP_AUTH,
    });
    assert.strictEqual(JSON.stringify(response.body.baseMcp).includes('private/path'), false);

    restoreEnv('BASE_MCP_ENABLED', origEnabled);
    restoreEnv('BASE_MCP_SERVER_URL', origUrl);
    restoreEnv('BASE_MCP_URL', origLegacyUrl);
    restoreEnv('MCP_SERVER_URL', origLegacyMcpUrl);
  });

  test('GET /api/status distinguishes OAuth connected from user-scoped tools verified', async () => {
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
    assert.strictEqual(response.body.baseMcp.status, 'degraded');
    assert.strictEqual(response.body.baseMcp.readiness, 'oauth_connected');
    assert.strictEqual(response.body.baseMcp.usable, false);
    assert.strictEqual(response.body.baseMcp.errorCode, 'tool_inventory_unverified');
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
      capabilities: {
        readOnly: 3,
        userConfirmedTransaction: 2,
        forbidden: 1,
        unknown: 1,
      },
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
    assert.strictEqual(response.body.baseMcp.readiness, 'tools_available');
    assert.strictEqual(response.body.baseMcp.usable, true);
    assert.strictEqual(response.body.baseMcp.toolsCount, 7);
    assert.strictEqual(response.body.baseMcp.readOnlyToolsCount, 3);
    assert.strictEqual(response.body.baseMcp.transactionToolsCount, 2);
    assert.strictEqual(response.body.baseMcp.forbiddenToolsCount, 1);
    assert.strictEqual(response.body.baseMcp.unknownToolsCount, 1);
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
