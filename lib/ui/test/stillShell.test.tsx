import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMirror, type CalendarRead } from '@mioagent/still-engine';
import { stillTerms } from '@mioagent/still-engine/terms';
import { formatCents } from '@mioagent/still-engine/format';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import { EXAMPLE, SATURDAY, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import { telegramAlertsViewV1 } from '../src/console/telegramAlertsView';
import { copyOnThisPressV1 } from '../src/console/WalletMcpMiorailCard';
import { STILL_PUBLIC_ORIGIN_V1 } from '../src/stillOrigin';
import {
  agentAnswerV1,
  agentRouteV2,
  agentAmountUnclearV2,
  agentSendRequestV2,
  agentSwapAnswerV2,
  agentSwapRequestV2,
  agentTradeWordsV2,
  assetsNamedInV2,
  assetsViewV1,
  homeViewV1,
  unpublishedNoteV1,
  mobileLayoutV1,
  skyCaptionV1,
  skyEarningsFromTermsV1,
  skyStateV1,
  stillTabForPathV1,
  StillAgent,
  StillAssets,
  StillDoors,
  StillRailDoorsContext,
  StillFrame,
  StillHomeSignedIn,
  StillLoanAlertsOffer,
  StillHomeSignedOut,
  StillMore,
  StillMobile,
  StillAssistants,
  ThinkingOrbs,
  type MobileHoldingV1,
} from '../src/still';

void React;

// The engine's own example portfolio: 4.2 NVDAc (3.4 pledged on Aave), 1.5 AAPLc, 0.8 TSLAc,
// 0.012 cbBTC and $240.17 owed. The shell shows exactly what the engine computed.
const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
function report(timestamp?: bigint, earningsCalendar = calendar()): MirrorReport {
  const s = timestamp === undefined ? snapshot(EXAMPLE) : snapshot(EXAMPLE, timestamp);
  return JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: s, calendar: earningsCalendar, subject, assembledAt: new Date('2026-10-21T15:00:01Z') })));
}
const WEDNESDAY = new Date('2026-10-21T15:00:00Z'); // 11:00 in New York, the session open
const SATURDAY_AT = new Date(Number(SATURDAY) * 1000);

const dividends: DividendWalletResponseV1 = {
  schemaVersion: 'dividend-wallet/v1',
  generatedAt: '2026-10-21T15:00:00Z',
  blockNumber: 53_000_000,
  receivedUsd: '0.52',
  passThroughPercent: '49.5',
  holdings: [
    {
      underlyingKey: 'security:isin:US0378331005', symbol: 'AAPL', company: 'Apple', tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb', tokenSymbol: 'AAPLc', tokens: '1.5',
      upcoming: [{ state: 'estimated', reason: null, amountPerShare: '0.27', payDate: '2026-11-12', payDateApproximate: true, kind: 'estimate', tokens: '1.5', shares: '0.0006', usd: '0.19', at: null }],
      received: [],
    },
  ],
};

describe('the visual sky and separate US market state', () => {
  it('uses Berlin dusk while the US market is still open and names the full limits', () => {
    const sky = skyStateV1({ now: new Date('2026-10-26T18:05:00Z'), earnings: [] }); // Mon 2:05 PM
    assert.equal(sky.phase, 'dusk');
    assert.equal(sky.clock, 'MON 19:05');
    assert.equal(sky.marketClock, 'MON 2:05 PM');
    assert.equal(sky.marketPhase, 'open');
    assert.equal(sky.sunShare, null);
    assert.deepEqual(skyCaptionV1(sky), { headline: 'Market open · full limits', detail: null });
  });

  it('can be visually day while Wall Street is closed, and says until when', () => {
    const saturday = skyStateV1({ now: new Date('2026-10-31T15:00:00Z') });
    assert.equal(saturday.phase, 'day');
    assert.equal(saturday.marketPhase, 'closed');
    assert.equal(skyCaptionV1(saturday).headline, 'Wall Street is closed. Base is open.');
    assert.match(skyCaptionV1(saturday).detail!, /Until Sun 8 PM New York, new loans against stocks count at 40%/);
    assert.equal(skyStateV1({ now: new Date('2026-11-26T15:00:00Z') }).marketPhase, 'closed'); // Thanksgiving, a Thursday
  });

  it('keeps before-open and after-hours financial captions independent of the visual phase', () => {
    assert.equal(skyCaptionV1(skyStateV1({ now: new Date('2026-10-27T12:00:00Z'), earnings: [] })).headline, 'Before the open · full limits');
    assert.equal(skyCaptionV1(skyStateV1({ now: new Date('2026-10-28T02:00:00Z'), earnings: [] })).headline, 'After hours · full limits');
  });

  it('keeps the early US close separate from the Berlin sun and draws reviewed earnings clouds', () => {
    const friday = skyStateV1({ now: new Date('2026-11-27T16:15:00Z') }); // 11:15, the day after Thanksgiving closes at 13:00
    assert.equal(friday.phase, 'day');
    assert.ok(Math.abs(friday.sunShare! - 615 / 720) < 1e-9);
    assert.equal(friday.session?.closeAt, '2026-11-27T18:00:00.000Z');
    const reporting = skyStateV1({
      now: new Date('2026-10-28T15:00:00Z'),
      earnings: [{ asset: 'GOOGLc', name: 'Alphabet', startsAt: '2026-10-27T04:00:00.000Z', endsAt: '2026-10-30T00:00:00.000Z' }],
    });
    assert.equal(reporting.clouds.length, 1);
    assert.deepEqual(skyCaptionV1(reporting), {
      headline: 'Market open · earnings limits',
      detail: 'Alphabet reports now: new loans against it count at 40% of the protocol’s limit until Thu 8 PM New York.',
    });
  });
});

describe('the sky and Still’s terms', () => {
  const MONDAY = new Date('2026-10-26T18:05:00Z');
  it('takes its clouds from the terms, and names no limits before the terms were read', () => {
    const read: CalendarRead = { ok: true, calendar: { readAt: MONDAY, dates: new Map([['NVDAc', ['2026-10-26']], ['TSLAc', []]]) } };
    const { earnings, unread, calendarRead } = skyEarningsFromTermsV1(stillTerms(read, MONDAY));
    assert.deepEqual(earnings.map((e) => e.name), ['NVIDIA']);
    assert.deepEqual(unread, ['Apple', 'Amazon', 'Alphabet', 'Meta', 'Microsoft', 'SpaceX']);
    const sky = skyStateV1({ now: MONDAY, earnings, unread, calendarRead });
    assert.equal(sky.clouds.length, 1);
    assert.equal(skyCaptionV1(sky).headline, 'Market open · earnings limits');
    // The calendar answered and left them out: it lists no date for them, which is not a failed read.
    assert.match(skyCaptionV1(sky).detail!, /NVIDIA reports now: .* Aave’s earnings calendar lists no report date for 6 stocks yet: new loans against them count at 40%/);
    assert.deepEqual(skyCaptionV1(skyStateV1({ now: MONDAY })), { headline: 'Market open', detail: null });
  });

  it('names the stock Aave’s calendar lists no date for, as SPCXc on 2026-11-05', () => {
    assert.equal(
      skyCaptionV1(skyStateV1({ now: MONDAY, earnings: [], unread: ['SpaceX'], calendarRead: true })).detail,
      'Aave’s earnings calendar lists no report date for SpaceX yet: new loans against it count at 40% of the protocol’s limit until it does.',
    );
    const unreadCalendar = skyEarningsFromTermsV1(stillTerms({ ok: false }, MONDAY));
    assert.equal(unreadCalendar.calendarRead, false);
  });

  it('says which stock an unread calendar lowers, when it is a few', () => {
    assert.equal(
      skyCaptionV1(skyStateV1({ now: MONDAY, earnings: [], unread: ['Apple'] })).detail,
      'The earnings calendar could not be read just now: new loans against Apple count at 40% of the protocol’s limit until it is.',
    );
  });
});

describe('Home', () => {
  it('names a date the protocol does not publish apart from a read that failed', () => {
    const left = homeViewV1({ report: report(undefined, calendar({}, ['NVDAc'])), sky: skyStateV1({ now: WEDNESDAY }), dividends });
    assert.deepEqual(left.unpublished, ['NVDAc earnings date']);
    assert.deepEqual(left.failed, []);
    const unread = homeViewV1({ report: report(undefined, { ok: false }), sky: skyStateV1({ now: WEDNESDAY }), dividends });
    assert.deepEqual(unread.failed, ['Earnings calendar (Aave API)']);
    assert.deepEqual(unread.unpublished, []);
    // Audit UI-1 (2026-11-10): a date nobody published is counted by Still's own fixed rule, so the amount
    // is what Still gives now. It was called a floor, and read "at least" on every page.
    assert.equal(left.available?.atLeast, false);
    assert.equal(left.unpublishedNote,
      'Not published yet: NVDAc earnings date. Still counts that stock at 40% of the protocol’s own limit until Aave publishes the date, and the amount here is worked out that way.');
    // A read of ours that failed still leaves a floor, and says nothing about publishing.
    assert.equal(unread.available?.atLeast, true);
    assert.equal(unread.unpublishedNote, null);
    // With the loan at that limit, the sentence says so instead of leaving "$0.00" to be guessed at.
    assert.equal(unpublishedNoteV1({ terms: left.unpublished.length ? report(undefined, calendar({}, ['NVDAc'])).terms : (undefined as never), headline: { reason: 'limit_in_use' } as never }, ['SPCXc earnings date']),
      'Not published yet: SPCXc earnings date. Still counts that stock at 40% of the protocol’s own limit until Aave publishes the date; your loan already uses that.');
    assert.match(unpublishedNoteV1({ terms: report().terms, headline: { reason: null } as never }, ['A earnings date', 'B earnings date']) ?? '', /Still counts those stocks at 40%/);
    assert.equal(unpublishedNoteV1({ terms: report().terms, headline: { reason: null } as never }, []), null);
  });

  it('says the loan is in balance, what can be spent and what is owed, from the report alone', () => {
    const view = homeViewV1({ report: report(), sky: skyStateV1({ now: WEDNESDAY }), dividends });
    assert.equal(view.state, 'calm');
    assert.equal(view.stateWord, 'In balance.');
    assert.equal(view.stateLine, 'NVIDIA can fall 52% before the weight wins.');
    assert.deepEqual(view.available, { dollars: '$784', cents: '.62', atLeast: false });
    assert.deepEqual(view.owed, { amount: 'Owed $240.17', detail: '3.66% a year on Aave' });
    assert.deepEqual(view.mobile.holdings.map((h) => h.label), ['BTC', 'NVDA', 'AAPL', 'TSLA']);
    assert.deepEqual(view.comingUp.map((c) => [c.when, c.text]), [
      ['FRI 8 PM', 'Weekend limits begin.'],
      ['≈ NOV 12', 'Apple dividend · ≈ $0.19 as more AAPLc, an estimate'],
    ]);
  });

  it('renders the numbers it was given and nothing it was not', () => {
    const sky = skyStateV1({ now: WEDNESDAY });
    const r = report();
    const html = renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {} }} />);
    assert.match(html, /In balance\./);
    assert.match(html, /aria-label="\$784\.62 modelled borrowing room"/);
    assert.match(html, /Live borrowing limit/);
    assert.match(html, /Not checked/);
    assert.doesNotMatch(html, /Available to spend/);
    assert.match(html, /Owed \$240\.17/);
    assert.match(html, /role="img"/);
    assert.match(html, /<a[^>]*href="\/assistants"[^>]*>.*Still in your assistant/);
    assert.doesNotMatch(html, /You can borrow|guaranteed|\bSafe\b/i);
  });

  it('shares a wallet’s card by its Still link, saying the card names the wallet', () => {
    const sky = skyStateV1({ now: WEDNESDAY });
    const r = report();
    const html = renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {}, subject: 'example.base.eth' }} />);
    assert.match(html, /Share this wallet’s card:/);
    const card = encodeURIComponent(`${STILL_PUBLIC_ORIGIN_V1}/w/example.base.eth`).replace(/\./g, '\\.');
    assert.match(html, new RegExp(`href="https://x\\.com/intent/tweet\\?text=[^"]*&amp;url=${card}"`));
    assert.match(html, new RegExp(`href="https://farcaster\\.xyz/~/compose\\?text=[^"]*&amp;embeds\\[\\]=${card}"`));
    // The words carry no figure: the card does, at the block it was read.
    assert.doesNotMatch(decodeURIComponent(/intent\/tweet\?text=([^&"]*)/.exec(html)![1]!), /\$\d/);
  });

  it('offers alerts in Telegram in one line, in the state the one view gives', () => {
    const sky = skyStateV1({ now: WEDNESDAY });
    const r = report();
    const telegram = (linked: boolean) => ({
      view: telegramAlertsViewV1({ status: { available: true, linked }, pending: null, busy: null, failed: null, now: WEDNESDAY })!,
      onConnect: () => {},
      onDisconnect: () => {},
    });
    const off = renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {}, telegram: telegram(false) }} />);
    assert.match(off, /Alerts in Telegram/);
    assert.match(off, /Dividends, issuer changes, your watches and your Still loans, in a Telegram chat\./);
    assert.match(off, />Connect<\/button>/);
    const on = renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {}, telegram: telegram(true) }} />);
    assert.match(on, /Telegram alerts are on/);
    assert.match(on, />Disconnect<\/button>/);
    // No bot, no card; and a visitor is never offered it.
    assert.doesNotMatch(renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {}, telegram: null }} />), /Telegram/);
  });

  it('keeps the assistants link available when the wallet could not be read', () => {
    const html = renderToStaticMarkup(<StillHomeSignedIn model={{ sky: skyStateV1({ now: WEDNESDAY }), view: null, reading: null, loading: false, failed: 'unavailable', onRetry: () => {} }} />);
    assert.match(html, /<a[^>]*href="\/assistants"[^>]*>.*Still in your assistant/);
    assert.doesNotMatch(html, /\$\d/);
  });

  it('shows only future known earnings windows, using the page clock even for a cached report', () => {
    const r = report(undefined, calendar({ NVDAc: ['2026-10-29'], AAPLc: ['2026-10-26'] }, ['TSLAc']));
    const now = new Date('2026-10-26T18:05:00Z');
    const sky = skyStateV1({ now });
    const future = homeViewV1({ report: r, sky, dividends }).comingUp.filter((item) => item.icon === 'earnings');
    assert.deepEqual(future, [{
      when: 'WED 12 AM',
      icon: 'earnings',
      text: 'NVIDIA reports Oct 29: new loans against it will count at 40% of the protocol’s limit until Fri 8 PM.',
    }]);
    const atStart = skyStateV1({ now: new Date('2026-10-28T04:00:00Z') });
    assert.equal(homeViewV1({ report: r, sky: atStart }).comingUp.some((item) => item.icon === 'earnings'), false);
    const after = skyStateV1({ now: new Date('2026-10-31T15:00:00Z') });
    assert.equal(homeViewV1({ report: r, sky: after }).comingUp.some((item) => item.icon === 'earnings'), false);
    const unconfirmed = structuredClone(r);
    const nvda = unconfirmed.assets.find((line) => line.asset === 'NVDAc')!;
    nvda.wallet = { raw: '0', decimals: 18 };
    nvda.pledged = null;
    assert.equal(homeViewV1({ report: unconfirmed, sky }).comingUp.some((item) => item.icon === 'earnings'), false,
      'a zero balance and unread collateral do not establish a stock holding');
    // A window two weeks out names its date: "MON 12 AM" read as the coming Monday.
    const far = homeViewV1({ report: r, sky: skyStateV1({ now: new Date('2026-10-14T15:00:00Z') }) }).comingUp.filter((item) => item.icon === 'earnings');
    assert.deepEqual(far.map((item) => [item.when, item.text.split(':')[0]]), [
      ['SUN OCT 25 12 AM', 'Apple reports Oct 26'],
      ['WED OCT 28 12 AM', 'NVIDIA reports Oct 29'],
    ]);
    // An unread calendar must not become a schedule even if stale window fields remain.
    r.assets.find((line) => line.asset === 'NVDAc')!.earnings!.source = 'unread';
    assert.equal(homeViewV1({ report: r, sky }).comingUp.some((item) => item.icon === 'earnings'), false);
  });

  it('signed out, it is the front door: a check for any wallet, the terms in one line, no example numbers', () => {
    const html = renderToStaticMarkup(<StillHomeSignedOut model={{ sky: skyStateV1({ now: WEDNESDAY }), result: null, checking: false, message: null, onCheck: () => {}, signInHref: '/signin' }} />);
    assert.match(html, /Spend without selling\./);
    assert.match(html, /Not offered to US persons/);
    assert.doesNotMatch(html, /\$\d/);
  });
});

describe('the mobile', () => {
  it('keeps the cents in a small borrowing room instead of labelling it zero', () => {
    const html = renderToStaticMarkup(<svg><StillMobile input={{
      holdings: [{ id: 'NVDAc', label: 'NVDA', kind: 'stock', valueCents: 19 }],
      loan: { owedCents: 0, limitCents: 6, weekdayLimitCents: 6 }, state: 'empty',
    }} /></svg>);
    assert.match(html, /model \$0\.06/);
    assert.doesNotMatch(html, /model \$0</);
  });

  it('is area-true: circles against the largest holding, squares against the limit', () => {
    const view = homeViewV1({ report: report(), sky: skyStateV1({ now: WEDNESDAY }) });
    const layout = mobileLayoutV1(view.mobile);
    const [btc, nvda] = layout.shapes;
    const ratio = view.mobile.holdings[1]!.valueCents / view.mobile.holdings[0]!.valueCents;
    assert.ok(Math.abs((nvda!.r / btc!.r) ** 2 - ratio) < 0.01);
    const loan = view.mobile.loan!;
    assert.ok(Math.abs((layout.loan!.side / layout.limit!.side) ** 2 - loan.owedCents / loan.limitCents) < 0.01);
  });

  it('hangs a fifth holding and more as one "+N" shape', () => {
    const layout = mobileLayoutV1({
      holdings: [
        ...[5, 4, 3, 2].map((v, i): MobileHoldingV1 => ({ id: `h${i}`, label: `H${i}`, kind: 'stock', valueCents: v * 100 })),
        { id: 'more', label: '+2', kind: 'more', valueCents: 150 },
      ],
      loan: null,
      state: 'empty',
    });
    assert.equal(layout.shapes.length, 4);
  });
});

describe('Assets', () => {
  it('says what holds up the loan, what is free, and the dividends, as the report and the calendar say', () => {
    const view = assetsViewV1({ report: report(), dividends });
    const nvda = view.rows.find((r) => r.id === 'NVDAc')!;
    assert.equal(nvda.amount, '4.2 NVDAc');
    assert.deepEqual(nvda.lines[0], { strong: '3.4 hold up your Aave loan', text: ' · 0.8 free' });
    const btc = view.rows.find((r) => r.id === 'cbBTC')!;
    assert.equal(btc.lines[0]!.text, 'Modelled room · up to $414.34 on Morpho');
    const apple = view.rows.find((r) => r.id === 'AAPLc')!;
    assert.match(apple.lines.at(-1)!.text, /≈ \$0\.19, if you hold AAPLc when it converts \(an estimate\)/);
    assert.deepEqual(view.loans.map((l) => [l.label, l.owed]), [['Aave V4 · Coinbase Stocks', '$240.17']]);
    assert.equal(view.loans[0]!.safety, 'Prices can fall 52% together before liquidation.');
    assert.deepEqual(view.loans[0]!.liquidation, ['NVIDIA below $100.92, if only it moved']);
    const html = renderToStaticMarkup(<StillAssets model={{ sky: skyStateV1({ now: WEDNESDAY }), view, loading: false, failed: null, onRetry: () => {}, signedIn: true, signInHref: '/signin' }} />);
    assert.match(html, /Loans · 1/);

    const microReport = report();
    const aaveVenue = microReport.venues.find((v) => v.venue === 'aave-v4')!;
    aaveVenue.debtCents = '1';
    aaveVenue.debtAtomic = '2';
    assert.equal(assetsViewV1({ report: microReport }).loans[0]!.owed, '0.000002 USDC');
    assert.equal(homeViewV1({ report: microReport, sky: skyStateV1({ now: WEDNESDAY }) }).owed?.amount, 'Owed 0.000002 USDC');
    // The picture says the same: the engine's round-up to a cent is not a $0.01 debt.
    const microView = homeViewV1({ report: microReport, sky: skyStateV1({ now: WEDNESDAY }) });
    assert.equal(microView.mobile.loan?.owedLabel, '<$0.01');
    assert.equal(homeViewV1({ report: report(), sky: skyStateV1({ now: WEDNESDAY }) }).mobile.loan?.owedLabel, undefined);
  });
});

describe('what the wallet holds, on Assets', () => {
  // 2026-11-03, the operator: «сейчас не понятно что лежит у меня в кошельке»;
  // then, on Assets, so that Home's first screen keeps Spend.
  const sony = { ...dividends.holdings[0]!, underlyingKey: 'security:isin:US8356993076', symbol: 'SONY', company: 'Sony', tokenAddress: `0x${'5'.repeat(40)}`, tokenSymbol: 'SONYc', tokens: '1.250000', upcoming: [] };

  it('lists USDC, ETH and cbBTC, then the stocks by value, with what is pledged said apart', () => {
    const r = report();
    const view = assetsViewV1({ report: r, usdc: { raw: '12345678', decimals: 6 }, dividends });
    assert.equal(view.block, '53,000,000');
    const stocks = r.assets.filter((line) => line.kind === 'stock').sort((a, b) => Number(BigInt(b.valueCents!) - BigInt(a.valueCents!))).map((line) => line.asset);
    assert.deepEqual(view.rows.map((row) => row.id), ['USDC', 'ETH', 'cbBTC', ...stocks]);
    assert.deepEqual(view.rows[0], {
      id: 'USDC', kind: 'cash', name: 'USD Coin', amount: '12.3456 USDC', value: '$12.34',
      lines: [{ text: 'What a loan pays out and Repay takes; Still does not lend against it' }],
      sell: { goal: 'Swap 12.345678 USDC to ETH', href: `/routes?goal=${encodeURIComponent('Swap 12.345678 USDC to ETH')}`, label: 'Swap for ETH on Swap →' },
    });
    // Not held is a measured zero: the report has no line for it, and the list says 0.
    assert.deepEqual(view.rows[1], { id: 'ETH', kind: 'crypto', name: 'Ether', amount: '0 ETH', value: '$0.00', lines: [] });
    assert.deepEqual(view.rows.find((row) => row.id === 'NVDAc')!.lines[0], { strong: '3.4 hold up your Aave loan', text: ' · 0.8 free' });
    // USDC is not a reviewed holding: the count and the reviewed total stay the reviewed set's, and
    // the total at the top adds it (operator, 2026-11-09: a wallet of USDC read $0.00 there).
    const reviewedCents = r.assets.reduce((sum, line) => sum + BigInt(line.valueCents!), BigInt(0));
    assert.equal(view.count, 4);
    assert.equal(view.reviewedTotal, formatCents(reviewedCents));
    assert.equal(view.usdcTotal, '$12.34');
    assert.equal(view.total, formatCents(reviewedCents + BigInt(1234)));
    assert.equal(view.totalNote, `${formatCents(reviewedCents)} reviewed for loans · $12.34 USDC`);
    // Apple is one of Still's reviewed stocks: it is a row, not an "also".
    assert.deepEqual(view.others, []);
  });

  // Re-audit R7, 2026-11-04: USDC is read on its own, and the page named the holdings' block for it.
  it('names the block USDC was read at when it is not the holdings’ one', () => {
    const r = report();
    assert.equal(assetsViewV1({ report: r, usdc: { raw: '1000000', decimals: 6, block: '53000500' } }).usdcBlock, '53,000,500');
    assert.equal(assetsViewV1({ report: r, usdc: { raw: '1000000', decimals: 6, block: '53000000' } }).usdcBlock, null);
    assert.equal(assetsViewV1({ report: r, usdc: 'unread' }).usdcBlock, null);
    const view = assetsViewV1({ report: r, usdc: { raw: '1000000', decimals: 6, block: '53000500' } });
    const html = renderToStaticMarkup(<StillAssets model={{ sky: skyStateV1({ now: WEDNESDAY }), view, loading: false, failed: null, onRetry: () => {}, signedIn: true, signInHref: '/signin' }} />);
    assert.match(html, /Read from Base at block 53,000,000; USDC at block 53,000,500\. ETH includes WETH\./);
  });

  it('says a read that did not answer, and names the other Coinbase stocks the wallet holds', () => {
    const r = report();
    assert.deepEqual(assetsViewV1({ report: r, usdc: 'loading' }).rows[0], { id: 'USDC', kind: 'cash', name: 'USD Coin', amount: '… USDC', value: '…', lines: [] });
    const unread = assetsViewV1({ report: r, usdc: 'unread' }).rows[0]!;
    assert.equal(unread.amount, '— USDC');
    assert.equal(unread.value, null);
    assert.deepEqual(unread.lines, [{ text: 'Not read just now: our failure, not a fact about the wallet' }]);
    // A stock whose balance was not read is never shown as none, and no total is claimed without it.
    const failed = JSON.parse(JSON.stringify(r)) as MirrorReport;
    failed.assets.find((line) => line.asset === 'TSLAc')!.wallet = null;
    const partial = assetsViewV1({ report: failed });
    assert.deepEqual(partial.rows.find((row) => row.id === 'TSLAc'), {
      id: 'TSLAc', kind: 'stock', name: 'Tesla', amount: '— TSLAc', value: null, lines: [{ text: 'Not read just now: our failure, not a fact about the wallet' }],
    });
    assert.equal(partial.total, null);
    assert.equal(partial.count, 3);
    const none = { ...sony, symbol: 'KO', tokenAddress: `0x${'6'.repeat(40)}`, tokenSymbol: 'KOc', tokens: '0' };
    assert.deepEqual(assetsViewV1({ report: r, dividends: { ...dividends, holdings: [...dividends.holdings, sony, none] } }).others, [
      { symbol: 'SONYc', amount: '1.25', href: '/stocks/sony' },
    ]);
  });

  it('sits on Assets; Home reads the modelled room before Spend, and the other two doors sit in the rail on a desktop', () => {
    const sky = skyStateV1({ now: WEDNESDAY });
    const r = report();
    const view = assetsViewV1({ report: r, usdc: { raw: '12345678', decimals: 6 }, dividends: { ...dividends, holdings: [...dividends.holdings, sony] } });
    const assets = renderToStaticMarkup(<StillAssets model={{ sky, view, loading: false, failed: null, onRetry: () => {}, signedIn: true, signInHref: '/signin' }} />);
    assert.match(assets, /<span class="still-dot cash" aria-hidden="true">\$<\/span><div[^>]*><div class="name">USD Coin<\/div><div class="mono amt">12\.3456 USDC<\/div>/);
    assert.match(assets, /<div class="name">Ether<\/div><div class="mono amt">0 ETH<\/div>/);
    assert.match(assets, /Also in the wallet: <a href="\/stocks\/sony">SONYc 1\.25<\/a>\. Each is priced on its stock’s page\./);
    assert.match(assets, /Read from Base at block 53,000,000\. ETH includes WETH\. Prices are the venues’ own oracles at that block; USDC counts at \$1\./);
    const html = renderToStaticMarkup(<StillHomeSignedIn model={{ sky, view: homeViewV1({ report: r, sky }), reading: r.reading, loading: false, failed: null, onRetry: () => {} }} />);
    assert.doesNotMatch(html, /In your wallet|USD Coin/);
    // Under the actions the modelled room comes first, then what a loan could pay for.
    assert.ok(html.indexOf('>Get money<') < html.indexOf('Modelled borrowing room'));
    assert.ok(html.indexOf('Modelled borrowing room') < html.indexOf('Spend with Still'));
    assert.match(html, /<a href="\/spend" class="still-extra is-lead">/);
    // On a phone the assistant and Telegram stay at the foot of Home.
    assert.match(html, /class="still-section still-extras still-home-doors"/);
    const rail = renderToStaticMarkup(
      <StillRailDoorsContext.Provider value={<StillDoors rail />}>
        <StillFrame tab="home" sky={sky}><p>page</p></StillFrame>
      </StillRailDoorsContext.Provider>,
    );
    assert.match(rail, /<nav class="still-nav"[^>]*>.*<div class="still-rail-doors">.*Still in your assistant.*<\/div><div class="still-rail-foot">/);
  });
});

describe('the Agent', () => {
  it('routes a question one way for the page and the server, in English and in Russian', () => {
    const route = (q: string) => agentRouteV2(q);
    assert.deepEqual(route('How much can I spend?'), { route: 'fast', topic: 'borrow' });
    assert.deepEqual(route('Сколько я могу занять?'), { route: 'fast', topic: 'borrow' });
    assert.deepEqual(route('Насколько безопасен мой займ?'), { route: 'fast', topic: 'safety' });
    assert.deepEqual(route('Когда выходные лимиты?'), { route: 'fast', topic: 'closed' });
    assert.deepEqual(route('А когда следующий дивиденд?'), { route: 'fast', topic: 'dividends' });
    for (const q of [
      'Что будет при падении NVDA на 30%?',
      'Что будет с моим займом, если NVIDIA упадёт на 25%?',
      'Почему моя сумма займа уменьшилась?',
      'Как безопаснее уменьшить долг на $100?',
      'What if I repay $100 of my loan?',
      'Что будет, если погасить $100 долга?',
      'What if I borrow $200 more?',
      'How much interest do I pay a month?',
      'What if BTC goes to $60,000?',
      'Сколько стоит мой займ в месяц?',
      'Что будет с займом, если все акции подешевеют на треть?',
      'How much would I owe after paying back $50?',
    ]) {
      assert.equal(route(q).route, 'analysis', q);
    }
    // A command is an action; the same words asked as a what-if are a calculation.
    assert.equal(route('Займи $500 и отправь другу').route, 'action_prep');
    assert.equal(route('Borrow $500 and send it to my friend').route, 'action_prep');
    assert.equal(route('Погаси $100').route, 'action_prep');
    assert.equal(route('Что будет, если погасить $100?').route, 'analysis');
    assert.equal(route('Tell me a joke').route, 'unknown');
    assert.equal(route('привет').route, 'unknown');
    assert.deepEqual(assetsNamedInV2('если nvidia и биткоин упадут'), ['NVDAc', 'cbBTC']);
    // "Ether" is a word, not the inside of "together".
    assert.deepEqual(assetsNamedInV2('prices fall together'), []);
  });

  it('hands a swap to Swap AI with the goal written out, reading "all my USDC" from the wallet', () => {
    // 2026-10-31: the operator's question, answered with "I could not read that
    // question as a calculation".
    const asked = 'Мне нужен свап моих всех usdc на eth';
    assert.deepEqual(agentRouteV2(asked), { route: 'swap', topic: 'action_prep' });
    assert.deepEqual(agentSwapRequestV2(asked), { from: 'USDC', to: 'ETH', amount: { kind: 'share', share: 'all' }, amountUnclear: false });
    for (const [q, expected] of [
      ['swap 10 USDC to ETH', { from: 'USDC', to: 'ETH', amount: { kind: 'exact', value: '10' } }],
      ['обменяй 0,5 eth на usdc', { from: 'ETH', to: 'USDC', amount: { kind: 'exact', value: '0.5' } }],
      ['купи Apple на 10 usdc', { from: 'USDC', to: 'AAPLc', amount: { kind: 'exact', value: '10' } }],
      ['buy 0.02 AAPL', { from: 'USDC', to: 'AAPLc', amount: null }],
      ['продай половину NVDA', { from: 'NVDAc', to: 'USDC', amount: { kind: 'share', share: 'half' } }],
      // 2026-11-09: the operator's sale of USDC for ETH was prepared as ETH to USDC.
      ['хочу продать все свои USDC на ETH', { from: 'USDC', to: 'ETH', amount: { kind: 'share', share: 'all' } }],
      ['продай 10 USDC за ETH', { from: 'USDC', to: 'ETH', amount: { kind: 'exact', value: '10' } }],
      ['sell my USDC for ETH', { from: 'USDC', to: 'ETH', amount: null }],
      ['продай NVDA за USDC', { from: 'NVDAc', to: 'USDC', amount: null }],
      ['продай все ETH', { from: 'ETH', to: 'USDC', amount: { kind: 'share', share: 'all' } }],
      ['купи USDC за ETH', { from: 'ETH', to: 'USDC', amount: null }],
      ['buy ETH with all my USDC', { from: 'USDC', to: 'ETH', amount: { kind: 'share', share: 'all' } }],
      ['обменяй все USDC на все свои эфиры', { from: 'USDC', to: 'ETH', amount: { kind: 'share', share: 'all' } }],
    ] as const) {
      assert.deepEqual(agentSwapRequestV2(q), { ...expected, amountUnclear: false }, q);
      assert.equal(agentRouteV2(q).route, 'swap', q);
    }
    // A loan is not a swap, and a what-if is a calculation.
    assert.equal(agentRouteV2('Займи $500 и отправь другу').route, 'action_prep');
    assert.equal(agentSwapRequestV2('swap my collateral'), null);
    assert.equal(agentRouteV2('Что будет, если NVDA упадёт на 30% и я обменяю?').route, 'analysis');

    const r = report();
    const ready = agentSwapAnswerV2({ question: asked, report: r, usdcBalance: { raw: '6898728', decimals: 6, block: '53337500' } });
    assert.equal(ready.mode, 'action_prep');
    assert.equal(ready.actionLink?.href, `/routes?goal=${encodeURIComponent('Swap 6.898728 USDC to ETH')}`);
    assert.match(ready.text, /^Подготовил обмен: 6\.898728 USDC \(весь ваш USDC на блоке Base 53,337,500\) на ETH\. .*подписываете вы/);
    // Nothing held, nothing read, and nobody signed in are three answers.
    assert.match(agentSwapAnswerV2({ question: asked, report: r, usdcBalance: { raw: '0', decimals: 6, block: '1' } }).text, /^В вашем кошельке сейчас 0 USDC/);
    assert.match(agentSwapAnswerV2({ question: asked, report: r, usdcBalance: 'unread' }).text, /не удалось прочитать: это наш сбой/);
    assert.match(agentSwapAnswerV2({ question: 'swap all my USDC to ETH', report: null, usdcBalance: null }).text, /^Sign in and I will read your USDC/);
    const sold = agentSwapAnswerV2({ question: 'хочу продать все свои USDC на ETH', report: r, usdcBalance: { raw: '1355000', decimals: 6, block: '53400000' } });
    assert.equal(sold.actionLink?.href, `/routes?goal=${encodeURIComponent('Swap 1.355 USDC to ETH')}`);
    assert.match(sold.text, /^Подготовил обмен: 1\.355 USDC \(весь ваш USDC/);
    // "All my ETH" is not worked out: the fee has to stay.
    assert.match(agentSwapAnswerV2({ question: 'swap all my ETH to USDC', report: r }).text, /^Name an amount of ETH/);
    // A stock is named by its address from the reading, not by its symbol.
    const half = agentSwapAnswerV2({ question: 'sell half my NVDA', report: r });
    const nvda = r.assets.find((asset) => asset.symbol === 'NVDAc')!;
    assert.match(decodeURIComponent(half.actionLink!.href), new RegExp(`^/routes\\?goal=Swap \\d+(?:\\.\\d+)? ${nvda.token} to USDC$`));
    const unclear = agentSwapAnswerV2({ question: 'swap something', report: r });
    assert.equal(unclear.actionLink?.href, '/routes');
  });

  // Audit MCP-1, 2026-11-10: the amount was the first number in the question, and "all" wherever the word
  // stood. Each line below prepared a wrong amount, and the answer said "Prepared".
  it('takes an amount only as one plain number: a percentage, an exception, a second number or "1,000" is asked back', () => {
    const address = `0x${'ab'.repeat(20)}`;
    for (const q of [
      `send 50% of my NVDAc to ${address}`, 'Send 0.5% of my NVDAc to bob.base.eth', 'send 25 percent of my NVDAc to bob.base.eth', 'переведи 10 процентов NVDAc на bob.base.eth',
      'send all but 0.5 NVDAc to bob.base.eth', 'send everything except 1 NVDAc to bob.base.eth', 'переведи все кроме 0,5 NVDAc на friend.base.eth',
      'переведи все NVDAc без 1 на friend.base.eth', 'отправь всё, оставь 2 NVDAc, на friend.base.eth', 'send all my NVDAc minus 1 to bob.base.eth',
      'On 12 November send 0.1 NVDAc to bob.base.eth', 'send 1,000 NVDAc to bob.base.eth', 'send 12,500,000 NVDAc to bob.base.eth',
    ]) {
      const request = agentSendRequestV2(q);
      assert.deepEqual([request?.amount, request?.amountUnclear, request?.asset], [null, true, 'NVDAc'], q);
    }
    for (const q of ['swap 50% of my USDC to ETH', 'обменяй 25% моих USDC на ETH', 'swap all but 100 USDC to ETH', 'swap 1,000 USDC to ETH', 'обменяй все USDC кроме 10 на ETH', 'on 12 November swap 5 USDC to ETH']) {
      const request = agentSwapRequestV2(q);
      assert.deepEqual([request?.amount, request?.amountUnclear, request?.from, request?.to], [null, true, 'USDC', 'ETH'], q);
    }
    // One plain number, a decimal comma, "all" and "half" are read as before; an address or a name holds digits of its own.
    assert.deepEqual(agentSendRequestV2(`переведи 0,5 NVDA на ${address}`)?.amount, { kind: 'exact', value: '0.5' });
    assert.deepEqual(agentSendRequestV2('send 2 NVDAc to bob123.base.eth')?.amount, { kind: 'exact', value: '2' });
    assert.deepEqual(agentSendRequestV2('send all my NVDAc to bob.base.eth')?.amount, { kind: 'share', share: 'all' });
    assert.deepEqual(agentSwapRequestV2('swap 10 USDC to ETH')?.amount, { kind: 'exact', value: '10' });
    for (const plain of ['send 0.5 NVDAc', 'swap 10 USDC to ETH', 'обменяй 0,5 eth на usdc', 'продай половину NVDA', 'send all my NVDAc']) assert.equal(agentAmountUnclearV2(plain), false, plain);
    for (const unclear of ['50%', 'ten percent', 'all but 1', 'всё кроме 1', '1,000', '5 and 6']) assert.equal(agentAmountUnclearV2(unclear), true, unclear);
    // The swap answer says the amount was not read, and opens Swap AI with none; it never says "Prepared".
    const swap = agentSwapAnswerV2({ question: 'swap 50% of my USDC to ETH', report: null });
    assert.match(swap.text, /^I take an amount only as one plain number, so I did not guess one: the swap of USDC to ETH opens with no amount, name it in Swap AI\./);
    assert.equal(swap.actionLink?.href, `/routes?goal=${encodeURIComponent('Swap USDC to ETH')}`);
    const ru = agentSwapAnswerV2({ question: 'обменяй 25% моих USDC на ETH', report: null });
    assert.match(ru.text, /^Сумму я читаю только как одно простое число, поэтому угадывать не стал/);
    assert.doesNotMatch(`${swap.text} ${ru.text}`, /Prepared|Подготовил/);
  });

  it('reads a transfer by its rules: the stock, how much, and the recipient the question wrote', () => {
    // 2026-11-03: the operator asked for "перевод всех Nvdac на <name>.base.eth"
    // and read the list of what the Agent answers.
    const asked = 'подготовь для меня перевод всех Nvdac на friend.base.eth адрес';
    assert.deepEqual(agentRouteV2(asked), { route: 'send', topic: 'action_prep' });
    assert.deepEqual(agentSendRequestV2(asked), { asset: 'NVDAc', named: 1, amount: { kind: 'share', share: 'all' }, amountUnclear: false, recipient: { kind: 'basename', value: 'friend.base.eth' }, unclear: null });
    const address = `0x${'ab'.repeat(20)}`;
    for (const [q, expected] of [
      [`переведи 0,5 NVDA на ${address}`, { asset: 'NVDAc', named: 1, amount: { kind: 'exact', value: '0.5' }, recipient: { kind: 'address', value: address }, unclear: null }],
      ['send 10 AAPL to alice.base.eth.', { asset: 'AAPLc', named: 1, amount: { kind: 'exact', value: '10' }, recipient: { kind: 'basename', value: 'alice.base.eth' }, unclear: null }],
      ['transfer half my tesla to bob.eth', { asset: 'TSLAc', named: 1, amount: { kind: 'share', share: 'half' }, recipient: { kind: 'other_name', value: 'bob.eth' }, unclear: null }],
      ['отправь другу NVDA', { asset: 'NVDAc', named: 1, amount: null, recipient: null, unclear: null }],
      // A recipient's name is a person, not a stock.
      ['отправь nvda.base.eth все акции AAPL', { asset: 'AAPLc', named: 1, amount: { kind: 'share', share: 'all' }, recipient: { kind: 'basename', value: 'nvda.base.eth' }, unclear: null }],
    ] as const) {
      assert.deepEqual(agentSendRequestV2(q), { ...expected, amountUnclear: false }, q);
      assert.equal(agentRouteV2(q).route, 'send', q);
    }
    // Re-audit R6, 2026-11-04: two recipients, or where not to send, are asked back, never read for the first.
    const other = `0x${'cd'.repeat(20)}`;
    for (const [q, unclear] of [
      [`Do not send to ${address}. Send 0.1 NVDAc to ${other}`, 'several'],
      [`send 1 NVDA to alice.base.eth, not to ${address}`, 'several'],
      [`переведи 1 NVDA на ${other}, не на ${address}`, 'several'],
      [`don't send my NVDA to ${address}`, 'negated'],
      [`не переводи NVDA на ${address}`, 'negated'],
      [`send 1 NVDA to ${address.toUpperCase().replace('0X', '0x')} (${address})`, null],
    ] as const) {
      assert.equal(agentSendRequestV2(q)?.unclear, unclear, q);
    }
    // A loan first, a what-if, a translation, a price and a request for words are not transfers.
    assert.equal(agentRouteV2('Займи $500 и отправь другу').route, 'action_prep');
    assert.equal(agentRouteV2('что будет, если я отправлю все NVDA на alice.base.eth?').route, 'unknown');
    assert.equal(agentSendRequestV2('переведи на английский'), null);
    assert.equal(agentSendRequestV2('Сколько стоит перевод?'), null);
    assert.equal(agentSendRequestV2('send me a summary of my NVDA'), null);
    // Without the server the page prepares nothing, and says why.
    const sky = skyStateV1({ now: WEDNESDAY });
    assert.match(agentAnswerV1({ question: asked, report: report(), sky, signedIn: false }).text, /^Войдите, и я прочитаю ваш кошелёк и подготовлю перевод/);
    const unanswered = agentAnswerV1({ question: asked, report: report(), sky, signedIn: true });
    assert.match(unanswered.text, /сервер не ответил, это наш сбой/);
    assert.equal(unanswered.sendAction, undefined);
    // Swap AI is pointed to for a trade, not for any question the list answers.
    assert.equal(agentTradeWordsV2('обменяй всё на eth'), true);
    assert.equal(agentTradeWordsV2(asked), false);
  });

  it('answers the direct reads from the numbers on screen, in the language of the question', () => {
    const r = report();
    const sky = skyStateV1({ now: WEDNESDAY });
    const borrowing = agentAnswerV1({ question: 'Сколько я могу взять?', report: r, sky });
    assert.equal(borrowing.mode, 'fast');
    assert.match(borrowing.text, /^Расчётный запас для займа — \$784\.62\. Ваш долг \$240\.17 уже учтён\./);
    assert.match(borrowing.text, /Get money поддерживает проверенные акции через Aave V4/);
    assert.match(agentAnswerV1({ question: 'How safe is my loan?', report: r, sky }).text, /prices can fall 52% together .* NVIDIA below \$100\.92/);
    const weekend = agentAnswerV1({ question: 'How much can I spend?', report: report(SATURDAY), sky: skyStateV1({ now: SATURDAY_AT }) });
    assert.match(weekend.text, /On an open market it would be \$784\.62: until Sun 8 PM stocks count at 40%\./);
    assert.match(agentAnswerV1({ question: 'dividend?', report: r, sky, dividends }).text, /Apple: pays around 2026-11-12, about \$0\.19 as more AAPLc\. .* the amount is an estimate\./);
    const unknown = agentAnswerV1({ question: 'Tell me a joke', report: r, sky });
    assert.equal(unknown.topic, null);
    assert.doesNotMatch(unknown.text, /\$\d/);
    // A question it does not recognise is answered with the list: no badge, no figures.
    assert.equal(unknown.mode, undefined);
    assert.equal(unknown.engineFacts, undefined);
    assert.match(agentAnswerV1({ question: 'How much can I borrow?', report: null, sky }).text, /sign in/);
  });

  it('leaves calculations to the server and keeps the action boundary on the page', () => {
    const r = report();
    const sky = skyStateV1({ now: WEDNESDAY });
    // The page has no arithmetic of its own for a what-if: if the server is unreachable it says so.
    const stress = agentAnswerV1({ question: 'Что будет при падении NVDA на 30%?', report: r, sky, signedIn: true });
    assert.equal(stress.mode, 'refused');
    assert.match(stress.text, /сервер.*наш сбой/);
    assert.doesNotMatch(stress.text, /\$\d/);
    assert.match(agentAnswerV1({ question: 'What if NVDA drops 30%?', report: null, sky, signedIn: false }).text, /sign in/);

    const actionPrep = agentAnswerV1({ question: 'Займи $500 и отправь другу', report: r, sky });
    assert.equal(actionPrep.topic, 'action_prep');
    assert.equal(actionPrep.mode, 'action_prep');
    assert.match(actionPrep.text, /не исполняю транзакции автоматически и не отправляю средства на сторонние адреса/);
    assert.match(actionPrep.text, /\$500\.00 укладываются в расчётный запас Still \(\$784\.62\)/);
    assert.equal(actionPrep.actionLink?.href, '/borrow');
  });

  it('renders the prompts in the reader’s language and orbs that name the stage under way', () => {
    const html = renderToStaticMarkup(<StillAgent model={{ sky: skyStateV1({ now: WEDNESDAY }), report: null, dividends: null, reading: true, signedIn: true, russian: true }} />);
    assert.match(html, /Сколько я могу взять без продажи\?/);
    assert.match(html, /Что будет при падении NVDA на 30%\?/);
    assert.match(html, /data-phase="evidence"/);
    assert.match(html, /Читаю ваш кошелёк на Base/);
    const computing = renderToStaticMarkup(<ThinkingOrbs event={{ stage: 'computing', summary: 'NVIDIA −30%' }} russian={false} />);
    assert.match(computing, /data-phase="risk"/);
    assert.match(computing, /Still engine computing: NVIDIA −30%/);
    assert.match(renderToStaticMarkup(<ThinkingOrbs event={{ stage: 'read', block: '53000000' }} />), /Read at block 53,000,000/);
    assert.match(renderToStaticMarkup(<ThinkingOrbs event={{ stage: 'checked', verified: false }} />), /data-phase="llm".*failed the check/);
    const resolving = renderToStaticMarkup(<ThinkingOrbs event={{ stage: 'resolving', summary: 'friend.base.eth' }} russian />);
    assert.match(resolving, /data-phase="risk"/);
    assert.match(resolving, /Проверяю получателя на Base: friend\.base\.eth…/);
  });
});

describe('the frame', () => {
  it('maps every path Miorail had to a tab, under More unless it is one of the five', () => {
    assert.equal(stillTabForPathV1('/'), 'home');
    assert.equal(stillTabForPathV1('/assets'), 'assets');
    assert.equal(stillTabForPathV1('/stocks/dividends'), 'stocks');
    assert.equal(stillTabForPathV1('/market?key=x'), 'stocks');
    assert.equal(stillTabForPathV1('/borrow'), 'assets');
    assert.equal(stillTabForPathV1('/borrow/abc'), 'assets');
    for (const path of ['/routes', '/opportunities', '/investigate', '/radar', '/portfolio', '/watch', '/extensions', '/settings', '/today', '/more', '/assistants']) {
      assert.equal(stillTabForPathV1(path), 'more', path);
    }
  });

  it('draws five places, marks where you are, and offers the source as the AGPL asks', () => {
    const html = renderToStaticMarkup(<StillFrame tab="stocks" sky={skyStateV1({ now: WEDNESDAY })}><p>page</p></StillFrame>);
    for (const label of ['Home', 'Assets', 'Agent', 'Stocks', 'More']) assert.match(html, new RegExp(`>${label}</a>`));
    assert.match(html, /href="\/stocks" aria-current="page"/);
    assert.match(html, /Source \(AGPL-3\.0\)/);
    // The public repository: mioku50/mioagent is private and answers a visitor with a 404.
    assert.match(html, /href="https:\/\/github\.com\/mioku50\/miorail"/);
    assert.match(html, /data-sky="day"/);
    const more = renderToStaticMarkup(<StillMore model={{ sky: skyStateV1({ now: WEDNESDAY }), account: null, signInHref: '/signin' }} />);
    for (const label of ['Swap AI', 'Discover', 'Watch', 'Still for assistants', 'Activity', 'Settings']) assert.match(more, new RegExp(label));
    // How Still keeps a loan safe leads More (2026-11-08), and Grok is named with the other assistants.
    assert.match(more, /<section class="still-more-group" aria-label="Safety"><h2 class="still-more-group-head">Safety<\/h2><ul class="still-links"><li><a [^>]*href="\/safety"/);
    assert.ok(more.indexOf('aria-label="Safety"') < more.indexOf('aria-label="Spend"'), 'Safety comes first');
    assert.match(more, /Connect Claude, ChatGPT, Grok, Cursor or Codex/);
    // Wallet MCP is Coinbase's: its page stays (the path map above), More does not offer it.
    assert.doesNotMatch(more, /Wallet MCP|href="\/extensions"/);
    // Investigate, B20 controls and Radar are one page now, and More has one door to it.
    assert.match(more, /href="\/watch"/);
    assert.doesNotMatch(more, /href="\/(?:investigate|radar|portfolio)"/);
    const assistants = renderToStaticMarkup(<StillAssistants model={{ sky: skyStateV1({ now: WEDNESDAY }) }} />);
    // The signed-in server leads, under Still's name: it prepares. Another wallet and a what-if stay on the read-only one.
    assert.ok(assistants.includes(`claude mcp add --transport http still https://miorail.xyz/mcp/private`));
    assert.ok(assistants.includes(`codex mcp add still --url https://miorail.xyz/mcp/private`));
    assert.match(assistants, /miorail_prepare_still_loan.*miorail_prepare_still_purchase.*miorail_prepare_still_wallet_purchase.*miorail_prepare_still_repay.*miorail_get_still_review_status/);
    assert.ok(assistants.indexOf('/mcp/private') < assistants.indexOf('/mcp/still'), 'the signed-in server comes first');
    // The read-only one stays, for an assistant that signs in nowhere.
    assert.ok(assistants.includes(`claude mcp add --transport http still-read-only ${STILL_PUBLIC_ORIGIN_V1}/mcp/still`));
    assert.match(assistants, /get_still_terms.*still_check_wallet.*still_what_if.*still_find_spend.*still_spend_product/);
    assert.match(assistants, /What happens to that wallet’s Still loan if NVIDIA falls 30%\?/);
    assert.match(assistants, /Claude, ChatGPT, Grok, Cursor or Codex/);
    assert.doesNotMatch(assistants, /Miorail’s signed-in server|connectorName=Miorail/);
    // Claude's own add-connector form, filled in for each server, and each question one click from a chat.
    assert.match(assistants, /href="https:\/\/claude\.ai\/customize\/connectors\?modal=add-custom-connector&amp;connectorName=Still&amp;connectorUrl=https%3A%2F%2Fmiorail\.xyz%2Fmcp%2Fprivate"[^>]*>Add to Claude</);
    assert.ok(assistants.includes(`connectorName=Still%20(read%20only)&amp;connectorUrl=${encodeURIComponent(`${STILL_PUBLIC_ORIGIN_V1}/mcp/still`)}`));
    assert.match(assistants, /href="https:\/\/claude\.ai\/new\?q=What%20are%20Still%E2%80%99s%20terms%20this%20weekend%3F"/);
    assert.match(assistants, /href="https:\/\/chatgpt\.com\/\?q=/);
    assert.match(assistants, /href="https:\/\/grok\.com\/\?q=What%20are%20Still%E2%80%99s%20terms%20this%20weekend%3F"[^>]*>Grok</);
    assert.match(assistants, /grok\.com\/connectors: New Connector, Custom/);
    // 2026-11-08: ChatGPT and Grok beside Claude. Neither fills a custom connector in from a link, so each
    // button opens the page where the address is pasted (copied on the same press), and the page says so.
    assert.match(assistants, /href="https:\/\/chatgpt\.com\/plugins"[^>]*>Add to ChatGPT</);
    assert.match(assistants, /href="https:\/\/grok\.com\/connectors"[^>]*>Add to Grok</);
    assert.match(assistants, /<div class="still-add-row"><a class="still-btn" href="https:\/\/claude\.ai[^"]*"[^>]*>Add to Claude<\/a><a class="still-btn sec" href="https:\/\/chatgpt\.com\/plugins"/);
    assert.match(assistants, /Claude opens its form with Still filled in\. ChatGPT and Grok cannot be filled in from a link, so their buttons copy the address and open\s+the page where you paste it\./);
    assert.doesNotMatch(assistants, /The address is copied|Copy the address above first/, 'nothing is said about a press before one');
    assert.doesNotMatch(assistants, /Wallet MCP/);
    assert.match(assistants, /not offered to US persons/);
  });
  // The copy happens inside the press, before the link opens another tab: Chrome refuses the
  // asynchronous Clipboard API once this page has lost focus to the tab it opened.
  it('copies the address on the press itself, and says false where it cannot', () => {
    const calls: string[] = [];
    const area = { value: '', style: {}, focus: () => calls.push('focus'), select: () => calls.push('select'),
      setSelectionRange: (from: number, to: number) => calls.push(`range ${from}-${to}`), remove: () => calls.push('remove') };
    const fake = { body: { appendChild: () => calls.push('append') }, createElement: () => area, activeElement: null,
      execCommand: (command: string) => { calls.push(command); return true; } };
    const g = globalThis as { document?: unknown };
    const saved = g.document;
    g.document = fake;
    try {
      assert.equal(copyOnThisPressV1('https://miorail.xyz/mcp/private'), true);
      assert.equal(area.value, 'https://miorail.xyz/mcp/private');
      assert.deepEqual(calls, ['append', 'focus', 'select', 'range 0-31', 'copy', 'remove']);
      fake.execCommand = () => false;
      assert.equal(copyOnThisPressV1('https://miorail.xyz/mcp/private'), false);
      fake.execCommand = () => { throw new Error('refused'); };
      assert.equal(copyOnThisPressV1('https://miorail.xyz/mcp/private'), false, 'a refusal is not a copy');
      g.document = undefined;
      assert.equal(copyOnThisPressV1('https://miorail.xyz/mcp/private'), false, 'no page, no copy');
    } finally { g.document = saved; }
  });
});

describe('after a loan, the offer to hear about it', () => {
  const WEDNESDAY_V1 = new Date('2026-10-21T15:00:00.000Z');
  const telegram = (linked: boolean, pending: { url: string; expiresAt: string } | null = null) => ({
    view: telegramAlertsViewV1({ status: { available: true, linked }, pending, busy: null, failed: null, now: WEDNESDAY_V1 })!,
    onConnect: () => {},
    onDisconnect: () => {},
  });

  it('names the bands it tells and offers the link; a connected chat is told it already hears', () => {
    const off = renderToStaticMarkup(<StillLoanAlertsOffer telegram={telegram(false)} />);
    assert.match(off, /Hear about this loan in Telegram/);
    assert.match(off, /when your collateral can fall less than 37\.5% before liquidation, again below 20%, and if the loan can be liquidated\. The bot never asks you to sign\./);
    assert.match(off, />Connect<\/button>/);
    const on = renderToStaticMarkup(<StillLoanAlertsOffer telegram={telegram(true)} />);
    assert.match(on, /Telegram will tell you about this loan/);
    assert.match(on, /Your Telegram chat hears about this loan when your collateral can fall less than 37\.5%/);
    // Disconnecting is not this page's business.
    assert.doesNotMatch(on, /<button/);
    const open = renderToStaticMarkup(<StillLoanAlertsOffer telegram={telegram(false, { url: `https://t.me/miorailbot?start=${'a'.repeat(32)}`, expiresAt: '2026-10-21T15:10:00.000Z' })} />);
    assert.match(open, /<a class="still-extra-action" href="https:\/\/t\.me\/miorailbot\?start=a{32}" target="_blank" rel="noreferrer">Open @miorailbot in Telegram<\/a>/);
    // No bot on this server, or no sign-in: nothing is offered.
    assert.equal(renderToStaticMarkup(<StillLoanAlertsOffer telegram={null} />), '');
  });
});

