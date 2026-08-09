import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR_V1,
  V4QuoteUnavailableError,
  decodeV4QuoteResultV1,
  encodeV4QuoteExactInputSingleV1,
  quoteV4ExactInputV1,
} from '../src/uniswap-v4-quoter.js';
import { UNISWAP_V4_QUOTER_V1 } from '../src/uniswap-v4-pinned.js';
import type { UniswapV4PoolKeyV1 } from '../src/uniswap-v4-pool.js';

// The PDRSTR pool, read off Base mainnet 2026-08-09.
const KEY: UniswapV4PoolKeyV1 = {
  currency0: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  currency1: '0xb200000000000000000000294511530ba9d34201',
  fee: 0,
  tickSpacing: 200,
  hooks: '0x985c14baa2a18316ffda0aefb3a632fadfca2acc',
};

const words = (data: string): string[] =>
  (data.slice(10).match(/.{64}/g) ?? []);

describe('the quote calldata is laid out the way the ABI reads it', () => {
  test('the selector is computed, not copied', () => {
    // Four bytes of hex, and stable — a wrong selector calls a different
    // function and is invisible by inspection.
    assert.match(V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR_V1, /^[0-9a-f]{8}$/);
  });

  test('a dynamic tuple argument is passed by offset, then its body', () => {
    const data = encodeV4QuoteExactInputSingleV1({ key: KEY, zeroForOne: true, exactAmountAtomic: 1_000_000n });
    const w = words(data);
    // head: offset 0x20 to the tuple; then PoolKey's five inlined words.
    assert.equal(BigInt(`0x${w[0]}`), 32n);
    assert.equal(`0x${w[1]!.slice(24)}`, KEY.currency0);
    assert.equal(`0x${w[2]!.slice(24)}`, KEY.currency1);
    assert.equal(BigInt(`0x${w[3]}`), 0n, 'fee');
    assert.equal(BigInt(`0x${w[4]}`), 200n, 'tickSpacing');
    assert.equal(`0x${w[5]!.slice(24)}`, KEY.hooks);
    assert.equal(BigInt(`0x${w[6]}`), 1n, 'zeroForOne');
    assert.equal(BigInt(`0x${w[7]}`), 1_000_000n, 'exactAmount');
    // hookData: offset past the eight preceding words, then a zero length.
    assert.equal(BigInt(`0x${w[8]}`), 256n);
    assert.equal(BigInt(`0x${w[9]}`), 0n);
    assert.equal(w.length, 10, 'nothing trails an empty bytes field');
  });

  test('the direction is carried, so exit is the same call reversed', () => {
    const out = words(encodeV4QuoteExactInputSingleV1({ key: KEY, zeroForOne: false, exactAmountAtomic: 5n }));
    assert.equal(BigInt(`0x${out[6]}`), 0n);
  });

  test('a negative tickSpacing encodes as two’s complement', () => {
    const data = encodeV4QuoteExactInputSingleV1({
      key: { ...KEY, tickSpacing: -60 },
      zeroForOne: true,
      exactAmountAtomic: 1n,
    });
    assert.match(words(data)[4]!, /^f{62}c4$/);
  });

  test('an impossible amount is refused rather than silently truncated', () => {
    assert.throws(
      () => encodeV4QuoteExactInputSingleV1({ key: KEY, zeroForOne: true, exactAmountAtomic: -1n }),
      RangeError,
    );
  });
});

describe('a revert is a liquidity answer, not a price', () => {
  test('a real pair of words decodes to an amount and a gas estimate', () => {
    const data = `0x${(12345n).toString(16).padStart(64, '0')}${(210000n).toString(16).padStart(64, '0')}`;
    assert.deepEqual(decodeV4QuoteResultV1(data), {
      ok: true,
      amountOutAtomic: '12345',
      gasEstimate: '210000',
    });
  });

  test('empty return data — the shape of a revert — is refused, never read as zero', () => {
    // The Quoter reverts to return, so a pool with no liquidity at this size
    // comes back empty. Reporting that as a zero price would put a made-up
    // number on a card.
    assert.deepEqual(decodeV4QuoteResultV1('0x'), { ok: false, refusal: 'empty_result' });
    assert.deepEqual(decodeV4QuoteResultV1(undefined), { ok: false, refusal: 'empty_result' });
  });

  test('a zero output is refused too', () => {
    const data = `0x${'0'.repeat(64)}${'0'.repeat(64)}`;
    assert.deepEqual(decodeV4QuoteResultV1(data), { ok: false, refusal: 'zero_output' });
  });

  test('a short or non-hex result is refused rather than partially read', () => {
    assert.deepEqual(decodeV4QuoteResultV1(`0x${'11'.repeat(20)}`), { ok: false, refusal: 'malformed_result' });
    assert.deepEqual(decodeV4QuoteResultV1(`0x${'zz'.repeat(64)}`), { ok: false, refusal: 'malformed_result' });
  });
});

describe('the call goes to the pinned Quoter and survives a throwing transport', () => {
  test('it calls the Base Quoter with the encoded quote', async () => {
    let seen: { to: string; data: string } | null = null;
    const result = await quoteV4ExactInputV1({
      key: KEY,
      zeroForOne: true,
      exactAmountAtomic: 1_000_000n,
      call: async (request) => {
        seen = request;
        return `0x${(999n).toString(16).padStart(64, '0')}${'0'.repeat(64)}`;
      },
    });
    assert.equal(seen!.to, UNISWAP_V4_QUOTER_V1);
    assert.ok(seen!.data.startsWith(`0x${V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR_V1}`));
    assert.deepEqual(result, { ok: true, amountOutAtomic: '999', gasEstimate: '0' });
  });

  test('a transport that throws on revert is still a refusal, not a crash', async () => {
    const result = await quoteV4ExactInputV1({
      key: KEY,
      zeroForOne: true,
      exactAmountAtomic: 1n,
      call: async () => { throw new Error('execution reverted'); },
    });
    assert.deepEqual(result, { ok: false, refusal: 'empty_result' });
  });

  test('a transport saying the ENDPOINT failed is kept apart from a revert', async () => {
    // Both arrive as an exception. Only one is a fact about the pool, and the
    // other must never reach a card that says "this token cannot be sold".
    const result = await quoteV4ExactInputV1({
      key: KEY,
      zeroForOne: false,
      exactAmountAtomic: 1n,
      call: async () => { throw new V4QuoteUnavailableError(); },
    });
    assert.deepEqual(result, { ok: false, refusal: 'endpoint_unavailable' });
  });
});
