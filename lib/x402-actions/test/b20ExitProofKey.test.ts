import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { deterministicB20ExitProofKeyV1 } from '../src/useB20ExitProofPayment.js';

const WALLET = '0x1111111111111111111111111111111111112222';
const TOKEN = '0xb200000000000000000000294511530ba9d34201';
const BASE = { tokenAddress: TOKEN, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 };

describe('what makes two paid exit proofs the same request', () => {
  test('the same question, retried, is one charge', () => {
    // A re-click or a remount before the request settles must send the same
    // key. This is the whole defence against paying twice for one answer.
    assert.equal(
      deterministicB20ExitProofKeyV1(BASE, WALLET),
      deterministicB20ExitProofKeyV1({ ...BASE }, WALLET.toUpperCase()),
    );
  });

  test('every field of the profile changes it', () => {
    // A proof for 100 USDC says nothing about 500. If the size were absent
    // from the key, an expensive question could be answered from a cheap
    // one's receipt — the user would be shown a proof they never bought.
    const keys = new Set([
      deterministicB20ExitProofKeyV1(BASE, WALLET),
      deterministicB20ExitProofKeyV1({ ...BASE, positionAtomic: '500000000' }, WALLET),
      deterministicB20ExitProofKeyV1({ ...BASE, maxRoundTripBps: 100 }, WALLET),
      deterministicB20ExitProofKeyV1({ ...BASE, maxExitSlippageBps: 100 }, WALLET),
      deterministicB20ExitProofKeyV1({ ...BASE, tokenAddress: `0x${'ab'.repeat(20)}` }, WALLET),
    ]);
    assert.equal(keys.size, 5, 'two different questions share a key');
  });

  test('a different wallet is a different request', () => {
    assert.notEqual(
      deterministicB20ExitProofKeyV1(BASE, WALLET),
      deterministicB20ExitProofKeyV1(BASE, `0x${'cd'.repeat(20)}`),
    );
  });

  test('the key carries no 0x prefixes that could be read as calldata', () => {
    const key = deterministicB20ExitProofKeyV1(BASE, WALLET);
    assert.ok(!key.includes('0x'), key);
    assert.match(key, /^b20exit-/);
  });
});
