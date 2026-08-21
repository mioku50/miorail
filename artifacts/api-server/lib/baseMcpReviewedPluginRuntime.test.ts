import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import { InMemoryBaseMcpPluginSessionStoreV1 } from './baseMcpPluginSessionStore.js';
import {
  reviewedBaseMcpPluginRuntimeV1,
  runReviewedBaseMcpPluginReadV1,
} from './baseMcpReviewedPluginRuntime.js';

const originalRuntime = { ...reviewedBaseMcpPluginRuntimeV1 };

afterEach(() => Object.assign(reviewedBaseMcpPluginRuntimeV1, originalRuntime));

function executor(calls: string[]): BaseMcpSkillExecutor {
  return {
    namespace: 'moonwell',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: { hosts: ['api.moonwell.fi'], methods: ['GET'], pathPrefixes: ['/v1/markets', '/v1/positions', '/v1/health'] },
      auth: 'none',
      risk: ['liquidation'],
    },
    allowedPaths: ['/v1/markets', '/v1/positions', '/v1/health'],
    async request(input) {
      calls.push(input.path);
      if (input.path.startsWith('/v1/markets')) {
        return { status: 200, data: { markets: [{ symbol: 'USDC', supplyApy: '4.2%' }] } };
      }
      if (input.path.startsWith('/v1/health')) return { status: 200, data: { healthFactor: '1.8' } };
      return { status: 200, data: { positions: [] } };
    },
  };
}

test('Moonwell market example runs the pinned reviewed recipe without an LLM', async () => {
  const calls: string[] = [];
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => executor(calls);
  reviewedBaseMcpPluginRuntimeV1.now = () => new Date('2026-08-20T20:00:00.000Z');

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'markets',
    message: 'Show Moonwell USDC supply markets on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });

  assert.ok(result);
  assert.equal(result.status, 'answered');
  assert.deepEqual(calls, ['/v1/markets/USDC?chain=base']);
  assert.equal(result.trace[0]?.tool, 'moonwell_get_markets');
  assert.equal(result.trace[0]?.ok, true);
  assert.match(result.reply ?? '', /USDC supply markets/);
  assert.match(result.reply ?? '', /4\.2%/);
});

test('Moonwell renders the live single-market data envelope', async () => {
  const calls: string[] = [];
  const liveEnvelopeExecutor = executor(calls);
  liveEnvelopeExecutor.request = async (input) => {
    calls.push(input.path);
    return {
      status: 200,
      data: {
        success: true,
        data: {
          asset: 'USDC',
          baseSupplyApy: 3.72,
          baseBorrowApy: 5.06,
          liquidityUsd: 2_750_163,
        },
      },
    };
  };
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => liveEnvelopeExecutor;

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'markets',
    message: 'Show Moonwell USDC supply markets on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });

  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /USDC/);
  assert.match(result?.reply ?? '', /supply 3\.72/);
  assert.match(result?.reply ?? '', /liquidity 2750163/);
});

test('Moonwell account recipe reads positions and health from the same reviewed host', async () => {
  const calls: string[] = [];
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => executor(calls);
  const wallet = '0x1111111111111111111111111111111111111111';
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'health',
    message: 'Check my Moonwell positions and health factor',
    walletAddress: wallet,
  });
  assert.ok(result);
  assert.equal(result.status, 'answered');
  assert.deepEqual(calls, [
    `/v1/positions/${wallet}?chain=base&active=true`,
    `/v1/health/${wallet}?chain=base`,
  ]);
  assert.deepEqual(result.trace.map((entry) => entry.tool), ['moonwell_get_positions', 'moonwell_get_health']);
});

test('Venice model discovery uses one reviewed GET with a bounded timeout', async () => {
  let seen: Parameters<BaseMcpSkillExecutor['request']>[0] | null = null;
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = (namespace) => {
    const loaded = executor([]);
    return {
      ...loaded,
      namespace,
      async request(input) {
        seen = input;
        return { status: 200, data: { data: [{ id: 'venice-uncensored', type: 'text', model_spec: { name: 'Venice Uncensored' } }] } };
      },
    };
  };
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'venice',
    exampleId: 'models',
    message: 'Show the models available from Venice AI',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  assert.equal(result?.status, 'answered');
  const request = seen as Parameters<BaseMcpSkillExecutor['request']>[0] | null;
  assert.ok(request);
  assert.equal(request.path, '/api/v1/models?type=all');
  assert.equal(request.method, 'GET');
  assert.equal(request.timeoutMs, 7_000);
  assert.match(result?.reply ?? '', /Venice public model catalogue: 1 models/);
  assert.match(result?.reply ?? '', /No x402 payment/);
});

test('Bankr latest launches use the pinned provider feed rather than generic help', async () => {
  const paths: string[] = [];
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = (namespace) => {
    const loaded = executor(paths);
    return {
      ...loaded,
      namespace,
      async request(input) {
        paths.push(input.path);
        return {
          status: 200,
          data: { launches: [{ status: 'deployed', chain: 'base', tokenSymbol: 'MIO', tokenName: 'Miorail', tokenAddress: '0xb2000000000000000000000578f3ae29d9e6e0101' }] },
        };
      },
    };
  };
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'bankr',
    exampleId: 'latest',
    message: 'Show the latest Bankr launches on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  assert.equal(result?.status, 'answered');
  assert.deepEqual(paths, ['/token-launches']);
  assert.match(result?.reply ?? '', /Latest deployed Bankr launches on Base/);
  assert.match(result?.reply ?? '', /MIO/);
});

test('Balancer yield read uses its exact reviewed GraphQL operation without building calldata', async () => {
  let seen: Parameters<BaseMcpSkillExecutor['request']>[0] | null = null;
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = (namespace) => {
    const loaded = executor([]);
    return {
      ...loaded,
      namespace,
      async request(input) {
        seen = input;
        return {
          status: 200,
          data: { data: { poolGetPools: [{ name: 'rETH / WETH', poolTokens: [{ symbol: 'rETH' }, { symbol: 'WETH' }], dynamicData: { totalLiquidity: '250000', aprItems: [{ apr: 0.04 }] } }] } },
        };
      },
    };
  };
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'balancer',
    exampleId: 'yield',
    message: 'Show the best Balancer pool for ETH yield on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  assert.equal(result?.status, 'answered');
  const request = seen as Parameters<BaseMcpSkillExecutor['request']>[0] | null;
  assert.ok(request);
  assert.equal(request.path, '/');
  assert.equal(request.method, 'POST');
  assert.match(JSON.stringify(request.body), /poolGetPools/);
  assert.match(result?.reply ?? '', /rETH \/ WETH/);
  assert.match(result?.reply ?? '', /did not run the Balancer SDK/);
});

test('Bitrefill browse reads the configured catalogue and never opens checkout', async () => {
  let searched: { query: string; country: string } | null = null;
  reviewedBaseMcpPluginRuntimeV1.resolveCommerceCatalogSource = () => ({
    id: 'bitrefill-fixture',
    async search(input) {
      searched = { query: input.query, country: input.country };
      return {
        ok: true,
        observation: {
          packages: [{
            product: {
              provider: 'bitrefill', productId: 'steam-usa', name: 'Steam US', kind: 'gift_card',
              country: 'US', currency: 'USD', packageValue: '20', packageId: 'steam-usa<&>20', recipientRequired: false,
            },
            fiatAmountDecimal: '20',
            fees: { productPriceAtomic: '20000000', providerFeeAtomic: null, networkFeeAtomic: null, totalAtomic: '20000000', totalBasis: 'minimum' },
            availability: 'in_stock',
          }],
          observedAt: '2026-08-21T12:00:00.000Z', expiresAt: '2026-08-21T12:02:00.000Z',
          endpoint: '/v2/products/steam-usa', requestHash: '0x01', responseHash: '0x02',
          providerId: 'bitrefill', providerDisplayName: 'Bitrefill',
        },
      };
    },
  });
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'bitrefill',
    exampleId: 'search',
    message: 'Find a 20 USD Steam US gift card on Bitrefill',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  assert.deepEqual(searched, { query: 'Steam', country: 'US' });
  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /20 USD/);
  assert.match(result?.reply ?? '', /No invoice was created and no payment was requested/);
});

test('a provider with no released reviewed recipe falls through to the read-only console', async () => {
  assert.equal(await runReviewedBaseMcpPluginReadV1({
    providerId: 'morpho',
    exampleId: 'markets',
    message: 'Show Morpho markets',
    walletAddress: '0x1111111111111111111111111111111111111111',
  }), null);
});

test('Virtuals agent list uses the encrypted authenticated session and never exposes its token', async () => {
  const sessions = new InMemoryBaseMcpPluginSessionStoreV1();
  reviewedBaseMcpPluginRuntimeV1.sessions = sessions;
  await sessions.save({
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
    session: {
      stage: 'authenticated',
      walletAddress: '0x1111111111111111111111111111111111111111',
      token: 'jwt-secret',
      refreshToken: 'refresh-secret',
      expiresAt: '2099-08-20T23:00:00.000Z',
    },
  });
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async (input) => {
    assert.equal(input.method, 'agent_list');
    assert.equal(input.args.token, 'jwt-secret');
    return { ok: true, data: { agents: [{ id: 'agent-1', name: 'Mio Researcher', token: 'provider-leak' }] } };
  };

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'virtuals',
    exampleId: 'agents',
    message: 'List my Virtuals agents',
    walletAddress: '0x1111111111111111111111111111111111111111',
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
  });

  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /Mio Researcher/);
  assert.doesNotMatch(JSON.stringify(result), /jwt-secret|refresh-secret|provider-leak/);
  assert.match(JSON.stringify(result), /\[redacted\]/);
});

test('Virtuals list without a reviewed sign-in explains the boundary and makes no provider call', async () => {
  reviewedBaseMcpPluginRuntimeV1.sessions = new InMemoryBaseMcpPluginSessionStoreV1();
  let called = false;
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async () => {
    called = true;
    return { ok: false, errorCode: 'unexpected' };
  };
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'virtuals',
    exampleId: 'agents',
    message: 'List my Virtuals agents',
    walletAddress: '0x1111111111111111111111111111111111111111',
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
  });
  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /Approve Sign-In/);
  assert.equal(called, false);
});
