import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssetRefV1 } from '@mioagent/route-domain';
import type { SwapAdapterResult, SwapRouteAdapter } from '@mioagent/swap-adapters';

import { giftValuationIntentV1, valueStockInUsdcV1 } from './giftSendValuation.js';

// ---------------------------------------------------------------------------
// A gift from holdings is valued as what it would fetch in USDC now: a sell
// quote from each router, the better one kept, and nothing when nobody quotes.
// ---------------------------------------------------------------------------

const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70' as const;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = new Date('2026-09-24T12:00:00.000Z');
const NVDA: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

function quoted(provider: string, usdcAtomic: string, outputAddress = USDC): SwapAdapterResult {
  return {
    outcome: 'quoted',
    candidate: {
      provider: { id: provider },
      quoteObservedAt: NOW.toISOString(),
      expectedOutput: { asset: { address: outputAddress }, amountAtomic: usdcAtomic },
    },
    evidence: [],
  } as never;
}

function adapter(id: string, answer: () => Promise<SwapAdapterResult>, asked: string[] = []): SwapRouteAdapter {
  return {
    id: id as never,
    supports: () => true,
    quote: async (input) => {
      asked.push(`${id}:${input.intent.fromAsset?.address}->${input.intent.toAsset?.address}:${input.intent.amount.amountAtomic}`);
      return answer();
    },
  };
}

test('the question is a sell of exactly this amount into canonical USDC, and never an execution', () => {
  const intent = giftValuationIntentV1({ token: NVDA, amountAtomic: '44227', walletAddress: WALLET, now: NOW });
  assert.equal(intent.goal, 'swap');
  assert.equal(intent.fromAsset?.address, NVDA.address);
  assert.equal(intent.toAsset?.address, USDC);
  assert.equal(intent.amount.amountAtomic, '44227');
  assert.equal(intent.amount.amountDecimal, '0.00044227');
  assert.equal(intent.executionRequested, false);
});

test('the better of the two routers is kept, with who said it', async () => {
  const asked: string[] = [];
  const value = await valueStockInUsdcV1({ token: NVDA, amountAtomic: '44227', walletAddress: WALLET, now: NOW }, [
    adapter('uniswap', async () => quoted('uniswap', '98000'), asked),
    adapter('kyberswap', async () => quoted('kyberswap', '98400'), asked),
  ]);
  assert.deepEqual(value, { usdcAtomic: '98400', provider: 'kyberswap', observedAt: NOW.toISOString() });
  assert.deepEqual(asked.sort(), [
    `kyberswap:${NVDA.address}->${USDC}:44227`,
    `uniswap:${NVDA.address}->${USDC}:44227`,
  ]);
});

test('a failure, a throw or an answer in something other than USDC is no value', async () => {
  const value = await valueStockInUsdcV1({ token: NVDA, amountAtomic: '44227', walletAddress: WALLET, now: NOW }, [
    adapter('uniswap', async () => ({ outcome: 'unavailable', provider: 'uniswap', errorCode: 'no_route', retryable: false })),
    adapter('kyberswap', async () => {
      throw new Error('socket hang up');
    }),
    adapter('o1-exchange', async () => quoted('o1-exchange', '99999999', '0x4200000000000000000000000000000000000006')),
  ]);
  assert.equal(value, null);

  const one = await valueStockInUsdcV1({ token: NVDA, amountAtomic: '44227', walletAddress: WALLET, now: NOW }, [
    adapter('uniswap', async () => ({ outcome: 'rate_limited', provider: 'uniswap', errorCode: '429', retryable: true })),
    adapter('kyberswap', async () => quoted('kyberswap', '98400')),
  ]);
  assert.equal(one?.provider, 'kyberswap');
});
