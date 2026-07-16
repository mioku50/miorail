import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteIntentV1 } from '@mioagent/route-domain';
import type { UniswapTradeTransport } from '@mioagent/swap-adapters';
import { UniswapSwapBuildAdapter } from '../src/adapters/uniswap.js';
import { NOW, WALLET, WETH_BASE, makeIntent } from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';

function transportOf(handlers: {
  quote?: (body: unknown) => { status: number; payload: unknown };
  swap?: (body: unknown) => { status: number; payload: unknown };
}): UniswapTradeTransport {
  return {
    async post(path, body) {
      if (path === '/v1/quote') {
        return (
          handlers.quote?.(body) ?? {
            status: 200,
            payload: {
              routing: 'CLASSIC',
              quote: { routing: 'CLASSIC', output: { amount: '38000000000000000' } },
            },
          }
        );
      }
      return (
        handlers.swap?.(body) ?? {
          status: 200,
          payload: {
            from: WALLET,
            chainId: 8453,
            requestId: 'swap-req-1',
            calls: [
              { to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: '0', data: '0x095ea7b3' },
              { to: ROUTER, value: '0', data: '0x12345678' },
            ],
          },
        }
      );
    },
  };
}

function buildInput(intent: RouteIntentV1, walletAddress: string = WALLET) {
  return {
    intent,
    selectedCandidate: null as never,
    walletAddress: walletAddress as `0x${string}`,
    now: NOW,
    requestId: 'req-1',
  };
}

test('Uniswap build adapter builds calls for USDC to ETH', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'built');
  if (result.outcome === 'built') {
    assert.equal(result.routerAddress, ROUTER);
    assert.equal(result.calls.length, 2);
    // Build-side outputs come from the quote object fed into /swap_5792.
    assert.equal(result.expectedOutput.amountAtomic, '38000000000000000');
    // 50 bps intent slippage bound: 38e15 * 9950 / 10000.
    assert.equal(result.minimumOutput.amountAtomic, '37810000000000000');
  }
});

test('Uniswap build adapter rejects a quote response without a usable output amount', async () => {
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({
      quote: () => ({ status: 200, payload: { routing: 'CLASSIC', quote: { routing: 'CLASSIC' } } }),
    }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'invalid_response');
});

test('Uniswap build adapter builds calls for USDC to WETH', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const result = await adapter.build(buildInput(makeIntent({ toAsset: WETH_BASE })));
  assert.equal(result.outcome, 'built');
});

test('Uniswap build adapter rejects a wallet mismatch', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const intent = makeIntent();
  const result = await adapter.build(buildInput(intent, '0x2222222222222222222222222222222222222222'));
  assert.equal(result.outcome, 'rejected');
});

test('Uniswap build adapter rejects an unsupported chain', async () => {
  const adapter = new UniswapSwapBuildAdapter({ transport: transportOf({}) });
  const intent = { ...makeIntent(), chainId: 84532 } as unknown as RouteIntentV1;
  const result = await adapter.build(buildInput(intent));
  assert.equal(result.outcome, 'rejected');
});

test('Uniswap build adapter surfaces a malformed swap_5792 response as invalid_response', async () => {
  const adapter = new UniswapSwapBuildAdapter({
    transport: transportOf({ swap: () => ({ status: 200, payload: { from: WALLET, chainId: 8453 } }) }),
  });
  const result = await adapter.build(buildInput(makeIntent()));
  assert.equal(result.outcome, 'invalid_response');
});

test('Uniswap build adapter is not_configured without an API key or transport override', async () => {
  const previous = process.env.UNISWAP_API_KEY;
  delete process.env.UNISWAP_API_KEY;
  try {
    const adapter = new UniswapSwapBuildAdapter();
    const result = await adapter.build(buildInput(makeIntent()));
    assert.equal(result.outcome, 'not_configured');
  } finally {
    if (previous !== undefined) process.env.UNISWAP_API_KEY = previous;
  }
});
