import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MirrorInput } from '../src/mirror.js';
import { marketOnlyInputV1, stillLoanQuoteV1, type StillLoanAtV1 } from '../src/quote.js';
import { healthFactorTextV1 } from '../src/scenario.js';
import { EXAMPLE, SATURDAY, calendar, ok, snapshot, universe, type Holdings } from './fixtures.js';

const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
const input = (h: Holdings = {}, timestamp?: bigint): MirrorInput => ({
  universe: universe(),
  snapshot: snapshot(h, timestamp),
  calendar: calendar(),
  subject,
  assembledAt: new Date('2026-10-21T15:00:01Z'),
});
const TEN_NVDA = 1_000_000_000n; // 10 tokens, 8 decimals
const USDC = (dollars: number) => BigInt(Math.round(dollars * 1e6));

function computed(at: StillLoanAtV1 | null) {
  assert.ok(at && at.outcome === 'computed', `expected a computed loan, got ${JSON.stringify(at)}`);
  return at.figures;
}

describe('a Still loan quote, with no wallet', () => {
  it('10 NVDAc: Still lends half of what Aave would, and the loan at that limit stands 50% from liquidation', () => {
    const quote = stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null });
    assert.equal(quote.venue.label, 'Aave V4 · Coinbase Stocks');
    assert.equal(quote.line?.priceCents, '21190'); // $211.907, rounded down
    assert.equal(quote.line?.protocolFactorBps, 7000);
    assert.equal(quote.line?.stillFactorBps, 3500);
    // 10 × $211.907 × 35% = $741.6745; Aave's own 70% = $1,483.349.
    assert.equal(quote.stillLimitCents, '74167');
    assert.equal(quote.protocolLimitCents, '148334');
    assert.equal(quote.availableNowCents, '74167');
    assert.equal(quote.newLoans, 'open');
    assert.deepEqual(quote.closedBecause, []);
    const atLimit = computed(quote.atStillLimit);
    assert.equal(atLimit.borrowAtomic, '741670000');
    assert.equal(healthFactorTextV1(atLimit.healthFactor), '2.00');
    assert.equal(atLimit.marginBps, 5000);
    assert.equal(atLimit.state, 'calm');
    // $741.67 ÷ (10 × 70%) = $105.9529, rounded up.
    assert.equal(atLimit.liquidationPriceCents, '10596');
    assert.equal(atLimit.borrowRateBps, 366);
    assert.equal(quote.requested, null);
  });

  it('a loan asked about is computed at that size, and says whether it is inside Still’s limit', () => {
    const inside = stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: USDC(500) });
    assert.equal(inside.requested?.withinStillLimit, true);
    const figures = computed(inside.requested);
    assert.equal(healthFactorTextV1(figures.healthFactor), '2.96'); // $1,483.349 ÷ $500
    assert.equal(figures.liquidationPriceCents, '7143'); // $500 ÷ 7, rounded up

    // Above Still's limit and inside what Aave would lend: computed, and said to be outside the limit.
    const outside = stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: USDC(1_000) });
    assert.equal(outside.requested?.withinStillLimit, false);
    assert.equal(computed(outside.requested).state, 'watch'); // 1.48: 32.6% from liquidation
  });

  it('the wallet that was read changes nothing: its tokens, collateral and debt are set aside', () => {
    const ask = { asset: 'NVDAc' as const, raw: TEN_NVDA, borrowAtomic: USDC(500) };
    // EXAMPLE holds 4.2 NVDAc, 3.4 of them pledged, and owes $240.17 on Aave.
    assert.deepEqual(stillLoanQuoteV1(input(EXAMPLE), ask), stillLoanQuoteV1(input(), ask));
    const empty = marketOnlyInputV1(input(EXAMPLE));
    assert.equal(empty.subject.address, '0x0000000000000000000000000000000000000000');
    assert.ok([...empty.snapshot.balances.values()].every((balance) => balance.ok && balance.value === 0n));
    assert.deepEqual(empty.snapshot.aave?.usdcDebt, ok(0n));
    assert.ok(empty.snapshot.aave?.reserves.every((reserve) => reserve.supplied.ok && reserve.supplied.value === 0n));
  });

  it('crypto is quoted on its Morpho market, at Still’s half of the market’s LLTV', () => {
    const quote = stillLoanQuoteV1(input(), { asset: 'cbBTC', raw: 1_000_000n, borrowAtomic: null }); // 0.01 cbBTC
    assert.equal(quote.venue.label, 'Morpho · cbBTC/USDC');
    // 0.01 × $80,300.25 × 86% = $690.58; Still 50% of that = $345.29.
    assert.equal(quote.protocolLimitCents, '69058');
    assert.equal(quote.stillLimitCents, '34529');
    assert.equal(computed(quote.atStillLimit).marginBps, 5000);
  });

  it('a market with little left to lend bounds what is available now, and a larger loan is refused for it', () => {
    const quote = stillLoanQuoteV1(input(), { asset: 'PAXG', raw: 10n * 10n ** 18n, borrowAtomic: USDC(5_000) });
    assert.equal(quote.stillLimitCents, '1564466'); // 10 × $4,063.55 × 77% × 50%
    assert.equal(quote.availableNowCents, '188962'); // the market's $1,889.62
    assert.equal(computed(quote.atStillLimit).borrowAtomic, '1889620000');
    assert.deepEqual(
      { outcome: quote.requested?.outcome, reason: quote.requested?.outcome === 'refused' ? quote.requested.reason : null },
      { outcome: 'refused', reason: 'exceeds_liquidity' },
    );
    assert.equal(quote.requested?.withinStillLimit, true);
  });

  it('while Wall Street is closed a stock counts at 40% of Aave’s factor, beside the weekday figure', () => {
    const quote = stillLoanQuoteV1(input({}, SATURDAY), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null });
    assert.equal(quote.terms.weekend.active, true);
    assert.equal(quote.line?.stillFactorBps, 2800);
    assert.equal(quote.stillLimitCents, '59333'); // $2,119.07 × 28%
    assert.equal(quote.weekdayAvailableCents, '74167');
    assert.equal(quote.protocolLimitCents, '148334');
    assert.equal(computed(quote.atStillLimit).marginBps, 6000);
  });

  it('a paused reserve closes new loans and says why; nothing is quoted against it', () => {
    const paused = input();
    const reserve = paused.snapshot.aave!.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === 'NVDAc')!;
    reserve.config = ok({ paused: true, frozen: false, borrowable: false });
    const quote = stillLoanQuoteV1(paused, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: USDC(100) });
    assert.equal(quote.newLoans, 'closed');
    assert.deepEqual(quote.closedBecause, ['reserve_paused']);
    assert.equal(quote.stillLimitCents, '0');
    assert.equal(quote.protocolLimitCents, '0');
    assert.equal(quote.atStillLimit, null);
  });

  it('Aave’s collateral cap counts only the room it leaves, and the loans pledge only that', () => {
    const capped = input();
    const reserve = capped.snapshot.aave!.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === 'NVDAc')!;
    // 1,000 tokens supplied under a cap of 1,005: room for 5 of the 10 asked about.
    reserve.spokeConfig = ok({ addCap: 1_005n, drawCap: 0n, active: true, halted: false });
    const quote = stillLoanQuoteV1(capped, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null });
    assert.equal(quote.pledgeableRaw, 500_000_000n);
    assert.ok(quote.line?.limits.includes('supply_cap'));
    assert.equal(quote.stillLimitCents, '37083'); // 5 × $211.907 × 35%
    assert.equal(quote.protocolLimitCents, '74167');
    assert.equal(computed(quote.atStillLimit).liquidationPriceCents, '10596'); // $370.83 ÷ (5 × 70%) = $105.9514, rounded up
  });

  it('refuses a question it cannot ask: nothing pledged, nothing borrowed', () => {
    assert.throws(() => stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: 0n, borrowAtomic: null }), RangeError);
    assert.throws(() => stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: 0n }), RangeError);
  });
});

describe('a quote is complete only when everything it rests on was read (audit QUOTE-1)', () => {
  it('a complete reading is complete', () => {
    assert.equal(stillLoanQuoteV1(input(), { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null }).complete, true);
    assert.equal(stillLoanQuoteV1(input(), { asset: 'cbBTC', raw: 1_000_000n, borrowAtomic: null }, { collateralHold: null }).complete, true);
  });

  it('a reading with no Aave in it says newLoans open with every limit null, and is not complete', () => {
    const noAave = input();
    noAave.universe = { ...noAave.universe, aave: { ok: false, problem: 'unreadable' } } as typeof noAave.universe;
    const quote = stillLoanQuoteV1(noAave, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null });
    assert.deepEqual([quote.stillLimitCents, quote.availableNowCents, quote.complete], [null, null, false]);
  });

  it('one failed read of ours on the collateral or its venue, or the issuer registry unread, leaves it incomplete', () => {
    const noPrice = input();
    noPrice.snapshot.aave!.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === 'NVDAc')!.price = { ok: false, reason: 'reverted' };
    assert.equal(stillLoanQuoteV1(noPrice, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null }).complete, false);
    const noLiquidity = input();
    noLiquidity.snapshot.aave!.usdcLiquidity = { ok: false, reason: 'reverted' };
    assert.equal(stillLoanQuoteV1(noLiquidity, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null }).complete, false);
    const noRegistry = input();
    noRegistry.snapshot.coinbase.set('NVDAc', { ok: false, reason: 'reverted' });
    assert.equal(stillLoanQuoteV1(noRegistry, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null }).complete, false);
    // Another stock's failure is not this answer's.
    const other = input();
    other.snapshot.aave!.reserves.find((r) => r.info.role.kind === 'stock' && r.info.role.asset.id === 'TSLAc')!.price = { ok: false, reason: 'reverted' };
    assert.equal(stillLoanQuoteV1(other, { asset: 'NVDAc', raw: TEN_NVDA, borrowAtomic: null }).complete, true);
  });

  it('cbBTC or PAXG held by its own contract closes new loans the way a paused reserve does', () => {
    const paused = stillLoanQuoteV1(input(), { asset: 'PAXG', raw: 10n ** 18n, borrowAtomic: USDC(100) }, { collateralHold: 'paused' });
    assert.deepEqual([paused.newLoans, paused.closedBecause, paused.stillLimitCents, paused.availableNowCents, paused.protocolLimitCents, paused.atStillLimit],
      ['closed', ['issuer_paused'], '0', '0', '0', null]);
    const frozen = stillLoanQuoteV1(input(), { asset: 'cbBTC', raw: 1_000_000n, borrowAtomic: null }, { collateralHold: 'venue_frozen' });
    assert.deepEqual([frozen.newLoans, frozen.closedBecause, frozen.complete], ['closed', ['venue_frozen_by_issuer'], true]);
  });
});
