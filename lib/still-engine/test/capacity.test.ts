import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { morphoAfterBorrowV1, type MorphoMarketStateV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';
import { morphoStillCapacityV1, morphoStillDrawV1, stillBorrowCapacityV1, stillBorrowLimitV1 } from '../src/capacity.js';
import { computeMirror } from '../src/mirror.js';
import { ADDRESSES } from '../src/registry.js';
import { calendar, ok, reverted, snapshot, universe } from './fixtures.js';

const market = (over: Partial<MorphoMarketStateV1> = {}): MorphoMarketStateV1 => ({
  collateralPrice: 10n ** 36n,
  lltvWad: 800_000_000_000_000_000n,
  totalSupplyAssets: 1_000_000_000n,
  totalBorrowAssets: 2n,
  totalBorrowShares: 1_000_000n,
  blockNumber: 1,
  ...over,
});
const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };

describe('Still capacity uses the total debt limit and explicit units', () => {
  it('takes half the total protocol ceiling and then subtracts existing debt', () => {
    const capacity = stillBorrowCapacityV1({ protocolLimitAssets: 1_000_000_000n, debtAssets: 100_000_000n, liquidityAssets: 900_000_000n });
    assert.equal(capacity.limitAssets, 500_000_000n);
    assert.equal(capacity.availableAssets, 400_000_000n); // $400, not half the $900 protocol headroom
    assert.equal(capacity.availableCents, 40_000n);
  });

  it('floors the limit and liquidity but rounds the debt up to displayed cents separately', () => {
    const capacity = stillBorrowCapacityV1({ protocolLimitAssets: 200_002n, debtAssets: 10_001n, liquidityAssets: 95_001n });
    assert.equal(capacity.limitAssets, 100_001n);
    assert.equal(capacity.headroomAssets, 90_000n); // exact atomic room
    assert.equal(capacity.limitCents, 10n);
    assert.equal(capacity.debtCents, 2n);
    assert.equal(capacity.headroomCents, 8n); // floor(limit) − ceil(debt), not floor(limit − debt)
    assert.equal(capacity.liquidityCents, 9n);
    assert.equal(capacity.availableCents, 8n);
    assert.equal(capacity.availableAssets, 80_000n);
  });

  it('offers nothing when debt is at or above the Still ceiling', () => {
    for (const debtAssets of [500_000_000n, 600_000_000n]) {
      const capacity = stillBorrowCapacityV1({ protocolLimitAssets: 1_000_000_000n, debtAssets, liquidityAssets: 900_000_000n });
      assert.equal(capacity.availableAssets, 0n);
      assert.equal(capacity.availableCents, 0n);
    }
  });

  it('does not turn a liquidity shortage into extra collateral headroom', () => {
    const capacity = stillBorrowCapacityV1({ protocolLimitAssets: 1_000_000_000n, debtAssets: 0n, liquidityAssets: 19_999n });
    assert.equal(capacity.headroomAssets, 500_000_000n);
    assert.equal(capacity.availableAssets, 10_000n);
    assert.equal(capacity.liquidityAssets, 19_999n);
  });

  it('rejects negative units and a share outside the code-owned basis-point policy', () => {
    assert.throws(() => stillBorrowLimitV1({ protocolLimitAssets: -1n }), RangeError);
    assert.throws(() => stillBorrowLimitV1({ protocolLimitAssets: 1n, shareBps: 10_001n }), RangeError);
    assert.throws(() => stillBorrowCapacityV1({ protocolLimitAssets: 1n, debtAssets: -1n, liquidityAssets: 0n }), RangeError);
  });
});

describe('the Morpho projection is part of the offered maximum', () => {
  it('withholds one cent when one rounded debt share would exceed the exact Still ceiling', () => {
    const position = { collateral: 50_000n, borrowShares: 0n };
    const raw = morphoAfterBorrowV1({ market: market(), position, assets: 20_000n });
    assert.equal(raw!.health.borrowedAssets, 20_001n);
    const capacity = morphoStillCapacityV1({ market: market(), position });
    assert.equal(capacity.limitAssets, 20_000n);
    assert.equal(capacity.limitCents, 2n);
    assert.equal(capacity.availableCents, 1n);
    assert.equal(capacity.roundingMarginCents, 1n);
    const offered = morphoStillDrawV1({ market: market(), position, borrowAssets: capacity.availableAssets });
    assert.equal(offered.ok, true);
    if (offered.ok) assert.ok(offered.after.health.borrowedAssets <= capacity.limitAssets);
    const refused = morphoStillDrawV1({ market: market(), position, borrowAssets: 20_000n });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.refusal, 'over_still_limit');
  });

  it('handles a share exchange rate whose single rounded share is worth more than one cent', () => {
    const m = market({ totalBorrowAssets: 1_000_000_000_000n, totalSupplyAssets: 1_001_000_000_000n });
    const capacity = morphoStillCapacityV1({ market: m, position: { collateral: 50_000n, borrowShares: 0n } });
    assert.equal(capacity.limitCents, 2n);
    assert.equal(capacity.availableCents, 0n);
    assert.equal(capacity.roundingMarginCents, 2n);
  });

  it('uses only pledged collateral plus the explicitly selected addition', () => {
    const m = market({ totalBorrowAssets: 0n, totalBorrowShares: 0n });
    const position = { collateral: 50_000n, borrowShares: 0n };
    assert.equal(morphoStillCapacityV1({ market: m, position }).limitAssets, 20_000n);
    const selected = morphoStillCapacityV1({ market: m, position, additionalCollateralAssets: 25_000n });
    assert.equal(selected.collateralAfterAssets, 75_000n);
    assert.equal(selected.limitAssets, 30_000n);
  });

  it('keeps an unread/invalid standing from becoming a computed allowance', () => {
    assert.throws(() => morphoStillCapacityV1({ market: market(), position: { collateral: 1n, borrowShares: 1_000_001n } }), RangeError);
    assert.throws(() => morphoStillCapacityV1({ market: market(), position: { collateral: -1n, borrowShares: 0n } }), RangeError);
    assert.throws(() => morphoStillCapacityV1({ market: market({ lltvWad: 10n ** 18n + 1n }), position: { collateral: 1n, borrowShares: 0n } }), RangeError);
  });

  it('distinguishes no positive request, insufficient market liquidity and the Still allowance', () => {
    const input = { market: market({ totalSupplyAssets: 2n + 19_999n }), position: { collateral: 1_000_000n, borrowShares: 0n } };
    for (const [borrowAssets, refusal] of [[0n, 'nothing_asked_for'], [20_000n, 'over_market_liquidity']] as const) {
      const result = morphoStillDrawV1({ ...input, borrowAssets });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.refusal, refusal);
    }
  });

  it('every offered whole-cent amount passes the exact projected-debt guard across varied share ratios', () => {
    for (let i = 0n; i < 80n; i += 1n) {
      const m = market({
        totalBorrowAssets: i * i * 133n,
        totalBorrowShares: i * 97n,
        totalSupplyAssets: i * i * 133n + 500_000n,
      });
      const position = { collateral: 500_000n, borrowShares: i * 19n };
      const capacity = morphoStillCapacityV1({ market: m, position });
      for (let cents = 1n; cents <= capacity.availableCents; cents += 1n) {
        const result = morphoStillDrawV1({ market: m, position, borrowAssets: cents * 10_000n });
        assert.equal(result.ok, true, `${i}: ${cents}`);
        if (result.ok) assert.ok(result.after.health.borrowedAssets <= capacity.limitAssets);
      }
    }
  });
});

describe('the Mirror and executable offer share the same allowance', () => {
  it('corrects only the edge-case offer, keeping the capacity and accounting identity explicit', () => {
    const s = snapshot({ wallet: { cbBTC: 50_000n } });
    const m = s.morpho.get('cbBTC')!;
    m.info = { ...m.info, params: { ...m.info.params, lltv: 800_000_000_000_000_000n } };
    m.market = ok({ totalSupplyAssets: 1_000_000_000n, totalSupplyShares: 1_000_000n, totalBorrowAssets: 2n, totalBorrowShares: 1_000_000n, lastUpdate: s.block.timestamp, fee: 0n });
    m.price = ok(10n ** 36n);
    m.borrowRatePerSecond = ok(0n);
    const report = computeMirror({ universe: universe(), snapshot: s, calendar: calendar(), subject, assembledAt: new Date('2026-10-27T12:00:00Z') });
    const line = report.venues.find((v) => v.label.includes('cbBTC'))!;
    assert.equal(line.capacityCents, '2');
    assert.equal(line.availableCents, '1');
    assert.deepEqual(line.deductions, { loansCents: '0', venueLimitCents: '1' });
    const draw = morphoStillDrawV1({ market: market(), position: { collateral: 0n, borrowShares: 0n }, additionalCollateralAssets: 50_000n, borrowAssets: BigInt(line.availableCents!) * 10_000n });
    assert.equal(draw.ok, true);
  });

  it('preserves the known collateral capacity while an unread debt remains unknown', () => {
    const s = snapshot({ wallet: { cbBTC: 50_000n }, morpho: { cbBTC: { collateral: 1n, borrowShares: 1n } } });
    s.morpho.get('cbBTC')!.market = reverted();
    const report = computeMirror({ universe: universe(), snapshot: s, calendar: calendar(), subject, assembledAt: new Date('2026-10-27T12:00:00Z') });
    const line = report.venues.find((v) => v.label.includes('cbBTC'))!;
    assert.notEqual(line.capacityCents, null);
    assert.equal(line.debtCents, null);
    assert.equal(line.availableCents, null);
    assert.equal(report.headline.complete, false);
    assert.ok(report.coverage.failed.some((x) => x.what === 'Morpho · cbBTC/USDC market totals'));
    assert.equal(s.balances.get(ADDRESSES.cbbtc.toLowerCase())!.ok, true);
  });
});
