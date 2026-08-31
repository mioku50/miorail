import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BALANCER_V3_ROUTER_BASE_V1,
  BalancerClientV1,
  BalancerSwapRouteAdapter,
} from '../src/index.js';
import { makeIntent, NOW, responseFetch, WALLET, withProtocolConstraint } from './fixtures.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const POOL = '0x7b4c560f33a71a9f7a500af3c4c65b46fbbafdb7';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      sorGetSwapPaths: {
        returnAmount: '0.0529',
        priceImpact: { priceImpact: null, error: 'Price impact unavailable for this valid path' },
        paths: [{
          protocolVersion: 3,
          pools: [POOL],
          isBuffer: [false],
          inputAmountRaw: '100000000',
          outputAmountRaw: '52900000000000000',
          tokens: [
            { address: USDC, decimals: 6 },
            { address: WETH, decimals: 18 },
          ],
        }],
        ...overrides,
      },
    },
  };
}

test('Balancer client validates exact input paths and returns deterministic provenance inputs', async () => {
  const client = new BalancerClientV1({ fetchImpl: responseFetch(payload()) });
  const result = await client.quoteExactIn({
    tokenIn: USDC, tokenOut: WETH, amountHuman: '100', amountAtomic: '100000000',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.quote.protocolVersion, 3);
  assert.equal(result.quote.expectedOutputAtomic, '52900000000000000');
});

test('Balancer adapter creates a V3 candidate with two approvals and no invented impact', async () => {
  const intent = withProtocolConstraint(makeIntent({ to: 'WETH' }), {
    mode: 'include_only', protocols: ['balancer'],
  });
  const adapter = new BalancerSwapRouteAdapter({ fetchImpl: responseFetch(payload()) });
  const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'balancer-quote', now: NOW });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') return;
  assert.equal(result.candidate.provider.id, 'balancer');
  assert.equal(result.candidate.callCount, 3);
  assert.equal(result.candidate.approvalCount, 2);
  assert.equal(result.candidate.priceImpact, null);
  assert.equal(result.candidate.liquiditySources[0]?.poolAddress, POOL);
  assert.match(result.candidate.liquiditySources[0]?.sourceKey ?? '', /^balancer:v3:/);
});

test('Balancer rejects a response whose path total differs from the intent amount', async () => {
  const broken = payload({
    paths: [{
      protocolVersion: 3, pools: [POOL], isBuffer: [false],
      inputAmountRaw: '999', outputAmountRaw: '1',
      tokens: [{ address: USDC, decimals: 6 }, { address: WETH, decimals: 18 }],
    }],
  });
  const result = await new BalancerClientV1({ fetchImpl: responseFetch(broken) }).quoteExactIn({
    tokenIn: USDC, tokenOut: WETH, amountHuman: '100', amountAtomic: '100000000',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_route' });
});

test('Balancer pinned Base router constant matches the official SDK deployment', () => {
  assert.equal(BALANCER_V3_ROUTER_BASE_V1, '0x3f170631ed9821ca51a59d996ab095162438dc10');
});

test('an empty path set is the market answering, not a malformed reply', async () => {
  // Measured against the live API on 2026-08-31 for USDC -> NVDAc: Balancer
  // answers 200 with this exact body. The schema used to require `paths.min(1)`,
  // so the parse failed and a clean "no route" was filed as `invalid_response` —
  // Balancer accused of sending us something broken for correctly reporting
  // that it has no pool. That is how it failed 44 of 44 attempts across the
  // reviewed stock corpus while quoting USDC -> WETH perfectly.
  const client = new BalancerClientV1({
    fetchImpl: responseFetch({
      data: {
        sorGetSwapPaths: {
          returnAmount: '0',
          priceImpact: { priceImpact: null, error: 'No swaps found' },
          paths: [],
        },
      },
    }),
  });
  const result = await client.quoteExactIn({
    tokenIn: USDC,
    tokenOut: '0xb20000000000000000000078ee7ce2fe4908108c',
    amountHuman: '100',
    amountAtomic: '100000000',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_route' });
});

test('a genuinely malformed reply is still ours to report, not the market’s', async () => {
  // The distinction the fix above must not erase: a path set that contradicts
  // itself is not a finding about liquidity.
  const client = new BalancerClientV1({
    fetchImpl: responseFetch(payload({ paths: [{ notAPath: true }] })),
  });
  const result = await client.quoteExactIn({
    tokenIn: USDC, tokenOut: WETH, amountHuman: '100', amountAtomic: '100000000',
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_response' });
});
