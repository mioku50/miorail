import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { borrowReviewV1 } from '@mioagent/rwa-issuer/borrowReview';
import { aaveLendingStressV1, collateralTransfersPausedWordsV1, LENDING_STRESS_FALLS_BPS_V1, morphoLendingStressV1 } from './lendingStress.js';

// ---------------------------------------------------------------------------
// The stress a loan review shows (2026-11-13): each fall at once, where it leaves
// the health ratio, how far the collateral can fall before liquidation can start,
// and what a pause of its transfers would do. Every figure is the simulated
// position's own, rounded the way that does not flatter the loan.
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;
const aave = (patch: Partial<Parameters<typeof aaveLendingStressV1>[0]> = {}) => aaveLendingStressV1({
  healthAfterWad: 2n * WAD, activeCollateralCount: 1n, selectedIsCollateral: true,
  price: 25_000_000_000n, oracleDecimals: 8, receiveSharesEnabled: true, frozen: false, transfersPaused: false, ...patch,
});

describe('a loan review measures what a fall at once does', () => {
  it('scales the health ratio with the price, and says where liquidation can start', () => {
    const s = aave()!;
    assert.deepEqual(LENDING_STRESS_FALLS_BPS_V1, [1_000, 2_000, 3_000]);
    assert.deepEqual(s.scenarios, [
      { fallBps: 1_000, healthWad: (18n * WAD / 10n).toString(), liquidatable: false },
      { fallBps: 2_000, healthWad: (16n * WAD / 10n).toString(), liquidatable: false },
      { fallBps: 3_000, healthWad: (14n * WAD / 10n).toString(), liquidatable: false },
    ]);
    // At Still's full limit the ratio is 2.00: half the price is the line.
    assert.equal(s.marginTenths, 500);
    assert.equal(s.scope, 'collateral');
    assert.equal(s.priceCents, '25000');
    assert.equal(s.liquidationPriceCents, '12500');
  });

  it('marks the falls that would let liquidation start, below 1.00 and not at it', () => {
    const s = aave({ healthAfterWad: 12n * WAD / 10n })!;
    assert.deepEqual(s.scenarios.map(row => row.liquidatable), [false, true, true]);
    const edge = aave({ healthAfterWad: 10n * WAD / 9n })!;
    // 1.111… less 10% is 0.999…: the ratio is below 1.00.
    assert.equal(edge.scenarios[0]!.liquidatable, true);
    assert.equal(aave({ healthAfterWad: WAD * 10_000n / 9_000n + 1n })!.scenarios[0]!.liquidatable, false);
  });

  it('rounds the margin down and the liquidation price up', () => {
    // 1/3 of the way: health 1.5 can fall 33.33…%; said as 33.3%.
    const s = aave({ healthAfterWad: 15n * WAD / 10n, price: 10_000_000_001n })!;
    assert.equal(s.marginTenths, 333);
    // 100.00000001 / 1.5 = 66.666…67 dollars, said as $66.67.
    assert.equal(s.liquidationPriceCents, '6667');
    assert.equal(s.priceCents, '10000');
  });

  it('with several stocks pledged, says only how far all of them can fall together', () => {
    const s = aave({ activeCollateralCount: 2n })!;
    assert.equal(s.scope, 'all_collateral');
    assert.equal(s.priceCents, null);
    assert.equal(s.liquidationPriceCents, null);
    assert.equal(s.marginTenths, 500);
    assert.equal(aave({ selectedIsCollateral: false })!.scope, 'all_collateral');
  });

  it('reads no stress from a ratio that is not a loan’s', () => {
    assert.equal(aave({ healthAfterWad: null }), null);
    assert.equal(aave({ healthAfterWad: 1n << 128n }), null);
    assert.equal(aave({ healthAfterWad: 0n }), null);
    assert.equal(aave({ oracleDecimals: 1 }), null);
  });
});

describe('a pause of the collateral’s transfers, as the contracts were read', () => {
  it('on Aave a liquidator can take the deposit inside the Spoke, so a liquidation does not wait', () => {
    assert.deepEqual(aave()!.transfers, { pausable: true, paused: false, liquidationMovesToken: false });
    // Without receiveShares, or on a frozen reserve, a liquidation has to move the stock.
    assert.equal(aave({ receiveSharesEnabled: false })!.transfers.liquidationMovesToken, true);
    assert.equal(aave({ frozen: true })!.transfers.liquidationMovesToken, true);
    assert.equal(aave({ receiveSharesEnabled: null, frozen: null })!.transfers.liquidationMovesToken, true);
    // An unread pause stays unread; it is never said to be off.
    assert.equal(aave({ transfersPaused: null })!.transfers.paused, null);
    assert.equal(aave({ transfersPaused: true })!.transfers.paused, true);
  });

  it('on Morpho a liquidation hands the collateral over, so it waits; WETH cannot pause', () => {
    const base = { healthAfterWad: 2n * WAD, collateralPrice: 50_000n * 10n ** 34n, liquidationPrice: 25_000n * 10n ** 34n, collateralDecimals: 8, loanDecimals: 6 };
    const cbBTC = morphoLendingStressV1({ ...base, pausable: true, transfersPaused: false })!;
    assert.deepEqual(cbBTC.transfers, { pausable: true, paused: false, liquidationMovesToken: true });
    assert.equal(cbBTC.scope, 'collateral');
    // 50,000 USDC per whole cbBTC (8 decimals) in Morpho's 1e36 scale.
    assert.equal(cbBTC.priceCents, '5000000');
    assert.equal(cbBTC.liquidationPriceCents, '2500000');
    assert.equal(cbBTC.marginTenths, 500);
    const weth = morphoLendingStressV1({ ...base, pausable: false, transfersPaused: null })!;
    assert.deepEqual(weth.transfers, { pausable: false, paused: false, liquidationMovesToken: true });
  });

  it('says the same margin as the review’s own risk note', () => {
    const collateralPrice = 98_765_432_101n * 10n ** 26n, liquidationPrice = 51_234_567_891n * 10n ** 26n;
    const s = morphoLendingStressV1({ healthAfterWad: 19n * WAD / 10n, collateralPrice, liquidationPrice, collateralDecimals: 8, loanDecimals: 6, pausable: true, transfersPaused: false })!;
    const review = borrowReviewV1({
      market: { marketId: `0x${'a'.repeat(64)}`, collateralSymbol: 'cbBTC', loanSymbol: 'USDC', collateralDecimals: 8, loanDecimals: 6, lltvBps: 8600,
        curated: true, borrowAprWad: null, borrowApyWad: null, blockNumber: 1, rateFromPriorRead: false },
      before: { collateral: 1n, borrowedAssets: 0n, healthFactorWad: null, liquidationPrice: null },
      after: { collateral: 1n, borrowedAssets: 1n, healthFactorWad: 19n * WAD / 10n, liquidationPrice },
      askAssets: 1n, collateralPrice, liquidationIncentiveWad: null, marketLiquidityAssets: null, readAt: '2026-11-13T00:00:00Z',
    } as Parameters<typeof borrowReviewV1>[0]);
    const said = `${Math.floor(s.marginTenths / 10)}.${s.marginTenths % 10}%`;
    assert(review.warnings.some(line => line.startsWith(`A ${said} fall`)), `${said} vs ${review.warnings.join(' | ')}`);
  });

  it('refuses a new loan against collateral that cannot move, in words that keep repaying open', () => {
    const aaveWords = collateralTransfersPausedWordsV1({ symbol: 'AAPLc', venue: 'aave-v4', blockNumber: 56_655_653 });
    assert.match(aaveWords, /^AAPLc transfers are paused onchain \(Base block 56,655,653\)\./);
    assert.match(aaveWords, /Aave could still liquidate the loan/);
    assert.match(aaveWords, /Repaying works\.$/);
    const morphoWords = collateralTransfersPausedWordsV1({ symbol: 'PAXG', venue: 'morpho', blockNumber: 1 });
    assert.doesNotMatch(morphoWords, /liquidate/);
    assert.match(morphoWords, /PAXG could not be taken back/);
  });
});
