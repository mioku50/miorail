import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_STANDARD_LAUNCH_HOOK_V1,
  UNISWAP_V4_HOOK_FLAGS_V1,
  V4_NO_HOOK_V1,
  b20HookAssessmentV1,
  v4HookPermissionsV1,
} from '../src/poolHook.js';

// ---------------------------------------------------------------------------
// Both addresses were read off Base mainnet on 2026-08-10 from the `Initialize`
// logs of 50 real B20 launches, each filtered by that launch's own pool id.
// Not invented, and not taken from a doc.
//
//   0x985c14ba…2acc   48 of 50
//   0xf85f1f30…20cc    2 of 50
// ---------------------------------------------------------------------------

const RARE_HOOK = '0xf85f1f3082cfbc5e1149972309b25054e4d420cc';

describe('uniswap v4 hook permissions', () => {
  test('the flag table is the 14 bits v4 defines, each exactly once', () => {
    const bits = UNISWAP_V4_HOOK_FLAGS_V1.map((flag) => flag.bit);
    assert.equal(bits.length, 14);
    assert.deepEqual([...bits].sort((a, b) => a - b), [...Array(14).keys()]);
    assert.equal(new Set(UNISWAP_V4_HOOK_FLAGS_V1.map((f) => f.id)).size, 14);
  });

  test('the standard B20 launch hook decodes to the seven bits its address spells', () => {
    const decoded = v4HookPermissionsV1(B20_STANDARD_LAUNCH_HOOK_V1);
    assert.ok(decoded);
    assert.equal(decoded.permissionBits, 0x2acc);
    assert.deepEqual(decoded.flags, [
      'before_initialize',
      'before_add_liquidity',
      'before_remove_liquidity',
      'before_swap',
      'after_swap',
      'before_swap_returns_delta',
      'after_swap_returns_delta',
    ]);
    // The three claims a card would make about it.
    assert.equal(decoded.mayChangeSwapAmounts, true);
    assert.equal(decoded.mayInterceptSwaps, true);
    assert.equal(decoded.mayGateLiquidity, true);
  });

  test('the rare hook differs by exactly the liquidity gates', () => {
    const decoded = v4HookPermissionsV1(RARE_HOOK);
    assert.ok(decoded);
    assert.equal(decoded.permissionBits, 0x20cc);
    assert.equal(decoded.mayGateLiquidity, false);
    // But it can still move the amounts of every swap, which is the part that
    // decides what an exit costs. "Fewer permissions" is not "harmless".
    assert.equal(decoded.mayChangeSwapAmounts, true);
    assert.equal(decoded.mayInterceptSwaps, true);
  });

  test('case does not change a verdict', () => {
    const upper = v4HookPermissionsV1(B20_STANDARD_LAUNCH_HOOK_V1.toUpperCase().replace('0X', '0x'));
    assert.equal(upper?.permissionBits, 0x2acc);
    assert.equal(b20HookAssessmentV1(B20_STANDARD_LAUNCH_HOOK_V1.toUpperCase().replace('0X', '0x')).standing, 'standard');
  });

  test('the zero address is no hook, not a hook with no permissions', () => {
    const decoded = v4HookPermissionsV1(V4_NO_HOOK_V1);
    assert.ok(decoded);
    assert.equal(decoded.none, true);
    assert.deepEqual(decoded.flags, []);
    assert.equal(decoded.mayChangeSwapAmounts, false);
    assert.equal(b20HookAssessmentV1(V4_NO_HOOK_V1).standing, 'no_hook');
  });

  test('a hook whose address spells every bit claims every permission', () => {
    const all = `0x${'0'.repeat(36)}3fff`;
    const decoded = v4HookPermissionsV1(all);
    assert.equal(decoded?.permissionBits, 0x3fff);
    assert.equal(decoded?.flags.length, 14);
  });

  test('bits above 13 are address, not permission', () => {
    // Same low bits as the standard hook, different high bits: the permission
    // set must be identical, or the mask is wrong.
    const decoded = v4HookPermissionsV1(`0x${'f'.repeat(36)}2acc`);
    assert.equal(decoded?.permissionBits, 0x2acc);
  });

  test('a malformed hook is unreadable, never standard by default', () => {
    for (const bad of ['', '0x', 'not-an-address', '0x985c14ba', `0x${'0'.repeat(41)}`]) {
      assert.equal(v4HookPermissionsV1(bad), null, bad);
      assert.equal(b20HookAssessmentV1(bad).standing, 'unreadable', bad);
    }
  });

  test('an unrecognised hook is non_standard, and its permissions still decode', () => {
    const verdict = b20HookAssessmentV1(RARE_HOOK);
    assert.equal(verdict.standing, 'non_standard');
    assert.equal(verdict.permissions?.mayChangeSwapAmounts, true);
  });
});
