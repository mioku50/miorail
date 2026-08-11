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

test('swap5792() converts the provider’s HEX value into base-unit decimal', async () => {
  // The last wall in the reported swap: the trade API sends `value: "0x00"`,
  // and everything downstream reads base-unit decimal. The blueprint schema
  // rejected it — `Expected unsigned base-unit integer string` at
  // calls.0.valueWei — AFTER the quote, the calldata and every safety check
  // had already passed, so the console showed an empty Review with no reason.
  const hexValue = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': {
        status: 200,
        payload: {
          from: WALLET,
          chainId: 8453,
          requestId: 'req-1',
          calls: [
            { to: '0x2222222222222222222222222222222222222222', value: '0x00', data: '0xabcdef' },
            { to: '0x2222222222222222222222222222222222222222', value: '0x0de0b6b3a7640000', data: '0xabcdef' },
          ],
        },
      },
    }),
  );
  const result = await hexValue.swap5792({}, WALLET);
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.calls?.[0]?.value, '0');
  // Exactly one ether, not rounded through a float.
  assert.equal(result.calls?.[1]?.value, '1000000000000000000');
});

test('swap5792() refuses a value it cannot read rather than defaulting it to zero', async () => {
  // `value` is native ETH the provider means to attach. Reading "later" or
  // "" as zero would quietly change the transaction, so an unreadable amount
  // is an invalid response — the same fail-closed rule as a malformed target.
  for (const value of ['later', '', '-1', '0x', {}, ['0']]) {
    const client = new UniswapTradeClient(
      transportOf({
        '/v1/swap_5792': {
          status: 200,
          payload: {
            from: WALLET,
            chainId: 8453,
            requestId: 'req-1',
            calls: [{ to: '0x2222222222222222222222222222222222222222', value, data: '0xabcdef' }],
          },
        },
      }),
    );
    assert.equal((await client.swap5792({}, WALLET)).outcome, 'invalid_response', `value ${JSON.stringify(value)}`);
  }

  // An absent field is the one honest zero: nothing was attached.
  const absent = new UniswapTradeClient(
    transportOf({
      '/v1/swap_5792': {
        status: 200,
        payload: {
          from: WALLET,
          chainId: 8453,
          requestId: 'req-1',
          calls: [{ to: '0x2222222222222222222222222222222222222222', data: '0xabcdef' }],
        },
      },
    }),
  );
  const result = await absent.swap5792({}, WALLET);
  assert.equal(result.outcome, 'prepared');
  assert.equal(result.calls?.[0]?.value, '0');
});
