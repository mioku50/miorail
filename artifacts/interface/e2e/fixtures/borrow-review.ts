import { borrowReviewV1 } from '../../../../lib/rwa-issuer/src/borrowReview.js';

export const NOW = new Date('2026-10-27T15:00:00Z');
export const MARKET = `0x${'a'.repeat(64)}`;
export const WALLET = `0x${'1'.repeat(40)}`;
export function borrowReviewFixture(refused = false, changed = false) {
  const review = borrowReviewV1({
    market: { marketId: MARKET, curated: null, lltvBps: 8600, collateralSymbol: 'cbBTC', loanSymbol: 'USDC', collateralDecimals: 8, loanDecimals: 6, borrowApyWad: null, blockNumber: 53_000_000 },
    before: { collateral: BigInt(1000000), borrowedAssets: BigInt(0), healthFactorWad: null, liquidationPrice: null },
    after: refused ? null : { collateral: BigInt(1000000), borrowedAssets: BigInt(10000000), healthFactorWad: BigInt('8600000000000000000'), liquidationPrice: BigInt('10000000000000000000000000000000000000') },
    askAssets: BigInt(10000000), collateralPrice: BigInt('100000000000000000000000000000000000000'), liquidationIncentiveWad: BigInt('1100000000000000000'), marketLiquidityAssets: BigInt(1000000000), readAt: NOW.toISOString(),
    refusal: refused ? 'over_still_limit' : null,
  });
  if (refused) return { state: 'refused', refusal: 'over_still_limit', detail: 'Still limit changed.', marketId: MARKET, review };
  return { state: 'ready', marketId: MARKET, review, steps: [], callsHash: `0x${(changed ? '3' : '1').repeat(64)}`,
    signingTermsHash: `0x${(changed ? '4' : '2').repeat(64)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    calls: [{ to: WALLET, value: '0', data: '0x12345678' }], measured: { blockNumber: 53_000_000, arrivedAtomic: '10000000', provider: 'fixture' } };
}
