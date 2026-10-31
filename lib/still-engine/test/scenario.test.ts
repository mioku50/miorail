import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MirrorInput } from '../src/mirror.js';
import type { MirrorReport } from '../src/report.js';
import { healthFactorTextV1, scenarioV1, type ScenarioEditV1 } from '../src/scenario.js';
import { EXAMPLE, calendar, ok, reverted, snapshot, universe, type Holdings } from './fixtures.js';

const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
const input = (h: Holdings = EXAMPLE): MirrorInput => ({
  universe: universe(),
  snapshot: snapshot(h),
  calendar: calendar(),
  subject,
  assembledAt: new Date('2026-10-21T15:00:01Z'),
});
const line = (r: MirrorReport, asset: string) => r.assets.find((l) => l.asset === asset)!;
const venue = (r: MirrorReport, label: string) => r.venues.find((v) => v.label.includes(label))!;

function run(edits: ScenarioEditV1[], i: MirrorInput = input()) {
  const outcome = scenarioV1(i, edits);
  assert.ok(outcome.ok, `refused: ${outcome.ok ? '' : outcome.reason}`);
  return outcome;
}

describe('a price move, computed by the Mirror engine', () => {
  // The example: 3.4 NVDAc pledged on Aave against $240.17, weekday terms.
  it('NVIDIA 30% lower moves the price, the health factor and the room, and not the trigger', () => {
    const { before, after } = run([{ kind: 'price', asset: 'NVDAc', changeBps: -3000 }]);
    assert.equal(line(after, 'NVDAc').priceCents, '14833'); // $211.907 × 0.7 = $148.3349
    // HF = 3.4 × 148.3349 × 70% / 240.17 = 1.46994; before 3.4 × 211.907 × 70% / 240.17 = 2.09992.
    assert.equal(healthFactorTextV1(venue(before, 'Aave').safety!.healthFactor), '2.09');
    assert.equal(healthFactorTextV1(venue(after, 'Aave').safety!.healthFactor), '1.46');
    // Debt and collateral amounts did not move, so neither did the price that liquidates.
    assert.deepEqual(venue(after, 'Aave').liquidationPrices, venue(before, 'Aave').liquidationPrices);
    // 4.2 × $148.3349 × 35% = $218.0523, rounded down to the cent.
    assert.equal(line(after, 'NVDAc').capacityCents, '21805');
    assert.equal(venue(after, 'Aave').availableCents, '27683'); // 218.05 + 202.55 + 96.40 − 240.17
    assert.equal(after.headline.availableCents, '69117'); // with the untouched $414.34 of cbBTC
  });

  it('moves the protocol’s own health factor by the engine’s ratio', () => {
    const i = input();
    i.snapshot.aave!.account = ok({ healthFactor: 1_500_000_000_000_000_000n, borrowCount: 1n });
    const { before, after } = run([{ kind: 'price', asset: 'NVDAc', changeBps: -3000 }], i);
    assert.equal(venue(before, 'Aave').safety!.source, 'protocol');
    // NVIDIA is the only collateral, so its weight falls by exactly 30%: 1.50 × 0.7.
    assert.equal(healthFactorTextV1(venue(after, 'Aave').safety!.healthFactor), '1.05');
    assert.equal(venue(after, 'Aave').safety!.source, 'computed');
  });

  it('a price named in dollars lands on that price exactly', () => {
    const { after } = run([
      { kind: 'price_to', asset: 'cbBTC', cents: 6_000_000n },
      { kind: 'price_to', asset: 'NVDAc', cents: 15_000n },
    ]);
    assert.equal(line(after, 'cbBTC').priceCents, '6000000');
    assert.equal(line(after, 'NVDAc').priceCents, '15000');
    // 3.4 × $150 × 70% / 240.17 = 1.4863
    assert.equal(healthFactorTextV1(venue(after, 'Aave').safety!.healthFactor), '1.48');
  });

  it('a stock the wallet does not hold changes nothing', () => {
    const { before, after } = run([{ kind: 'price', asset: 'METAc', changeBps: -5000 }]);
    assert.equal(after.headline.availableCents, before.headline.availableCents);
    assert.deepEqual(venue(after, 'Aave').safety!.healthFactor, venue(before, 'Aave').safety!.healthFactor);
  });

  it('a fall large enough reaches liquidation', () => {
    // The trigger is $100.92; 55% lower is $95.36.
    const { after } = run([{ kind: 'price', asset: 'NVDAc', changeBps: -5500 }]);
    assert.equal(venue(after, 'Aave').safety!.state, 'liquidation');
  });
});

describe('a debt change, computed by the Mirror engine', () => {
  it('$100 more on Aave: debt, health factor and the trigger price', () => {
    const { after } = run([{ kind: 'borrow', venue: 'aave-v4', usdcAtomic: 100_000_000n }]);
    const aave = venue(after, 'Aave');
    assert.equal(aave.debtCents, '34017');
    assert.equal(healthFactorTextV1(aave.safety!.healthFactor), '1.48'); // 504.33866 / 340.17
    // 340.17 / (3.4 × 70%) = $142.9286, rounded up against the borrower.
    assert.deepEqual(aave.liquidationPrices, [{ asset: 'NVDAc', priceCents: '14293', unreachable: false }]);
    assert.equal(aave.availableCents, '27028'); // 610.45 − 340.17
  });

  it('repaying all of it leaves no debt and the whole room', () => {
    const { after } = run([{ kind: 'repay', venue: 'aave-v4', usdcAtomic: 'all' }]);
    assert.equal(venue(after, 'Aave').debtCents, '0');
    assert.equal(venue(after, 'Aave').safety, null);
    assert.equal(after.headline.availableCents, '102479'); // the same as a wallet that never borrowed
  });

  it('a repayment larger than the debt is the whole debt', () => {
    const { after } = run([{ kind: 'repay', venue: 'aave-v4', usdcAtomic: 1_000_000_000n }]);
    assert.equal(venue(after, 'Aave').debtCents, '0');
  });

  it('a price fall and a repayment together', () => {
    const { after } = run([
      { kind: 'price', asset: 'NVDAc', changeBps: -3000 },
      { kind: 'repay', venue: 'aave-v4', usdcAtomic: 100_000_000n },
    ]);
    // 353.037062 / 140.17 = 2.5186
    assert.equal(healthFactorTextV1(venue(after, 'Aave').safety!.healthFactor), '2.51');
  });

  it('Morpho: borrowing and repaying go through shares, as the contract does', () => {
    const i = input({ ...EXAMPLE, wallet: { ...EXAMPLE.wallet, cbBTC: 0n }, morpho: { cbBTC: { collateral: 1_200_000n, borrowShares: 0n } } });
    const more = run([{ kind: 'borrow', venue: 'morpho:cbBTC', usdcAtomic: 50_000_000n }], i);
    // The debt is the shares turned back into USDC, rounded up against the borrower.
    assert.ok(['5000', '5001'].includes(venue(more.after, 'cbBTC').debtCents!));
    assert.ok(venue(more.after, 'cbBTC').safety !== null);
    const owing = input({ ...EXAMPLE, morpho: { cbBTC: { collateral: 1_200_000n, borrowShares: 44_421_082_434_040n } } });
    const repaid = run([{ kind: 'repay', venue: 'morpho:cbBTC', usdcAtomic: 'all' }], owing);
    assert.ok(BigInt(venue(repaid.before, 'cbBTC').debtCents!) > 0n);
    assert.equal(venue(repaid.after, 'cbBTC').debtCents, '0');
  });
});

describe('a deposit, computed by the Mirror engine', () => {
  it('pledging Apple from the wallet raises the health factor and leaves the room', () => {
    const { before, after } = run([{ kind: 'deposit', asset: 'AAPLc', raw: 150_000_000n, source: 'wallet' }]);
    // (504.33866 + 1.5 × 346.25 × 78%) / 240.17 = 909.45116 / 240.17 = 3.7867
    assert.equal(healthFactorTextV1(venue(after, 'Aave').safety!.healthFactor), '3.78');
    // Still already counted the wallet's Apple, so the room is the same.
    assert.equal(venue(after, 'Aave').availableCents, venue(before, 'Aave').availableCents);
    // Apple alone now covers the debt, so NVIDIA alone can no longer liquidate it.
    assert.deepEqual(venue(after, 'Aave').liquidationPrices.find((p) => p.asset === 'NVDAc'), { asset: 'NVDAc', priceCents: null, unreachable: true });
  });

  it('new bitcoin adds room in proportion', () => {
    const { before, after } = run([{ kind: 'deposit', asset: 'cbBTC', raw: 1_000_000n, source: 'new' }]);
    const was = BigInt(line(before, 'cbBTC').capacityCents!);
    const now = BigInt(line(after, 'cbBTC').capacityCents!);
    // 0.022 against 0.012 of the same price: 22/12 of the room, within a cent of rounding.
    assert.ok(now * 12n - was * 22n <= 22n && was * 22n - now * 12n <= 22n);
  });
});

describe('what a scenario refuses', () => {
  const refused = (edits: ScenarioEditV1[], i: MirrorInput = input()) => {
    const outcome = scenarioV1(i, edits);
    assert.equal(outcome.ok, false);
    return outcome.ok ? null : outcome.reason;
  };

  it('a price that was not read', () => {
    const i = input();
    i.snapshot.aave!.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === 'NVDAc')!.price = reverted();
    assert.equal(refused([{ kind: 'price', asset: 'NVDAc', changeBps: -3000 }], i), 'unread');
  });

  it('a fall of 100% or more, and amounts of zero', () => {
    assert.equal(refused([{ kind: 'price', asset: 'NVDAc', changeBps: -10_000 }]), 'out_of_range');
    assert.equal(refused([{ kind: 'borrow', venue: 'aave-v4', usdcAtomic: 0n }]), 'out_of_range');
  });

  it('repaying a loan that does not exist, and borrowing where nothing is pledged', () => {
    assert.equal(refused([{ kind: 'repay', venue: 'morpho:cbBTC', usdcAtomic: 'all' }]), 'no_debt');
    assert.equal(refused([{ kind: 'borrow', venue: 'morpho:cbBTC', usdcAtomic: 10_000_000n }]), 'no_collateral');
  });

  it('pledging more than the wallet holds', () => {
    assert.equal(refused([{ kind: 'deposit', asset: 'TSLAc', raw: 90_000_000n, source: 'wallet' }]), 'exceeds_wallet');
  });

  it('leaves the reading it was given untouched', () => {
    const i = input();
    const debt = i.snapshot.aave!.usdcDebt;
    run([{ kind: 'borrow', venue: 'aave-v4', usdcAtomic: 100_000_000n }], i);
    assert.deepEqual(i.snapshot.aave!.usdcDebt, debt);
  });
});
