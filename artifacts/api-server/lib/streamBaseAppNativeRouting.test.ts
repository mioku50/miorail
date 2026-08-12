import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { BASE_UNISWAP_UNIVERSAL_ROUTER_2 } from '@mioagent/security/uniswapGuard';
import { canonicalGuardAssetV1 } from '@mioagent/security/swapAsset';
import {
  baseAppNativeRuntime,
  runDirectBaseAppNativeSend,
  runDirectBaseAppNativeSwap,
  prepareUniswap5792,
} from './streamBaseAppNativeRouting.js';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const TENANT_WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const MCP_WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const TENANT_ID = `eip155:8453:${TENANT_WALLET}`;
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const original = { ...baseAppNativeRuntime };

afterEach(() => {
  Object.assign(baseAppNativeRuntime, original);
});

async function readyRepository() {
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: TENANT_ID,
    chainId: 8453,
    walletAddress: TENANT_WALLET,
    dailyLimit: 20,
    maxPerAction: 5,
    whitelist: [RECIPIENT],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60 * 60_000,
    mainnetOptIn: true,
  });
  baseAppNativeRuntime.getRepository = () => repository;
  return repository;
}

function usableSecurity() {
  baseAppNativeRuntime.loadTokenSecurity = async (_chainId, addresses) => ({
    required: true,
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: addresses.map((address) => ({
      address,
      provider: 'goplus' as const,
      status: 'ok' as const,
    })),
  });
}

test('T47 native send binds the action and wallet_sendCalls payload to the BaseApp tenant wallet', async () => {
  await readyRepository();
  usableSecurity();
  const inserted: any[] = [];
  baseAppNativeRuntime.insertAction = async (row) => { inserted.push(row); };
  baseAppNativeRuntime.evaluate = (async () => ({ allowed: true, success: true, code: 'allowed' })) as any;

  const result = await runDirectBaseAppNativeSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: TENANT_WALLET,
    userConfirmedEnabled: true,
    userId: TENANT_ID,
  });

  assert.equal(result?.kind, 'baseapp_native_send');
  assert.equal(result?.errorCode, undefined);
  assert.ok(result?.actionId);
  assert.equal(result?.preparedPayload?.walletAddress, TENANT_WALLET);
  assert.equal(result?.preparedPayload?.tenantId, TENANT_ID);
  assert.equal('approvalUrl' in (result || {}), false);
  assert.equal(inserted[0].userId, TENANT_ID);
  assert.equal(inserted[0].metadata.walletAddress, TENANT_WALLET);
  assert.equal(JSON.parse(inserted[0].executionPayload).actionType, 'limited_transfer');
});

test('T47 native swap prepares only the tenant wallet and never returns the other MCP approval URL', async () => {
  await readyRepository();
  usableSecurity();
  const inserted: any[] = [];
  baseAppNativeRuntime.insertAction = async (row) => { inserted.push(row); };
  baseAppNativeRuntime.prepareUniswap5792 = async (_intent, walletAddress) => {
    assert.equal(walletAddress, TENANT_WALLET);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }],
      requestId: 'tenant-swap',
      expiresAt,
      context: {
        amountDecimal: '0.5',
        inputAsset: canonicalGuardAssetV1('USDC')!,
        outputAsset: canonicalGuardAssetV1('ETH')!,
        swapper: TENANT_WALLET,
        routerVersion: '2.0',
        expiresAt,
      },
    };
  };

  const result = await runDirectBaseAppNativeSwap({
    message: 'swap 0.5 USDC to ETH',
    walletAddress: TENANT_WALLET,
    userConfirmedEnabled: true,
    userId: TENANT_ID,
  });

  assert.equal(result?.kind, 'baseapp_native_swap');
  assert.equal(result?.errorCode, undefined);
  assert.equal(result?.preparedPayload?.walletAddress, TENANT_WALLET);
  assert.equal(JSON.stringify(result).includes(MCP_WALLET), false);
  assert.equal(JSON.stringify(result).includes('approvalUrl'), false);
  assert.equal(inserted[0].metadata.walletAddress, TENANT_WALLET);
  assert.equal(inserted[0].metadata.uniswap.swapper, TENANT_WALLET);
});

test('T47 native policy lookup cannot fall through to the Coinbase OAuth wallet', async () => {
  await readyRepository();
  usableSecurity();
  const result = await runDirectBaseAppNativeSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: MCP_WALLET,
    userConfirmedEnabled: true,
    userId: `eip155:8453:${MCP_WALLET}`,
  });
  assert.equal(result?.errorCode, 'mainnet_policy_not_ready');
});

test('T48b: native swap tool trace has real skill_load, plugin_http_request, security_preflight, and prepare_wallet_calls steps in order', async () => {
  await readyRepository();
  usableSecurity();
  baseAppNativeRuntime.insertAction = async () => {};
  baseAppNativeRuntime.prepareUniswap5792 = async (_intent, walletAddress) => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    return {
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0x12345678' }],
      requestId: 'trace-swap',
      expiresAt,
      context: {
        amountDecimal: '0.5',
        inputAsset: canonicalGuardAssetV1('USDC')!,
        outputAsset: canonicalGuardAssetV1('ETH')!,
        swapper: walletAddress,
        routerVersion: '2.0',
        expiresAt,
      },
      traces: [
        { toolName: 'plugin_http_request:POST /v1/quote', args: { path: '/quote' }, result: { status: 'success' }, isError: false },
        { toolName: 'plugin_http_request:POST /v1/swap_5792', args: { path: '/swap_5792' }, result: { status: 'success' }, isError: false },
      ],
    };
  };

  const result = await runDirectBaseAppNativeSwap({
    message: 'swap 0.5 USDC to ETH',
    walletAddress: TENANT_WALLET,
    userConfirmedEnabled: true,
    userId: TENANT_ID,
  });

  const names = (result?.toolCalls || []).map((t) => t.toolName);
  assert.deepEqual(names, [
    'skill_load:uniswap',
    'plugin_http_request:POST /v1/quote',
    'plugin_http_request:POST /v1/swap_5792',
    'security_preflight',
    'prepare_wallet_calls',
  ]);
  assert.ok((result?.toolCalls || []).every((t) => !t.isError));
  // No invented tool name like "uniswap_quote" (that's a different, LLM-facing
  // read-only tool with no MCP counterpart in this flow).
  assert.ok(!names.includes('uniswap_quote'));
});

test('T48b: prepareUniswap5792 goes through the plugin_http_request gateway (manifest host only) and works in mcp mode without UNISWAP_API_KEY', async () => {
  const originalFetch = globalThis.fetch;
  const capturedUrls: string[] = [];
  let capturedHeaders: Record<string, string> | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    capturedUrls.push(String(url));
    capturedHeaders = init?.headers as Record<string, string>;
    if (String(url).includes('/v1/quote')) {
      return new Response(JSON.stringify({ routing: 'CLASSIC', quote: { routing: 'CLASSIC' } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      from: TENANT_WALLET,
      chainId: 8453,
      requestId: 'gateway-swap',
      calls: [{ to: BASE_UNISWAP_UNIVERSAL_ROUTER_2, value: '0', data: '0xabcdef' }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv({ BASE_MCP_PLUGIN_MODE: undefined, UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: 'gateway-secret' }, async () => {
      const prepared = await prepareUniswap5792({ amount: '0.5', tokenIn: 'USDC', tokenOut: 'ETH' }, TENANT_WALLET);
      assert.equal(prepared.requestId, 'gateway-swap');
      assert.equal(prepared.traces?.length, 2);
      assert.ok(prepared.traces?.every((t) => !t.isError));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedUrls.every((url) => url.startsWith('https://trade-api.gateway.uniswap.org/')));
  assert.equal(capturedHeaders?.['x-api-key'], 'gateway-secret');
});
