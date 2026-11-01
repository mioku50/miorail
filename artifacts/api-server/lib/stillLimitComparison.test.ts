import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { stillLimitComparisonV1 } from './stillLimitComparison.js';

describe("Still's limit beside the protocol's", () => {
  test('half the protocol leaves a 50% margin; 40% leaves 60%; a mixed account rounds the margin down', () => {
    const half = stillLimitComparisonV1({ protocol: 'Morpho', protocolLimitAssets: 1_234_560_000n, stillLimitAssets: 617_280_000n, shareBps: 5_000n, lowered: null });
    assert.deepEqual(half, {
      protocol: 'Morpho', protocolLimitAtomic: '1234560000', stillLimitAtomic: '617280000', shareBps: 5_000, marginAtStillLimitBps: 5_000, lowered: null,
    });
    const closed = stillLimitComparisonV1({
      protocol: 'Aave V4', protocolLimitAssets: 1_000_000_000n, stillLimitAssets: 400_000_000n, shareBps: 4_000,
      lowered: { reason: 'market_closed', until: '2026-11-02T01:00:00.000Z' },
    });
    assert.equal(closed!.marginAtStillLimitBps, 6_000);
    assert.deepEqual(closed!.lowered, { reason: 'market_closed', until: '2026-11-02T01:00:00.000Z' });
    // One stock at 50%, another at 40%: 1 − 450.000001/1000 is a hair under 55%.
    const mixed = stillLimitComparisonV1({ protocol: 'Aave V4', protocolLimitAssets: 1_000_000_000n, stillLimitAssets: 450_000_001n, shareBps: 5_000, lowered: null });
    assert.equal(mixed!.marginAtStillLimitBps, 5_499);
  });

  test('nothing to compare is no comparison, never a zero', () => {
    const base = { protocol: 'Aave V4' as const, protocolLimitAssets: 100n, stillLimitAssets: 50n, shareBps: 5_000, lowered: null };
    assert.equal(stillLimitComparisonV1({ ...base, protocolLimitAssets: 0n, stillLimitAssets: 0n }), null);
    assert.equal(stillLimitComparisonV1({ ...base, stillLimitAssets: 101n }), null);
    assert.equal(stillLimitComparisonV1({ ...base, shareBps: undefined }), null);
    assert.equal(stillLimitComparisonV1({ ...base, shareBps: 0 }), null);
    assert.equal(stillLimitComparisonV1({ ...base, shareBps: 10_001 }), null);
  });
});
