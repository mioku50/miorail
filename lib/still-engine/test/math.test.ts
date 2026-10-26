import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCents, formatPercentBps, formatTokenAmount } from '../src/format.js';
import { mulDiv, usdcToCents } from '../src/math.js';
import { accrueMarket, borrowAssets, toAssetsUp, wTaylorCompounded } from '../src/morpho.js';

describe('rounding names its direction', () => {
  it('rounds down what may be borrowed and up what is owed', () => {
    assert.equal(mulDiv(10n, 1n, 3n, 'down'), 3n);
    assert.equal(mulDiv(10n, 1n, 3n, 'up'), 4n);
    assert.equal(mulDiv(9n, 1n, 3n, 'up'), 3n);
    assert.equal(usdcToCents(1_234_599n, 'down'), 123n);
    assert.equal(usdcToCents(1_230_001n, 'up'), 124n);
    assert.throws(() => mulDiv(1n, 1n, 0n, 'down'));
  });
});

describe('Morpho arithmetic', () => {
  it('compounds like MathLib.wTaylorCompounded', () => {
    // A 5.25% a year rate per second over one year compounds to about e^0.0525 − 1 = 5.39%.
    const year = wTaylorCompounded(1_665_852_318n, 31_536_000n);
    assert.ok(Math.abs(Number(year) / 1e18 - Math.expm1(0.052534)) < 0.5e-4);
  });

  it('accrues interest only when time passed and something is borrowed', () => {
    const state = { totalSupplyAssets: 2_000n * 10n ** 6n, totalSupplyShares: 2_000n * 10n ** 12n, totalBorrowAssets: 1_000n * 10n ** 6n, totalBorrowShares: 1_000n * 10n ** 12n, lastUpdate: 100n, fee: 0n };
    assert.equal(accrueMarket(state, 1_665_852_318n, 100n), state);
    const accrued = accrueMarket(state, 1_665_852_318n, 100n + 86_400n);
    assert.equal(accrued.totalBorrowAssets - state.totalBorrowAssets, accrued.totalSupplyAssets - state.totalSupplyAssets);
    assert.equal(accrued.totalBorrowAssets, 1_000_143_939n); // $1,000 grows by 0.0143939% in a day
    assert.equal(borrowAssets(0n, accrued), 0n);
    assert.equal(toAssetsUp(1n, 1n, 1n), 1n);
  });

  it('a protocol fee mints supply shares, never borrow assets', () => {
    const state = { totalSupplyAssets: 2_000n * 10n ** 6n, totalSupplyShares: 2_000n * 10n ** 12n, totalBorrowAssets: 1_000n * 10n ** 6n, totalBorrowShares: 1_000n * 10n ** 12n, lastUpdate: 0n, fee: 10n ** 17n };
    const accrued = accrueMarket(state, 1_665_852_318n, 86_400n);
    assert.ok(accrued.totalSupplyShares > state.totalSupplyShares);
    assert.equal(accrued.totalBorrowShares, state.totalBorrowShares);
  });
});

describe('formatting', () => {
  it('money to the cent with separators', () => {
    assert.equal(formatCents('102479'), '$1,024.79');
    assert.equal(formatCents(5n), '$0.05');
    assert.equal(formatCents('0'), '$0.00');
  });

  it('token amounts truncated, never rounded up', () => {
    assert.equal(formatTokenAmount('420000000', 8), '4.2000');
    assert.equal(formatTokenAmount('1999999', 8, 4), '0.0199');
    assert.equal(formatTokenAmount(1_500_000_000_000_000_000n, 18, 2), '1.50');
    assert.equal(formatTokenAmount('123456789000000000000000', 18, 0), '123,456');
    // Too small for four places: two significant digits, never a misleading 0.0000.
    assert.equal(formatTokenAmount('9585', 8), '0.000095');
    assert.equal(formatTokenAmount('4840', 8), '0.000048');
    assert.equal(formatTokenAmount('1', 8), '0.00000001');
    assert.equal(formatTokenAmount('0', 8), '0.0000');
    // Something already visible at four places stays at four places.
    assert.equal(formatTokenAmount(500_000_000_000_000n, 18), '0.0005');
  });

  it('percent from basis points, truncated', () => {
    assert.equal(formatPercentBps(5237), '52%');
    assert.equal(formatPercentBps(366, 2), '3.66%');
  });
});
