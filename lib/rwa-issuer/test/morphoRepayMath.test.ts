import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { MorphoMarketTotalsV1, MorphoPositionV1 } from '../src/morphoBorrowMath.js';
import { morphoRepayProjectionV1, type MorphoRepayAmountV1 } from '../src/morphoRepayMath.js';

const totals = (over: Partial<MorphoMarketTotalsV1> = {}): MorphoMarketTotalsV1 => ({
  totalSupplyAssets: 2_000_000n, totalSupplyShares: 2_000_000_000_000n,
  totalBorrowAssets: 1_000_000n, totalBorrowShares: 1_000_000_000_000n,
  lastUpdate: 1_800_000_000n, fee: 0n, ...over,
});
const position = (over: Partial<MorphoPositionV1> = {}): MorphoPositionV1 => ({ collateral: 500n, borrowShares: 500_000_000_000n, ...over });
const project = (amount: MorphoRepayAmountV1, maximumAssets = 1_000_000n, market = totals(), owner = position()) =>
  morphoRepayProjectionV1({ totals: market, position: owner, amount, maximumAssets });

describe('Morpho repayment uses debt shares, not the limit for a new loan', () => {
  test('partial exact assets remove the contract-rounded shares and preserve collateral', () => {
    const before = totals(), owner = position();
    const answer = project({ mode: 'assets', assets: 200_000n }, 200_000n, before, owner);
    assert.equal(answer.ok, true); if (!answer.ok) return;
    assert.equal(answer.repaidAssets, 200_000n);
    assert.equal(answer.repaidShares, 200_000_000_000n);
    assert.deepEqual(answer.position, { collateral: 500n, borrowShares: 300_000_000_000n });
    assert.equal(answer.totals.totalBorrowAssets, 800_000n);
    assert.equal(answer.totals.totalBorrowShares, 800_000_000_000n);
    assert.equal(answer.totals.totalSupplyAssets, before.totalSupplyAssets);
    assert.equal(answer.totals.totalSupplyShares, before.totalSupplyShares);
    assert.deepEqual(owner, position());
    assert.deepEqual(before, totals());
  });
  test('full repayment closes the exact owner shares after interest, rounded up', () => {
    const answer = project({ mode: 'all' }, 500_002n, totals({ totalBorrowAssets: 1_000_003n }));
    assert.equal(answer.ok, true); if (!answer.ok) return;
    assert.equal(answer.repaidShares, 500_000_000_000n);
    assert.equal(answer.repaidAssets, 500_002n);
    assert.equal(answer.position.borrowShares, 0n);
    assert.equal(answer.totals.totalBorrowAssets, 500_001n);
    assert.equal(answer.position.collateral, 500n);
  });
  test('full debt one atom above stored market assets follows the protocol zero-floor edge', () => {
    const answer = project({ mode: 'all' }, 2n,
      totals({ totalBorrowAssets: 1n, totalBorrowShares: 2_000_000n }), position({ borrowShares: 2_000_000n }));
    assert.equal(answer.ok, true); if (!answer.ok) return;
    assert.equal(answer.repaidAssets, 2n);
    assert.equal(answer.totals.totalBorrowAssets, 0n);
    assert.equal(answer.totals.totalBorrowShares, 0n);
  });
  test('zero stored assets with remaining shares can still be closed for the rounded atom', () => {
    const answer = project({ mode: 'all' }, 1n,
      totals({ totalBorrowAssets: 0n, totalBorrowShares: 1n }), position({ borrowShares: 1n, collateral: 0n }));
    assert.equal(answer.ok, true); if (!answer.ok) return;
    assert.equal(answer.repaidAssets, 1n);
    assert.equal(answer.position.borrowShares, 0n);
  });
  test('absent collateral, exhausted liquidity and debt above supply do not block repayment', () => {
    const answer = project({ mode: 'assets', assets: 200_000n }, 200_000n,
      totals({ totalSupplyAssets: 0n }), position({ collateral: 0n }));
    assert.equal(answer.ok, true);
  });
  for (const amount of [{ mode: 'assets', assets: 200_000n }, { mode: 'all' }] as const) {
    test(`a maximum one atom too low refuses ${amount.mode}`, () => {
      const maximum = amount.mode === 'all' ? 499_999n : 199_999n;
      assert.deepEqual(project(amount, maximum), { ok: false, refusal: 'repay_maximum_exceeded' });
    });
  }
  test('no owner debt is distinct from an unread or malformed position', () => {
    assert.deepEqual(project({ mode: 'all' }, 1n, totals(), position({ borrowShares: 0n })), { ok: false, refusal: 'nothing_to_repay' });
    assert.deepEqual(project({ mode: 'all' }, 1n, totals(), position({ borrowShares: -1n })), { ok: false, refusal: 'repay_inputs_invalid' });
  });
  test('an amount which burns zero shares is not presented as repayment progress', () => {
    assert.deepEqual(project({ mode: 'assets', assets: 1n }, 1n,
      totals({ totalBorrowAssets: 10_000_000n, totalBorrowShares: 1n }), position({ borrowShares: 1n })),
    { ok: false, refusal: 'repay_rounds_to_zero' });
  });
  test('typing a rounded debt amount cannot silently switch to full repayment', () => {
    const market = totals({ totalBorrowAssets: 100n, totalBorrowShares: 100n }), owner = position({ borrowShares: 1n });
    assert.deepEqual(project({ mode: 'assets', assets: 1n }, 1n, market, owner), { ok: false, refusal: 'repay_exceeds_debt' });
    const full = project({ mode: 'all' }, 1n, market, owner);
    assert.equal(full.ok, true); if (full.ok) assert.equal(full.position.borrowShares, 0n);
  });
  for (const bad of [-1n, 0n, 1n << 128n]) {
    test(`rejects invalid maximum ${bad}`, () => {
      assert.deepEqual(project({ mode: 'all' }, bad), { ok: false, refusal: 'repay_inputs_invalid' });
    });
  }
  test('rejects shares outside the measured total and nonpositive asset requests', () => {
    assert.deepEqual(project({ mode: 'all' }, 1n, totals({ totalBorrowShares: 1n })), { ok: false, refusal: 'repay_inputs_invalid' });
    for (const assets of [-1n, 0n, 1n << 128n]) assert.deepEqual(project({ mode: 'assets', assets }), { ok: false, refusal: 'repay_inputs_invalid' });
  });
});
