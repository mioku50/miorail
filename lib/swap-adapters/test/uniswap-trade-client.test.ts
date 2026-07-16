import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UniswapTradeClient,
  type UniswapTradeTransport,
} from '../src/uniswap-trade-client.js';

const WALLET = '0x1111111111111111111111111111111111111111';

function transportOf(responses: Record<string, { status: number; payload: unknown }>): UniswapTradeTransport {
  return {
    async post(path) {
      const response = responses[path];
      if (!response) throw new Error(`unexpected path ${path}`);
      return response;
    },
  };
}

test('quote() accepts a CLASSIC routing response and rejects an invalid one', async () => {
  const client = new UniswapTradeClient(
    transportOf({ '/v1/quote': { status: 200, payload: { routing: 'CLASSIC', quote: { routing: 'CLASSIC' } } } }),
  );
  const result = await client.quote({});
  assert.equal(result.outcome, 'quote');
  assert.equal(result.routing, 'CLASSIC');

  const invalid = new UniswapTradeClient(
    transportOf({ '/v1/quote': { status: 200, payload: { routing: 'BOGUS', quote: {} } } }),
  );
  assert.equal((await invalid.quote({})).outcome, 'invalid_response');
});

test('quote() surfaces HTTP errors without throwing', async () => {
  const client = new UniswapTradeClient(transportOf({ '/v1/quote': { status: 500, payload: null } }));
  const result = await client.quote({});
  assert.equal(result.outcome, 'http_error');
  assert.equal(result.status, 500);
});

test('swap5792() validates from, chainId, requestId, and calls shape', async () => {
  const client = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': {
        status: 200,
        payload: {
          from: WALLET,
          chainId: 8453,
          requestId: 'req-1',
          calls: [{ to: '0x2222222222222222222222222222222222222222', value: '0', data: '0xabcdef' }],
        },
      },
    }),
  );
  const result = await client.swap5792({}, WALLET);
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.calls?.length, 1);
});

test('swap5792() rejects a wallet mismatch, wrong chain, or malformed call', async () => {
  const wrongWallet = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': {
        status: 200,
        payload: { from: '0x9999999999999999999999999999999999999999', chainId: 8453, requestId: 'req-1', calls: [] },
      },
    }),
  );
  assert.equal((await wrongWallet.swap5792({}, WALLET)).outcome, 'invalid_response');

  const wrongChain = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': { status: 200, payload: { from: WALLET, chainId: 1, requestId: 'req-1', calls: [] } },
    }),
  );
  assert.equal((await wrongChain.swap5792({}, WALLET)).outcome, 'invalid_response');

  const malformedCall = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': {
        status: 200,
        payload: { from: WALLET, chainId: 8453, requestId: 'req-1', calls: [{ to: 'not-an-address' }] },
      },
    }),
  );
  assert.equal((await malformedCall.swap5792({}, WALLET)).outcome, 'invalid_response');
});
