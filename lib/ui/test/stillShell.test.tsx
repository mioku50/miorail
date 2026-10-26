import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMirror, type CalendarRead } from '@mioagent/still-engine';
import { stillTerms } from '@mioagent/still-engine/terms';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import { EXAMPLE, SATURDAY, calendar, snapshot, universe } from '../../still-engine/test/fixtures';
import {
  agentAnswerV1,
  agentTopicV1,
  assetsViewV1,
  homeViewV1,
  mobileLayoutV1,
  skyCaptionV1,
  skyEarningsFromTermsV1,
  skyStateV1,
  stillTabForPathV1,
  StillAgent,
  StillAssets,
  StillFrame,
  StillHomeSignedIn,
  StillHomeSignedOut,
  StillMore,
  StillAssistants,
  type MobileHoldingV1,
} from '../src/still';

void React;

// The engine's own example portfolio: 4.2 NVDAc (3.4 pledged on Aave), 1.5 AAPLc, 0.8 TSLAc,
// 0.012 cbBTC and $240.17 owed. The shell shows exactly what the engine computed.
const subject = { address: '0x00000000000000000000000000000000000b0b0b' as const, name: null, input: 'example' };
function report(timestamp?: bigint): MirrorReport {
  const s = timestamp === undefined ? snapshot(EXAMPLE) : snapshot(EXAMPLE, timestamp);
  return JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: s, calendar: calendar(), subject, assembledAt: new Date('2026-10-21T15:00:01Z') })));
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

describe('the market sky', () => {
  it('puts the sun on its path during the session and names the full limits', () => {
    const sky = skyStateV1({ now: new Date('2026-10-26T18:05:00Z'), earnings: [] }); // Mon 2:05 PM
    assert.equal(sky.phase, 'day');
    assert.equal(sky.clock, 'MON 2:05 PM');
    assert.ok(Math.abs(sky.sunShare! - 275 / 390) < 1e-9);
    assert.deepEqual(skyCaptionV1(sky), { headline: 'Market open · full limits', detail: null });
  });

  it('is night while Wall Street is closed, a weekend or Thanksgiving, and says until when', () => {
    const saturday = skyStateV1({ now: new Date('2026-10-31T15:00:00Z') });
    assert.equal(saturday.phase, 'night');
    assert.equal(skyCaptionV1(saturday).headline, 'Wall Street is closed. Base is open.');
    assert.match(skyCaptionV1(saturday).detail!, /Until Sun 8 PM new loans against stocks count at 40%/);
    assert.equal(skyStateV1({ now: new Date('2026-11-26T15:00:00Z') }).phase, 'night'); // Thanksgiving, a Thursday
  });

  it('is dusk around the session, before the open and after hours, with the full limits', () => {
    assert.equal(skyCaptionV1(skyStateV1({ now: new Date('2026-10-27T12:00:00Z'), earnings: [] })).headline, 'Before the open · full limits');
    assert.equal(skyCaptionV1(skyStateV1({ now: new Date('2026-10-28T02:00:00Z'), earnings: [] })).headline, 'After hours · full limits');
  });

  it('measures the sun against the early close, and draws a cloud for a stock reporting now', () => {
    const friday = skyStateV1({ now: new Date('2026-11-27T16:15:00Z') }); // 11:15, the day after Thanksgiving closes at 13:00
    assert.equal(friday.phase, 'day');
    assert.ok(Math.abs(friday.sunShare! - 105 / 210) < 1e-9);
    const reporting = skyStateV1({
      now: new Date('2026-10-28T15:00:00Z'),
      earnings: [{ asset: 'GOOGLc', name: 'Alphabet', startsAt: '2026-10-27T04:00:00.000Z', endsAt: '2026-10-30T00:00:00.000Z' }],
    });
    assert.equal(reporting.clouds.length, 1);
    assert.deepEqual(skyCaptionV1(reporting), {
      headline: 'Market open · earnings limits',
      detail: 'Alphabet reports now: new loans against it count at 40% of the protocol’s limit until Thu 8 PM.',
    });
  });
});

describe('the sky and Still’s terms', () => {
  const MONDAY = new Date('2026-10-26T18:05:00Z');
  it('takes its clouds from the terms, and names no limits before the terms were read', () => {
    const read: CalendarRead = { ok: true, calendar: { readAt: MONDAY, dates: new Map([['NVDAc', ['2026-10-26']], ['TSLAc', []]]) } };
    const { earnings, unread } = skyEarningsFromTermsV1(stillTerms(read, MONDAY));
    assert.deepEqual(earnings.map((e) => e.name), ['NVIDIA']);
    assert.deepEqual(unread, ['Apple', 'Amazon', 'Alphabet', 'Meta', 'Microsoft']);
    const sky = skyStateV1({ now: MONDAY, earnings, unread });
    assert.equal(sky.clouds.length, 1);
    assert.equal(skyCaptionV1(sky).headline, 'Market open · earnings limits');
    assert.match(skyCaptionV1(sky).detail!, /NVIDIA reports now: .* The earnings calendar could not be read just now: new loans against stocks count at 40%/);
    assert.deepEqual(skyCaptionV1(skyStateV1({ now: MONDAY })), { headline: 'Market open', detail: null });
  });

  it('says which stock an unread calendar lowers, when it is a few', () => {
    assert.equal(
      skyCaptionV1(skyStateV1({ now: MONDAY, earnings: [], unread: ['Apple'] })).detail,
      'The earnings calendar could not be read just now: new loans against Apple count at 40% of the protocol’s limit until it is.',
    );
  });
});

describe('Home', () => {
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
    assert.match(html, /\$784<\/span><span class="c">\.62/);
    assert.match(html, /Owed \$240\.17/);
    assert.match(html, /role="img"/);
    assert.doesNotMatch(html, /You can borrow|guaranteed|\bSafe\b/i);
  });

  it('signed out, it is the front door: a check for any wallet, the terms in one line, no example numbers', () => {
    const html = renderToStaticMarkup(<StillHomeSignedOut model={{ sky: skyStateV1({ now: WEDNESDAY }), result: null, checking: false, message: null, onCheck: () => {}, signInHref: '/signin' }} />);
    assert.match(html, /Spend without selling\./);
    assert.match(html, /Not offered to US persons/);
    assert.doesNotMatch(html, /\$\d/);
  });
});

describe('the mobile', () => {
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
    assert.equal(btc.lines[0]!.text, 'Free · could carry up to $414.34 on Morpho');
    const apple = view.rows.find((r) => r.id === 'AAPLc')!;
    assert.match(apple.lines.at(-1)!.text, /≈ \$0\.19, if you hold AAPLc when it converts \(an estimate\)/);
    assert.deepEqual(view.loans.map((l) => [l.label, l.owed]), [['Aave V4 · Coinbase Stocks', '$240.17']]);
    assert.equal(view.loans[0]!.safety, 'Prices can fall 52% together before liquidation.');
    assert.deepEqual(view.loans[0]!.liquidation, ['NVIDIA below $100.92, if only it moved']);
    const html = renderToStaticMarkup(<StillAssets model={{ sky: skyStateV1({ now: WEDNESDAY }), view, loading: false, failed: null, onRetry: () => {}, signedIn: true, signInHref: '/signin' }} />);
    assert.match(html, /Loans · 1/);
  });
});

describe('the Agent', () => {
  it('knows the topics in English and in Russian, and admits what it does not answer', () => {
    assert.equal(agentTopicV1('How much can I spend?'), 'borrow');
    assert.equal(agentTopicV1('Насколько безопасен мой займ?'), 'safety');
    assert.equal(agentTopicV1('Когда выходные лимиты?'), 'closed');
    assert.equal(agentTopicV1('А когда следующий дивиденд?'), 'dividends');
    assert.equal(agentTopicV1('Tell me a joke'), null);
  });

  it('answers from the numbers on screen, in the language of the question', () => {
    const r = report();
    const sky = skyStateV1({ now: WEDNESDAY });
    assert.equal(agentAnswerV1({ question: 'Сколько я могу взять?', report: r, sky }).text, 'Сейчас $784.62 без продажи. Ваш долг $240.17 уже учтён.');
    assert.match(agentAnswerV1({ question: 'How safe is my loan?', report: r, sky }).text, /prices can fall 52% together .* NVIDIA below \$100\.92/);
    const weekend = agentAnswerV1({ question: 'How much can I spend?', report: report(SATURDAY), sky: skyStateV1({ now: SATURDAY_AT }) });
    assert.match(weekend.text, /On an open market it would be \$784\.62: until Sun 8 PM stocks count at 40%\./);
    assert.match(agentAnswerV1({ question: 'dividend?', report: r, sky, dividends }).text, /Apple: paid around 2026-11-12, about \$0\.19 as more AAPLc\. .* the amount is an estimate\./);
    const unknown = agentAnswerV1({ question: 'Tell me a joke', report: r, sky });
    assert.equal(unknown.topic, null);
    assert.doesNotMatch(unknown.text, /\$\d/);
    assert.match(agentAnswerV1({ question: 'How much can I borrow?', report: null, sky }).text, /sign in/);
  });

  it('renders the prompts in the reader’s language', () => {
    const html = renderToStaticMarkup(<StillAgent model={{ sky: skyStateV1({ now: WEDNESDAY }), report: null, dividends: null, reading: false, signedIn: false, russian: true }} />);
    assert.match(html, /Сколько я могу взять без продажи\?/);
  });
});

describe('the frame', () => {
  it('maps every path Miorail had to a tab, under More unless it is one of the five', () => {
    assert.equal(stillTabForPathV1('/'), 'home');
    assert.equal(stillTabForPathV1('/assets'), 'assets');
    assert.equal(stillTabForPathV1('/stocks/dividends'), 'stocks');
    assert.equal(stillTabForPathV1('/market?key=x'), 'stocks');
    assert.equal(stillTabForPathV1('/borrow/abc'), 'stocks');
    for (const path of ['/routes', '/opportunities', '/investigate', '/radar', '/portfolio', '/extensions', '/settings', '/today', '/more', '/assistants']) {
      assert.equal(stillTabForPathV1(path), 'more', path);
    }
  });

  it('draws five places, marks where you are, and offers the source as the AGPL asks', () => {
    const html = renderToStaticMarkup(<StillFrame tab="stocks" sky={skyStateV1({ now: WEDNESDAY })}><p>page</p></StillFrame>);
    for (const label of ['Home', 'Assets', 'Agent', 'Stocks', 'More']) assert.match(html, new RegExp(`>${label}</a>`));
    assert.match(html, /href="\/stocks" aria-current="page"/);
    assert.match(html, /Source \(AGPL-3\.0\)/);
    assert.match(html, /data-sky="day"/);
    const more = renderToStaticMarkup(<StillMore model={{ sky: skyStateV1({ now: WEDNESDAY }), account: null, signInHref: '/signin' }} />);
    for (const label of ['Swap AI', 'Discover', 'Investigate', 'Radar', 'B20 controls', 'Wallet MCP', 'Still for assistants', 'Activity', 'Settings']) assert.match(more, new RegExp(label));
    const assistants = renderToStaticMarkup(<StillAssistants model={{ sky: skyStateV1({ now: WEDNESDAY }) }} />);
    assert.match(assistants, /claude mcp add --transport http miorail https:\/\/miorail\.xyz\/mcp\/private/);
    assert.match(assistants, /Use the Miorail plugin for Wallet MCP: https:\/\/miorail\.xyz\/wallet-mcp\/miorail\.md/);
    assert.match(assistants, /not offered to US persons/);
  });
});
