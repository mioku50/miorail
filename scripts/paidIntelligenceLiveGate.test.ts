import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  PAID_LIVE_MAX_MONTHLY_ATOMIC_V1,
  PAID_LIVE_MAX_PER_REQUEST_ATOMIC_V1,
  paidIntelligenceLiveGateV1,
  usdcDecimalToAtomicV1,
} from './paidIntelligenceLiveGate.js';

// ---------------------------------------------------------------------------
// T71 verification §3 — no single variable may reach a live grant.
//
// Each test removes exactly one statement from an otherwise complete set and
// asserts the run is refused. That is the property: not "the flag works", but
// that the five statements are independently necessary, so a half-configured
// environment — the realistic failure — cannot spend anything.
// ---------------------------------------------------------------------------

const WALLET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

function liveEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE: 'true',
    MIORAIL_PAID_LIVE_WALLET: WALLET,
    MIORAIL_PAID_LIVE_CHAIN_ID: '8453',
    MIORAIL_PAID_LIVE_MONTHLY_USDC: '0.50',
    MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC: '0.05',
    ...overrides,
  };
}

describe('paidIntelligenceLiveGateV1', () => {
  test('an empty environment is refused', () => {
    const gate = paidIntelligenceLiveGateV1({});
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE/);
  });

  test('a complete set of statements is allowed and echoed back safely', () => {
    const gate = paidIntelligenceLiveGateV1(liveEnv());
    assert.equal(gate.allowed, true);
    if (!gate.allowed) return;
    assert.equal(gate.wallet, WALLET);
    assert.equal(gate.chainId, '8453');
    assert.equal(gate.monthlyAtomic, '500000');
    assert.equal(gate.maxPerRequestAtomic, '50000');
    assert.match(gate.reason, /0\.50 USDC\/month/);
  });

  for (const missing of [
    'MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE',
    'MIORAIL_PAID_LIVE_WALLET',
    'MIORAIL_PAID_LIVE_CHAIN_ID',
    'MIORAIL_PAID_LIVE_MONTHLY_USDC',
    'MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC',
  ]) {
    test(`removing ${missing} refuses the run`, () => {
      const env = liveEnv();
      delete env[missing];
      const gate = paidIntelligenceLiveGateV1(env);
      assert.equal(gate.allowed, false);
      assert.match(gate.reason, new RegExp(missing));
    });
  }

  test('the live flag must be exactly true, not merely truthy', () => {
    for (const value of ['1', 'yes', 'TRUE ', 'on']) {
      const gate = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE: value }));
      // 'TRUE ' trims and lowercases to 'true' — that IS the operator saying it.
      assert.equal(gate.allowed, value === 'TRUE ');
    }
  });

  test('the chain is compared to the literal 8453, so an empty value is not a number', () => {
    for (const value of ['', '84532', '8453 ', '0x2105', '08453']) {
      const gate = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_CHAIN_ID: value }));
      // '8453 ' is trimmed; everything else is a different chain or not one.
      assert.equal(gate.allowed, value === '8453 ');
    }
  });

  test('a wallet that is not a Base address is refused', () => {
    for (const value of ['0x123', 'not-an-address', `${WALLET}00`, '']) {
      const gate = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_WALLET: value }));
      assert.equal(gate.allowed, false);
    }
  });

  test('a checksummed wallet is accepted and normalised', () => {
    const gate = paidIntelligenceLiveGateV1(
      liveEnv({ MIORAIL_PAID_LIVE_WALLET: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' }),
    );
    assert.equal(gate.allowed, true);
    if (gate.allowed) assert.equal(gate.wallet, WALLET);
  });

  test('a zero limit is refused — a permission that can buy nothing is not a test', () => {
    assert.equal(paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_MONTHLY_USDC: '0' })).allowed, false);
    assert.equal(paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC: '0.000000' })).allowed, false);
  });

  test('more per request than per month is refused', () => {
    const gate = paidIntelligenceLiveGateV1(
      liveEnv({ MIORAIL_PAID_LIVE_MONTHLY_USDC: '0.05', MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC: '0.06' }),
    );
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /exceeds the monthly limit/);
  });

  test('a smoke may not grant a real month of budget', () => {
    const gate = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_MONTHLY_USDC: '50' }));
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /above 1\.00/);
  });

  test('an extra zero in the per-request limit is refused', () => {
    const gate = paidIntelligenceLiveGateV1(
      liveEnv({ MIORAIL_PAID_LIVE_MONTHLY_USDC: '1.00', MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC: '0.50' }),
    );
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /above 0\.10/);
  });

  test('the ceilings are exactly at the boundary, not one below it', () => {
    const gate = paidIntelligenceLiveGateV1(
      liveEnv({ MIORAIL_PAID_LIVE_MONTHLY_USDC: '1', MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC: '0.1' }),
    );
    assert.equal(gate.allowed, true);
    assert.equal(PAID_LIVE_MAX_MONTHLY_ATOMIC_V1, 1_000_000n);
    assert.equal(PAID_LIVE_MAX_PER_REQUEST_ATOMIC_V1, 100_000n);
  });

  test('revoking asks separately from spending', () => {
    const withoutRevoke = paidIntelligenceLiveGateV1(liveEnv());
    assert.equal(withoutRevoke.allowed && withoutRevoke.allowRevoke, false);
    const withRevoke = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_ALLOW_REVOKE: 'true' }));
    assert.equal(withRevoke.allowed && withRevoke.allowRevoke, true);
  });

  test('a refusal names a variable and never a value', () => {
    const gate = paidIntelligenceLiveGateV1(liveEnv({ MIORAIL_PAID_LIVE_WALLET: '0xdeadbeef' }));
    assert.equal(gate.allowed, false);
    assert.ok(!gate.reason.includes('0xdeadbeef'));
  });
});

describe('usdcDecimalToAtomicV1', () => {
  test('converts USDC decimals exactly', () => {
    assert.equal(usdcDecimalToAtomicV1('1'), 1_000_000n);
    assert.equal(usdcDecimalToAtomicV1('0.01'), 10_000n);
    assert.equal(usdcDecimalToAtomicV1('0.000001'), 1n);
    assert.equal(usdcDecimalToAtomicV1('3.00'), 3_000_000n);
  });

  test('refuses anything that is not a positive USDC decimal', () => {
    for (const value of ['', '0', '-1', '1.0000001', '1e6', 'abc', '.5', '01', '1.', ' ']) {
      assert.equal(usdcDecimalToAtomicV1(value), null, value);
    }
  });
});
