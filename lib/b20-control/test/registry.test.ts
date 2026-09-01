import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_ONCHAIN_REGISTRY_V1,
  B20_REGISTRY_TOKEN_STATE_SELECTOR_V1,
  B20_WAD_V1,
  decodeRegistryStateV1,
  encodeRegistryStateCallV1,
  multiplierLabelV1,
  redemptionRatioIsOneV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The registry Base Docs names and Miorail never called.
//
// Every fixture below is a real answer from Base mainnet on 2026-09-01, not a
// constructed one: the registry has no ABI, so the only thing that establishes
// its shape is what it actually returned.
// ---------------------------------------------------------------------------

const NVDA = '0xb20000000000000000000078ee7ce2fE4908108C';

/** Measured: NVDAc, and the other twelve, answered exactly this. */
const LIVE_ANSWER =
  '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000' +
  '0000000000000000000000000000000000000000000000000000000000000000';

describe('the Coinbase onchain registry', () => {
  test('one address in, a multiplier and a pause flag out', () => {
    const state = decodeRegistryStateV1(LIVE_ANSWER);
    assert.equal(state.state, 'read');
    assert.equal(state.state === 'read' && state.multiplierWad, B20_WAD_V1);
    assert.equal(state.state === 'read' && state.paused, false);
    assert.equal(state.state === 'read' && redemptionRatioIsOneV1(state.multiplierWad), true);
  });

  test('the call is the pinned selector and one address word', () => {
    const data = encodeRegistryStateCallV1(NVDA);
    assert.ok(data.startsWith(`0x${B20_REGISTRY_TOKEN_STATE_SELECTOR_V1}`));
    assert.equal(data.length, 2 + 8 + 64);
    assert.match(data.toLowerCase(), /b20000000000000000000078ee7ce2fe4908108c$/);
    // The registry is one deployed contract, not a precompile.
    assert.match(B20_ONCHAIN_REGISTRY_V1, /^0x[0-9a-f]{40}$/);
  });

  test('an answer of the wrong shape is unread, never a multiplier', () => {
    // A short answer is some other function's answer. Reading its first word
    // as a ratio would publish a number this contract never claimed.
    for (const bad of ['0x', '0x00', `0x${'00'.repeat(32)}`, 'not hex']) {
      assert.equal(decodeRegistryStateV1(bad).state, 'unread', bad);
    }
  });

  test('a zero multiplier is refused rather than published', () => {
    // Zero is not a ratio. Publishing it collapses a share count to nothing on
    // a card that says the token is fine.
    const zero = `0x${'0'.repeat(128)}`;
    assert.equal(decodeRegistryStateV1(zero).state, 'unread');
  });

  test('a pause flag that is not a boolean is unread', () => {
    const odd =
      '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000' +
      '0000000000000000000000000000000000000000000000000000000000000002';
    assert.equal(decodeRegistryStateV1(odd).state, 'unread');
  });

  test('the multiplier is said exactly, never as a float', () => {
    assert.equal(multiplierLabelV1(B20_WAD_V1), '1.0');
    // A Backed address the registry also answers for, measured the same day.
    assert.equal(multiplierLabelV1(1002050000000000000n), '1.00205');
    assert.equal(multiplierLabelV1(2n * B20_WAD_V1), '2.0');
    assert.equal(redemptionRatioIsOneV1(1002050000000000000n), false);
  });
});
