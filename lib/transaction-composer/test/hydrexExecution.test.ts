import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem';
import {
  HYDREX_BASE_ROUTER_PROXY_V1,
  HYDREX_EXECUTE_SWAPS_ABI_V1,
  HYDREX_KYBER_META_ROUTER_V1,
  HYDREX_ZEROX_ALLOWANCE_HOLDER_V1,
  HydrexSwapRouteAdapter,
  type HydrexRouterPinReaderV1,
} from '@mioagent/swap-adapters';
import { HydrexSwapBuildAdapter } from '../src/adapters/hydrex.js';
import { NOW, USDC_BASE, WALLET, WETH_BASE, makeIntent } from './fixtures.js';

const USDC = USDC_BASE.address as `0x${string}`;
const WETH = WETH_BASE.address as `0x${string}`;
const AMOUNT_IN = 100_000_000n;
const EXPECTED_OUT = 38_000_000_000_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000) + 600);

const pin: HydrexRouterPinReaderV1 = {
  async verify() { return { ok: true, blockNumber: '49890160', feeBps: '10' }; },
  async verifyUpstream(router) {
    const normalized = router.toLowerCase();
    return (normalized === HYDREX_KYBER_META_ROUTER_V1 || normalized === HYDREX_ZEROX_ALLOWANCE_HOLDER_V1)
      ? { ok: true, blockNumber: '49890160', feeBps: '10' }
      : { ok: false, reason: 'mismatch' };
  },
  async verifyAll() { return { ok: true, blockNumber: '49890160', feeBps: '10' }; },
};

function swapData(upstream: `0x${string}` = HYDREX_KYBER_META_ROUTER_V1): Hex {
  return encodeFunctionData({
    abi: HYDREX_EXECUTE_SWAPS_ABI_V1,
    functionName: 'executeSwaps',
    args: [[{
      router: upstream,
      inputAsset: USDC,
      outputAsset: WETH,
      inputAmount: AMOUNT_IN,
      minOutputAmount: MINIMUM_OUT,
      callData: upstream === HYDREX_KYBER_META_ROUTER_V1 ? '0xe21fd0e90000' : '0x2213bc0b0000',
      recipient: WALLET,
      origin: 'hydrex',
      referral: '0x0000000000000000000000000000000000000000',
      referralFeeBps: 0n,
    }], DEADLINE],
  });
}

function quotePayload(upstream: `0x${string}` = HYDREX_KYBER_META_ROUTER_V1) {
  return {
    ok: true,
    data: {
      amountIn: AMOUNT_IN.toString(), amountOut: EXPECTED_OUT.toString(),
      minOutputAmount: MINIMUM_OUT.toString(), recipient: WALLET,
      transaction: { to: HYDREX_BASE_ROUTER_PROXY_V1, data: swapData(upstream), value: '0' },
    },
  };
}

function preparePayload(upstream: `0x${string}` = HYDREX_KYBER_META_ROUTER_V1, approval = AMOUNT_IN) {
  return {
    ok: true,
    quote: { tokenIn: USDC, tokenOut: WETH, amountIn: AMOUNT_IN.toString(), amountOut: EXPECTED_OUT.toString() },
    approval: { required: true, token: USDC, spender: HYDREX_BASE_ROUTER_PROXY_V1, amount: AMOUNT_IN.toString() },
    transactions: [
      { step: 'approve-tokenIn', to: USDC, value: '0x0', chainId: 8453,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [HYDREX_BASE_ROUTER_PROXY_V1, approval] }) },
      { step: 'swap', to: HYDREX_BASE_ROUTER_PROXY_V1, value: '0x0', chainId: 8453, data: swapData(upstream) },
    ],
  };
}

function fetchJson(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
}

async function candidate() {
  const intent = makeIntent({ toAsset: WETH_BASE });
  const result = await new HydrexSwapRouteAdapter({ pinReader: pin, fetchImpl: fetchJson(quotePayload()) })
    .quote({ intent, walletAddress: WALLET, requestId: 'hydrex-quote', now: NOW });
  assert.equal(result.outcome, 'quoted');
  if (result.outcome !== 'quoted') throw new Error('fixture quote failed');
  return { intent, candidate: result.candidate };
}

describe('Hydrex build adapter', () => {
  test('rebuilds an exact approval and retains the pinned selected upstream', async () => {
    const fixture = await candidate();
    const result = await new HydrexSwapBuildAdapter({ pinReader: pin, fetchImpl: fetchJson(preparePayload()) }).build({
      intent: fixture.intent, selectedCandidate: fixture.candidate, reviewedCandidate: fixture.candidate,
      walletAddress: WALLET, requestId: 'hydrex-build', now: NOW,
    });
    assert.equal(result.outcome, 'built');
    if (result.outcome !== 'built') return;
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[1]?.to, HYDREX_BASE_ROUTER_PROXY_V1);
    const approval = decodeFunctionData({ abi: erc20Abi, data: result.calls[0]!.data });
    assert.equal(approval.functionName, 'approve');
    if (approval.functionName === 'approve') {
      assert.equal(approval.args[0].toLowerCase(), HYDREX_BASE_ROUTER_PROXY_V1);
      assert.equal(approval.args[1], AMOUNT_IN);
    }
    assert.equal(result.hydrex?.contractPinVerified, true);
    assert.equal(result.hydrex?.upstreamSource, 'KYBERSWAP');
  });

  test('rejects provider unlimited approval rather than trusting or forwarding it', async () => {
    const fixture = await candidate();
    const result = await new HydrexSwapBuildAdapter({
      pinReader: pin, fetchImpl: fetchJson(preparePayload(HYDREX_KYBER_META_ROUTER_V1, maxUint256)),
    }).build({
      intent: fixture.intent, selectedCandidate: fixture.candidate, walletAddress: WALLET,
      requestId: 'hydrex-unlimited', now: NOW,
    });
    assert.equal(result.outcome, 'invalid_response');
    assert.equal(result.errorCode, 'hydrex_provider_approval_invalid');
  });

  test('requires a fresh comparison when prepare switches from Kyber to 0x', async () => {
    const fixture = await candidate();
    const result = await new HydrexSwapBuildAdapter({
      pinReader: pin, fetchImpl: fetchJson(preparePayload(HYDREX_ZEROX_ALLOWANCE_HOLDER_V1)),
    }).build({
      intent: fixture.intent, selectedCandidate: fixture.candidate, walletAddress: WALLET,
      requestId: 'hydrex-route-changed', now: NOW,
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.errorCode, 'hydrex_route_changed');
  });
});
