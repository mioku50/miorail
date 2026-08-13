import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeFunctionData, type Hex } from 'viem';
import {
  HYDREX_BASE_ROUTER_PROXY_V1,
  HYDREX_EXECUTE_SWAPS_ABI_V1,
  HYDREX_KYBER_META_ROUTER_V1,
  HYDREX_QUOTE_PATH_V1,
  HydrexSwapRouteAdapter,
  parseHydrexQuoteV1,
  type HydrexQuoteRequestV1,
  type HydrexRouterPinReaderV1,
} from '../src/index.js';
import { makeIntent, NOW, WALLET } from './fixtures.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const OTHER = '0x4444444444444444444444444444444444444444' as const;
const AMOUNT_IN = 100_000_000n;
const EXPECTED_OUT = 38_000_000_000_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000) + 600);

function calldata(overrides: Partial<{
  router: `0x${string}`;
  outputAsset: `0x${string}`;
  amountIn: bigint;
  minimumOut: bigint;
  recipient: `0x${string}`;
  referral: `0x${string}`;
  referralFeeBps: bigint;
  deadline: bigint;
  innerData: Hex;
}> = {}): Hex {
  return encodeFunctionData({
    abi: HYDREX_EXECUTE_SWAPS_ABI_V1,
    functionName: 'executeSwaps',
    args: [[{
      router: overrides.router ?? HYDREX_KYBER_META_ROUTER_V1,
      inputAsset: USDC,
      outputAsset: overrides.outputAsset ?? WETH,
      inputAmount: overrides.amountIn ?? AMOUNT_IN,
      minOutputAmount: overrides.minimumOut ?? MINIMUM_OUT,
      callData: overrides.innerData ?? '0xe21fd0e90000',
      recipient: overrides.recipient ?? WALLET,
      origin: 'hydrex',
      referral: overrides.referral ?? '0x0000000000000000000000000000000000000000',
      referralFeeBps: overrides.referralFeeBps ?? 0n,
    }], overrides.deadline ?? DEADLINE],
  });
}

const request: HydrexQuoteRequestV1 = {
  tokenIn: USDC,
  tokenOut: WETH,
  amount: AMOUNT_IN.toString(),
  recipient: WALLET,
  slippage: 50,
};

function response(data: Hex = calldata(), overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      amountIn: AMOUNT_IN.toString(),
      amountOut: EXPECTED_OUT.toString(),
      minOutputAmount: MINIMUM_OUT.toString(),
      recipient: WALLET,
      transaction: { to: HYDREX_BASE_ROUTER_PROXY_V1, data, value: '0' },
      ...overrides,
    },
  };
}

const pin: HydrexRouterPinReaderV1 = {
  async verify() { return { ok: true, blockNumber: '49890160', feeBps: '10' }; },
  async verifyUpstream(router) {
    return router.toLowerCase() === HYDREX_KYBER_META_ROUTER_V1
      ? { ok: true, blockNumber: '49890160', feeBps: '10' }
      : { ok: false, reason: 'mismatch' };
  },
  async verifyAll() { return { ok: true, blockNumber: '49890160', feeBps: '10' }; },
};

function parse(payload: unknown) {
  const intent = makeIntent({ from: 'USDC', to: 'WETH', amount: '100' });
  return parseHydrexQuoteV1({
    payload, request, inputAsset: intent.fromAsset!, outputAsset: intent.toAsset!, now: NOW,
  });
}

describe('Hydrex quote parser', () => {
  test('decodes exact economic bounds and preserves upstream provenance', () => {
    const result = parse(response());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.amountInAtomic, AMOUNT_IN.toString());
    assert.equal(result.value.minimumOutputAtomic, MINIMUM_OUT.toString());
    assert.equal(result.value.upstreamRouter, HYDREX_KYBER_META_ROUTER_V1);
    assert.equal(result.value.upstreamSource, 'KYBERSWAP');
    assert.equal(result.value.liquiditySources[0]?.upstreamProvider, 'kyberswap');
    assert.ok(!JSON.stringify(result.value.safeResponse).includes(result.value.swapCall.data));
  });

  test('rejects changed target, recipient, asset, input, minimum and referral', () => {
    assert.equal(parse(response(calldata(), { transaction: { to: OTHER, data: calldata(), value: '0' } })).ok, false);
    assert.equal(parse(response(calldata({ recipient: OTHER }))).ok, false);
    assert.equal(parse(response(calldata({ outputAsset: OTHER }))).ok, false);
    assert.equal(parse(response(calldata({ amountIn: AMOUNT_IN + 1n }))).ok, false);
    assert.equal(parse(response(calldata({ minimumOut: MINIMUM_OUT - 1n }))).ok, false);
    assert.equal(parse(response(calldata({ referral: OTHER }))).ok, false);
    assert.equal(parse(response(calldata({ referralFeeBps: 1n }))).ok, false);
    assert.equal(parse(response(calldata({ innerData: '0x123456780000' }))).ok, false);
    assert.equal(parse(response(calldata({ minimumOut: MINIMUM_OUT - 1n }), {
      minOutputAmount: (MINIMUM_OUT - 1n).toString(),
    })).ok, false);
  });

  test('rejects unknown upstream and expired or excessively long deadlines', () => {
    assert.deepEqual(parse(response(calldata({ router: OTHER }))), {
      ok: false, errorCode: 'hydrex_upstream_router_not_allowlisted',
    });
    assert.equal(parse(response(calldata({ deadline: BigInt(Math.floor(NOW.getTime() / 1000) - 1) }))).ok, false);
    assert.equal(parse(response(calldata({ deadline: BigInt(Math.floor(NOW.getTime() / 1000) + 3600) }))).ok, false);
  });
});

describe('Hydrex quote adapter', () => {
  test('uses only the pinned GET path and leaves missing gas and price impact unscored', async () => {
    let observed = '';
    const adapter = new HydrexSwapRouteAdapter({
      pinReader: pin,
      fetchImpl: (async (url: string | URL | Request) => {
        observed = String(url);
        return new Response(JSON.stringify(response()), { status: 200 });
      }) as typeof fetch,
    });
    const intent = makeIntent({ from: 'USDC', to: 'WETH', amount: '100' });
    const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'hydrex-quote', now: NOW });
    assert.equal(result.outcome, 'quoted');
    if (result.outcome !== 'quoted') return;
    assert.equal(new URL(observed).origin, 'https://hydrex-agent.com');
    assert.equal(new URL(observed).pathname, HYDREX_QUOTE_PATH_V1);
    assert.equal(result.candidate.provider.id, 'hydrex');
    assert.equal(result.candidate.priceImpact, null);
    assert.equal(result.candidate.estimatedGas.gasUnits, '0');
    assert.equal(result.candidate.estimatedGas.estimatedCostUsd, null);
    assert.equal(result.candidate.trustMetadata.sourceIndependence, 'overlapping');
    assert.ok(result.candidate.trustMetadata.riskFlags.includes('price_impact_unmeasured'));
  });

  test('does not accept an upstream that fails the independent code pin', async () => {
    const adapter = new HydrexSwapRouteAdapter({
      pinReader: { ...pin, async verifyUpstream() { return { ok: false, reason: 'mismatch' }; } },
      fetchImpl: (async () => new Response(JSON.stringify(response()), { status: 200 })) as typeof fetch,
    });
    const intent = makeIntent({ from: 'USDC', to: 'WETH', amount: '100' });
    const result = await adapter.quote({ intent, walletAddress: WALLET, requestId: 'pin-mismatch', now: NOW });
    assert.equal(result.outcome, 'rejected');
    assert.equal('errorCode' in result ? result.errorCode : null, 'provider_router_mismatch');
  });
});
