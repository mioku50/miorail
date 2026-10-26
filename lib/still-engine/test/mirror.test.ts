import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { CalendarRead } from '../src/calendar.js';
import { computeMirror } from '../src/mirror.js';
import type { MirrorReport } from '../src/report.js';
import { EXAMPLE, SATURDAY, SUNDAY, WEEKDAY, calendar, ok, reverted, snapshot, universe } from './fixtures.js';
import { assertMatches } from './matches.js';

const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
const run = (s = snapshot(EXAMPLE), dates: CalendarRead = calendar(), u = universe()): MirrorReport =>
  computeMirror({ universe: u, snapshot: s, calendar: dates, subject, assembledAt: new Date('2026-10-21T15:00:01Z') });
const line = (r: MirrorReport, asset: string) => r.assets.find((l) => l.asset === asset)!;
const venue = (r: MirrorReport, label: string) => r.venues.find((v) => v.label.includes(label))!;

describe('the example portfolio of docs/DESIGN.md', () => {
  // Hand arithmetic, every line rounded down to the cent:
  //   NVIDIA  4.2 × $211.907 × 70% × ½  = $311.5032  → $311.50
  //   Apple   1.5 × $346.25  × 78% × ½  = $202.5562  → $202.55
  //   Tesla   0.8 × $370.80  × 65% × ½  = $96.408    → $96.40
  //   Bitcoin 0.012 × $80,300.25 × 86% × ½ = $414.3492 → $414.34
  // The design drew $311.50, $202.56, $96.41 and $414.35 with ordinary rounding; Still rounds
  // what it lends down, so its totals sit up to 3 cents lower than the pictures.
  it('lends at half the protocol factor on a weekday', () => {
    const r = run();
    assert.equal(line(r, 'NVDAc').capacityCents, '31150');
    assert.equal(line(r, 'AAPLc').capacityCents, '20255');
    assert.equal(line(r, 'TSLAc').capacityCents, '9640');
    assert.equal(line(r, 'cbBTC').capacityCents, '41434');
    assert.equal(line(r, 'NVDAc').stillFactorBps, 3500);
    assert.equal(line(r, 'cbBTC').stillFactorBps, 4300);
  });

  it('subtracts the debt from the venue that holds it, and adds the venues', () => {
    const r = run();
    const aave = venue(r, 'Aave');
    assert.equal(aave.capacityCents, '61045');
    assert.equal(aave.debtCents, '24017');
    assert.equal(aave.availableCents, '37028');
    assert.deepEqual(aave.deductions, { loansCents: '24017', venueLimitCents: '0' });
    assert.equal(venue(r, 'cbBTC').availableCents, '41434');
    assert.deepEqual(r.headline, { state: 'funded', availableCents: '78462', complete: true, reason: null, weekdayAvailableCents: null });
  });

  it('a new wallet holding the same assets with no debt', () => {
    const r = run(snapshot({ wallet: { ...EXAMPLE.wallet, NVDAc: 420_000_000n } }));
    assert.equal(r.headline.availableCents, '102479'); // $1,024.79
  });

  it('counts stocks at 40% of the factor during the weekend window and says what a weekday would give', () => {
    const r = run(snapshot(EXAMPLE, SATURDAY));
    assert.equal(r.terms.weekend.active, true);
    assert.equal(line(r, 'NVDAc').stillFactorBps, 2800);
    assert.equal(line(r, 'NVDAc').capacityCents, '24920'); // 890.0094 × 28% = 249.2026
    assert.equal(line(r, 'AAPLc').capacityCents, '16204'); // 519.375 × 31.2% = 162.045
    assert.equal(line(r, 'TSLAc').capacityCents, '7712'); // 296.64 × 26% = 77.1264
    assert.equal(line(r, 'cbBTC').capacityCents, '41434'); // bitcoin keeps weekday terms
    assert.equal(r.headline.availableCents, '66253'); // (48,836 − 24,017) + 41,434
    assert.equal(r.headline.weekdayAvailableCents, '78462');
  });

  it('states safety the way the design does: margin, state and a price', () => {
    const r = run();
    const aave = venue(r, 'Aave');
    // HF = 3.4 × 211.907 × 70% / 240.17 = 2.09992; margin = 1 − 1/HF = 52.38%.
    assertMatches(aave.safety, { marginBps: 5237, state: 'calm', source: 'computed' });
    // 240.17 / (3.4 × 70%) = $100.9118 per share, rounded up against the borrower.
    assert.deepEqual(aave.liquidationPrices, [{ asset: 'NVDAc', priceCents: '10092', unreachable: false }]);
  });

  it('takes the protocol health factor when the protocol answers', () => {
    const s = snapshot(EXAMPLE);
    s.aave!.account = ok({ healthFactor: 1_500_000_000_000_000_000n, borrowCount: 1n });
    const aave = venue(run(s), 'Aave');
    assertMatches(aave.safety, { marginBps: 3333, state: 'watch', source: 'protocol' });
  });

  it('reports the venue rates and what the venue can lend', () => {
    const aave = venue(run(), 'Aave');
    assert.equal(aave.borrowRateBps, 366); // 3.6585% a year, rounded up
    assert.equal(aave.liquidityCents, '109645815'); // $1,096,458.15
  });
});

describe('absences stay distinct', () => {
  it('a wallet with nothing reads "none", complete, with no rows', () => {
    const r = run(snapshot({}));
    assert.deepEqual(r.assets, []);
    assert.deepEqual(r.venues, []);
    assertMatches(r.headline, { state: 'none', availableCents: '0', complete: true, reason: 'no_eligible_assets' });
  });

  it('a failed balance read is never a zero: the line stays and the headline becomes a floor', () => {
    const s = snapshot(EXAMPLE);
    s.balances.set('0xb200000000000000000000c2e324d24d7eecd1fb', reverted()); // AAPLc
    const r = run(s);
    const apple = line(r, 'AAPLc');
    assert.equal(apple.wallet, null);
    assert.ok(apple.failed.includes('AAPLc wallet balance'));
    assert.equal(r.headline.complete, false);
    assert.equal(r.headline.state, 'funded');
    // Apple counts as nothing, so the amount is what can be proven: 37,028 − 20,255 + 41,434.
    assert.equal(r.headline.availableCents, String(37_028 - 20_255 + 41_434));
    assert.ok(r.coverage.failed.some((item) => isDeepStrictEqual(item, { what: 'AAPLc wallet balance', owner: 'us' })));
  });

  it('an unreadable debt makes the venue unknown instead of guessing', () => {
    const s = snapshot(EXAMPLE);
    s.aave!.usdcDebt = reverted();
    const r = run(s);
    assert.equal(venue(r, 'Aave').availableCents, null);
    assert.equal(r.headline.complete, false);
    assert.equal(r.headline.availableCents, '41434'); // only bitcoin is proven
  });

  it('nothing readable at all is unknown, not none', () => {
    const s = snapshot(EXAMPLE);
    s.aave!.usdcDebt = reverted();
    s.morpho.get('cbBTC')!.price = reverted();
    s.morpho.get('cbBTC')!.market = reverted();
    const r = run(s);
    assert.equal(r.headline.state, 'unknown');
    assert.equal(r.headline.availableCents, null);
  });

  it('a loan that already uses the limit reads "none" with its reason, and its rows still add up', () => {
    const r = run(snapshot({ pledged: { NVDAc: 340_000_000n }, aaveDebt: 300_000_000n }));
    assertMatches(r.headline, { state: 'none', availableCents: '0', reason: 'limit_in_use' });
    // 3.4 × 211.907 × 35% = 252.1693 → $252.16: the $300 loan uses all of it, and only that is deducted.
    assertMatches(venue(r, 'Aave'), { capacityCents: '25216', debtCents: '30000', deductions: { loansCents: '25216', venueLimitCents: '0' } });
  });

  it('every venue adds up: capacity − loans − venue limit = available', () => {
    for (const s of [snapshot(EXAMPLE), snapshot(EXAMPLE, SATURDAY), snapshot({ pledged: { NVDAc: 340_000_000n }, aaveDebt: 300_000_000n })]) {
      for (const v of run(s).venues) {
        assert.equal(BigInt(v.capacityCents!) - BigInt(v.deductions.loansCents!) - BigInt(v.deductions.venueLimitCents!), BigInt(v.availableCents!));
      }
    }
  });

  it('under a dollar is dust, not funded and not zero', () => {
    const r = run(snapshot({ wallet: { NVDAc: 1_000_000n } })); // 0.01 NVDA → $0.74
    assertMatches(r.headline, { state: 'dust', availableCents: '74' });
  });
});

describe('limits from the venue and the issuer', () => {
  it('a paused reserve adds nothing and says why', () => {
    const s = snapshot(EXAMPLE);
    const nvda = s.aave!.reserves.find((x) => x.info.role.kind === 'stock' && x.info.role.asset.id === 'NVDAc')!;
    nvda.config = ok({ paused: true, frozen: false, borrowable: false });
    const r = run(s);
    assert.deepEqual(line(r, 'NVDAc').limits, ['reserve_paused']);
    assert.equal(line(r, 'NVDAc').capacityCents, '0');
    assert.equal(venue(r, 'Aave').availableCents, String(20_255 + 9_640 - 24_017));
  });

  it('wallet tokens count only up to the room under the collateral cap', () => {
    const s = snapshot(EXAMPLE);
    const tsla = s.aave!.reserves.find((x) => x.info.role.kind === 'stock' && x.info.role.asset.id === 'TSLAc')!;
    tsla.spokeConfig = ok({ addCap: 1_000n, drawCap: 0n, active: true, halted: false });
    tsla.spokeAdded = ok(1_000n * 10n ** 8n - 40_000_000n); // room for 0.4 TSLAc of the 0.8 held
    const r = run(s);
    assert.deepEqual(line(r, 'TSLAc').limits, ['supply_cap']);
    assert.equal(line(r, 'TSLAc').capacityCents, '4820'); // 0.4 × 370.80 × 32.5% = 48.204
  });

  it('Coinbase marking a token paused closes it', () => {
    const s = snapshot(EXAMPLE);
    s.coinbase.set('AAPLc', ok({ multiplier: 10n ** 18n, paused: true }));
    assert.deepEqual(line(run(s), 'AAPLc').limits, ['issuer_paused']);
  });

  it('never lends more than the venue holds, and says how much that held back', () => {
    const s = snapshot(EXAMPLE);
    s.aave!.usdcLiquidity = ok(100_000_000n); // $100 left in the hub
    const aave = venue(run(s), 'Aave');
    assert.equal(aave.availableCents, '10000');
    assert.deepEqual(aave.deductions, { loansCents: '24017', venueLimitCents: String(61_045 - 24_017 - 10_000) });
  });

  it('keeps 0.0005 ETH for network fees and ignores a wallet that holds only gas money', () => {
    assert.deepEqual(run(snapshot({ wallet: { ETH: 400_000_000_000_000n } })).assets, []);
    const r = run(snapshot({ wallet: { ETH: 1_500_000_000_000_000_000n } }));
    const eth = line(r, 'ETH');
    assert.deepEqual(eth.limits, ['gas_reserve']);
    // (1.5 − 0.0005) × $2,330.25 × 43% = $1,502.5102
    assert.equal(eth.capacityCents, '150251');
  });
});

describe('Morpho debt', () => {
  it('adds interest since the last update before stating a debt', () => {
    const position = { cbBTC: { collateral: 10_000_000n, borrowShares: 1_000_000_000_000_000n } };
    const s = snapshot({ morpho: position });
    const market = s.morpho.get('cbBTC')!;
    if (!market.market.ok) throw new Error('fixture');
    market.market = ok({ ...market.market.value, lastUpdate: WEEKDAY - 86_400n }); // a day without updates
    const accrued = BigInt(venue(run(s), 'cbBTC').debtCents!);
    const fresh = BigInt(venue(run(snapshot({ morpho: position })), 'cbBTC').debtCents!);
    // 1e15 shares at 1.1255897 assets per 1e6 shares owe $1,125.5897, rounded up to $1,125.59;
    // a day at 5.25% a year adds about $0.16.
    assert.equal(fresh, 112_559n);
    assert.ok((accrued - fresh) >= 15n);
    assert.ok((accrued - fresh) <= 17n);
  });
});

describe('earnings reports', () => {
  it('counts a stock at 40% from midnight the day before its report to 8 PM the day after', () => {
    // Wednesday 11:00 New York, NVIDIA reports Thursday: its window opened at Wednesday 00:00.
    const r = run(snapshot(EXAMPLE), calendar({ NVDAc: ['2026-10-22'] }));
    assertMatches(line(r, 'NVDAc'), {
      stillFactorBps: 2800,
      capacityCents: '24920', // 890.0094 × 28% = 249.2026
      earnings: { source: 'calendar', reportDate: '2026-10-22', window: { startsAt: '2026-10-21T04:00:00.000Z', endsAt: '2026-10-24T00:00:00.000Z' }, lowered: true },
    });
    assertMatches(line(r, 'AAPLc'), { stillFactorBps: 3900, capacityCents: '20255', earnings: { reportDate: null, window: null, lowered: false } });
    assert.equal(line(r, 'cbBTC').earnings, null);
    // (24,920 + 20,255 + 9,640 − 24,017) + 41,434
    assert.deepEqual(r.headline, { state: 'funded', availableCents: '72232', complete: true, reason: null, weekdayAvailableCents: null });
    assert.deepEqual(r.terms.earnings, { stockShareBps: 4000, calendarReadAt: '2026-10-21T14:00:00.000Z' });
  });

  it('names the next report without lowering anything before its window opens', () => {
    const r = run(snapshot(EXAMPLE), calendar({ NVDAc: ['2026-10-28'] }));
    assertMatches(line(r, 'NVDAc'), {
      stillFactorBps: 3500,
      capacityCents: '31150',
      earnings: { reportDate: '2026-10-28', window: { startsAt: '2026-10-27T04:00:00.000Z', endsAt: '2026-10-30T00:00:00.000Z' }, lowered: false },
    });
  });

  it('an unread calendar lowers every stock, says so, and turns the amount into a floor', () => {
    const r = run(snapshot(EXAMPLE), { ok: false });
    for (const asset of ['NVDAc', 'AAPLc', 'TSLAc']) {
      assert.deepEqual(line(r, asset).earnings, { source: 'unread', reportDate: null, window: null, lowered: true });
      assert.deepEqual(line(r, asset).failed, ['Earnings calendar (Aave API)']);
    }
    assert.deepEqual(r.coverage.failed, [{ what: 'Earnings calendar (Aave API)', owner: 'us' }]);
    // The weekend numbers: every stock at 40%, bitcoin untouched.
    assertMatches(r.headline, { state: 'funded', availableCents: '66253', complete: false });
    assert.equal(r.terms.earnings.calendarReadAt, null);
  });

  it('a stock the calendar left out is unread on its own; the rest keep their terms', () => {
    const r = run(snapshot(EXAMPLE), calendar({}, ['NVDAc']));
    assertMatches(line(r, 'NVDAc'), { stillFactorBps: 2800, failed: ['NVDAc earnings date'], earnings: { source: 'unread', lowered: true } });
    assertMatches(line(r, 'AAPLc'), { stillFactorBps: 3900, failed: [] });
    assert.equal(r.headline.complete, false);
  });

  it('a wallet without stocks does not depend on the calendar', () => {
    const r = run(snapshot({ wallet: { cbBTC: 1_200_000n } }), { ok: false });
    assert.deepEqual(r.coverage.failed, []);
    assertMatches(r.headline, { availableCents: '41434', complete: true });
  });

  it('keeps the earnings rate in the weekday comparison, and never stacks it with the weekend', () => {
    // Sunday 11:00 New York; Apple reports Monday, so its window opened at Sunday 00:00.
    const r = run(snapshot(EXAMPLE, SUNDAY), calendar({ AAPLc: ['2026-10-26'] }));
    assert.equal(r.terms.weekend.active, true);
    assertMatches(line(r, 'AAPLc'), { stillFactorBps: 3120, earnings: { lowered: true } });
    assert.equal(r.headline.availableCents, '66253');
    // On weekday terms NVIDIA and Tesla return to 50%, Apple stays at 40%: (31,150 + 16,204 + 9,640 − 24,017) + 41,434.
    assert.equal(r.headline.weekdayAvailableCents, '74411');
  });

  it('the day after a report still counts at the earnings rate until 8 PM New York', () => {
    const thursdayEvening = BigInt(Date.parse('2026-10-22T23:59:00Z') / 1000); // 19:59 EDT
    const r = run(snapshot(EXAMPLE, thursdayEvening), calendar({ NVDAc: ['2026-10-21'] }));
    assertMatches(line(r, 'NVDAc').earnings, { reportDate: '2026-10-21', lowered: true });
    const later = run(snapshot(EXAMPLE, thursdayEvening + 60n), calendar({ NVDAc: ['2026-10-21'] }));
    assert.deepEqual(line(later, 'NVDAc').earnings, { source: 'calendar', reportDate: null, window: null, lowered: false });
  });
});
