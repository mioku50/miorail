import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  serializeTransaction,
  type Hex,
} from 'viem';
import {
  O1_BASE_ROUTER_PROXY_V1,
  O1_SWAP_ABI_V1,
  O1SwapRouteAdapter,
  type O1OrderRequestV1,
  type O1RouterPinReaderV1,
} from '@mioagent/swap-adapters';

import { O1SwapBuildAdapter } from '../src/adapters/o1.js';
import { NOW, USDC_BASE, WALLET, WETH_BASE, makeIntent } from './fixtures.js';

const USDC = USDC_BASE.address as `0x${string}`;
const WETH = WETH_BASE.address as `0x${string}`;
const POOL = '0x2222222222222222222222222222222222222222' as const;
const EXCHANGE = '0x3333333333333333333333333333333333333333' as const;
const AMOUNT_IN = 100_000_000n;
const MINIMUM_OUT = 37_810_000_000_000_000n;

const pin: O1RouterPinReaderV1 = {
  async verify() {
    return { ok: true, blockNumber: '49887887' };
  },
};

function raw(to: `0x${string}`, data: Hex, gas: bigint): Hex {
  return serializeTransaction({
    chainId: 8453,
    type: 'eip1559',
    nonce: 0,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    gas,
    to,
    value: 0n,
    data,
  });
}

function payload(request: O1OrderRequestV1, pool: `0x${string}` = POOL) {
  const swap = encodeFunctionData({
    abi: O1_SWAP_ABI_V1,
    functionName: 'swap',
    args: [
      [
        {
          dexType: 1,
          tokenIn: USDC,
          tokenOut: WETH,
          pool,
          fee: 500,
          tickSpacing: 10,
          exchange: EXCHANGE,
          extraData: '0x',
        },
      ],
      WETH,
      AMOUNT_IN,
      MINIMUM_OUT,
    ],
  });
  return {
    success: true,
    id: `order-${pool}`,
    order: request,
    transactions: [
      {
        id: 'approve',
        unsigned: raw(
          USDC,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [O1_BASE_ROUTER_PROXY_V1, maxUint256],
          }),
          100_000n,
        ),
      },
      { id: 'swap', unsigned: raw(O1_BASE_ROUTER_PROXY_V1, swap, 5_000_000n) },
    ],
  };
}

function fetchFor(pool: `0x${string}` = POOL): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as O1OrderRequestV1;
    return new Response(JSON.stringify(payload(request, pool)), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('o1 build adapter', () => {
  test('replaces provider unlimited approval with the exact reviewed amount', async () => {
    const intent = makeIntent({ toAsset: WETH_BASE });
    const quote = await new O1SwapRouteAdapter({
      sharedToken: 'fixture',
      pinReader: pin,
      fetchImpl: fetchFor(),
    }).quote({ intent, walletAddress: WALLET, requestId: 'quote-o1', now: NOW });
    assert.equal(quote.outcome, 'quoted');
    if (quote.outcome !== 'quoted') return;

    const result = await new O1SwapBuildAdapter({
      sharedToken: 'fixture',
      pinReader: pin,
      fetchImpl: fetchFor(),
    }).build({
      intent,
      selectedCandidate: quote.candidate,
      reviewedCandidate: quote.candidate,
      walletAddress: WALLET,
      requestId: 'build-o1',
      now: NOW,
    });
    assert.equal(result.outcome, 'built');
    if (result.outcome !== 'built') return;
    assert.equal(result.calls.length, 2);
    assert.equal(result.calls[0]!.to, USDC);
    assert.equal(result.calls[1]!.to, O1_BASE_ROUTER_PROXY_V1);
    const approval = decodeFunctionData({ abi: erc20Abi, data: result.calls[0]!.data });
    assert.equal(approval.functionName, 'approve');
    if (approval.functionName !== 'approve') return;
    assert.equal(approval.args[0].toLowerCase(), O1_BASE_ROUTER_PROXY_V1);
    assert.equal(approval.args[1], AMOUNT_IN);
    assert.equal(result.o1?.contractPinVerified, true);
  });

  test('forces a fresh review when the provider changes the pool', async () => {
    const intent = makeIntent({ toAsset: WETH_BASE });
    const quote = await new O1SwapRouteAdapter({
      sharedToken: 'fixture',
      pinReader: pin,
      fetchImpl: fetchFor(),
    }).quote({ intent, walletAddress: WALLET, requestId: 'quote-o1', now: NOW });
    assert.equal(quote.outcome, 'quoted');
    if (quote.outcome !== 'quoted') return;
    const changedPool = '0x5555555555555555555555555555555555555555' as const;
    const result = await new O1SwapBuildAdapter({
      sharedToken: 'fixture',
      pinReader: pin,
      fetchImpl: fetchFor(changedPool),
    }).build({
      intent,
      selectedCandidate: quote.candidate,
      reviewedCandidate: quote.candidate,
      walletAddress: WALLET,
      requestId: 'build-o1-changed',
      now: NOW,
    });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.errorCode, 'o1_route_changed');
  });
});
