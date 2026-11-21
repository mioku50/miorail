import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The page adds the reader's own time beside UTC (audit UI-3); these renders read as a browser in UTC would,
// on any machine. stillLoopLocalTimeV1 is checked below with the offset given.
process.env.TZ = 'UTC';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

void React;

import { lendingLoopWireV1, parseLendingExecutionWireV1 } from '../src/console/lendingReviewView';
import { StillLoopOffer, loopSentenceV1, loopShareTextV1 } from '../src/still/StillLoop';
import { LOOP_LOGO_V1, STILL_LOOP_PROMPT_V1, StillLoops, stillLoopCountdownV1, stillLoopDayV1, stillLoopDrawMineViewV1, stillLoopDrawPrizeV1, stillLoopDrawTimeV1, stillLoopLocalTimeV1, stillLoopsMineViewV1, stillLoopsViewV1 } from '../src/still/StillLoops';
import { StillMore } from '../src/still/StillPages';
import { StillSpendDoor } from '../src/still/StillHome';
import { skyStateV1 } from '../src/still/skyState';

const LOOP = { loopNo: 7, brand: 'apple' as const, complete: true, undelivered: null, onWall: false, team: false };
const EXECUTION = '0f6b2a8e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
const never = async () => { throw new Error('not pressed'); };
/** The page with the stocks' icons taken out: each names a token contract, never a wallet. */
const withoutIcons = (html: string) => html.replace(/\/api\/public\/stocks\/icons\/0x[0-9a-f]{40}\.png/g, '');

describe('a Loop on the loan’s own result', () => {
  it('is read from the answer only when it has the shape the server sends, and only for a confirmed loan', () => {
    assert.deepEqual(lendingLoopWireV1(LOOP), LOOP);
    for (const bad of [null, [], { ...LOOP, loopNo: 0 }, { ...LOOP, brand: 'nvidia' }, { ...LOOP, undelivered: 'lost' }, { ...LOOP, complete: 'yes' }]) {
      assert.equal(lendingLoopWireV1(bad), null, JSON.stringify(bad));
    }
    const base = { executionId: EXECUTION, transactionHash: null, errorCode: null, loop: LOOP };
    assert.deepEqual(parseLendingExecutionWireV1({ ...base, state: 'confirmed' }, EXECUTION)?.loop, LOOP);
    assert.equal(parseLendingExecutionWireV1({ ...base, state: 'submitted' }, EXECUTION)?.loop, null);
  });

  it('says the stock stayed and the card arrived, and offers the wall with the name as a choice', () => {
    assert.equal(loopSentenceV1('apple'), 'Apple stock stayed. An Apple gift card arrived.');
    assert.equal(loopSentenceV1('microsoft'), 'Microsoft stock stayed. An Xbox card arrived.');
    assert.equal(loopShareTextV1(LOOP), 'Loop #7: Apple stock stayed. An Apple gift card arrived. Borrowed on Base through Still, nothing sold.');
    const html = renderToStaticMarkup(<StillLoopOffer model={{ loop: LOOP, onWall: never }} />);
    assert.match(html, /Loop #7/);
    assert.match(html, /Apple stock stayed\. An Apple gift card arrived\./);
    assert.match(html, />Put it on the Loop wall</);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /never your wallet or the transaction\. While loans on Base\s+are few, someone could still match those to your loan, and so to your wallet: put it on the wall only if that is fine with you\.\s+Not affiliated with Apple\./);
    // Its own card, as the order above it has (2026-11-19).
    assert.match(html, /class="still-extra still-loop-card" data-complete="yes"/);
    assert.match(html, /<h2 class="still-loop-head">Loop #7<\/h2>/);
  });

  it('offers nothing before the card arrived, for the team, or once on the wall; and says when Bitrefill stopped it', () => {
    const waiting = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, complete: false }, onWall: never }} />);
    assert.match(waiting, /It counts once Bitrefill says the card arrived\./);
    assert.doesNotMatch(waiting, /Put it on the Loop wall/);
    const stopped = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, complete: false, undelivered: 'denied' }, onWall: never }} />);
    assert.match(stopped, /Bitrefill declined the order, so the card did not arrive and this Loop does not count/);
    const team = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, team: true }, onWall: never }} />);
    assert.match(team, /A Still team Loop: shown as the team’s and not counted\./);
    assert.doesNotMatch(team, /Put it on the Loop wall/);
    // In a chat the press is by number only, the Basename from /loops (audit MCP-2).
    const chat = renderToStaticMarkup(<StillLoopOffer model={{ loop: LOOP, onWall: never, numberOnly: true }} />);
    assert.match(chat, /As Loop #7\. To show your Basename instead, put it on the wall from Still’s Loops page\./);
    assert.doesNotMatch(chat, /Show my Basename/);
    const walled = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, onWall: true }, onWall: never }} />);
    // Read after a reload, which does not say the wall's name: only that it is there (audit UI-4).
    assert.match(walled, /On the Loop wall\./);
    assert.doesNotMatch(walled, /On the Loop wall as/);
    // Its owner can take it off again where the page can, and nowhere else (audit MCP-2).
    assert.doesNotMatch(walled, /Take it off the wall/);
    const removable = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, onWall: true }, onWall: never, offWall: async () => {} }} />);
    assert.match(removable, /Take it off the wall/);
    assert.doesNotMatch(walled, /Put it on the Loop wall/);
  });
});

describe('/loops: Loops in public', () => {
  const SKY = skyStateV1({ now: new Date('2026-11-18T12:00:00Z') });
  const ANSWER = {
    outcome: 'loops', weekStartsAt: '2026-11-16T00:00:00.000Z',
    counts: { total: 3, week: 2, viaAssistant: 2, byBrand: { apple: 2, amazon: 1, google: 0, meta: 0, microsoft: 0 } },
    wall: [{ loopNo: 2, brand: 'apple', brandName: 'Apple', card: 'Apple gift card', productName: 'iTunes Germany', packageLabel: '25 EUR',
      priceUsdc: '27', venueName: 'Aave', via: 'claude', day: '2026-11-17', label: 'alice.base.eth' }],
  };

  it('reads only the answer the server sends', () => {
    assert.equal(stillLoopsViewV1(ANSWER)?.wall.length, 1);
    assert.equal(stillLoopsViewV1({ ...ANSWER, outcome: 'nope' }), null);
    assert.equal(stillLoopsViewV1({ ...ANSWER, counts: { ...ANSWER.counts, week: -1 } }), null);
    assert.equal(stillLoopsViewV1({ ...ANSWER, wall: [{ ...ANSWER.wall[0], brand: 'nvidia' }] })?.wall.length, 0, 'a row it does not know is left out');
  });

  it('shows the week, how to make one and the wall, with no wallet and the risk said', () => {
    const html = renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(ANSWER), failed: false }} />);
    assert.match(html, />2<\/span><span class="t">this week/);
    // Any app connected over MCP counts, a script included, so the counter does not say "AI" (audit 11-20 LOOP-6).
    assert.match(html, />2<\/span><span class="t">done in a connected app/);
    assert.doesNotMatch(html, /AI assistant/);
    assert.match(html, /An Apple gift card, paid by a loan against AAPLc/);
    assert.match(html, /An Xbox card, paid by a loan against MSFTc/);
    assert.match(html, new RegExp(STILL_LOOP_PROMPT_V1.replace(/[.€]/g, '.')));
    assert.match(html, /Loop #2 · alice\.base\.eth/);
    assert.match(html, /Apple stock stayed\. iTunes Germany \(25 EUR\) arrived\./);
    // The day in words, never split on a phone (2026-11-19).
    assert.match(html, /about \$27 · Aave · Done in Claude · 17\u00a0Nov\u00a02026/);
    // Each brand opens Spend on its own cards.
    assert.match(html, /href="\/spend\?card=apple"/);
    assert.match(html, /href="\/spend\?card=microsoft"/);
    assert.match(html, /can be liquidated if prices fall/);
    // Still is a Bitrefill affiliate: the footer says so instead of denying it (audit DOC-5, 2026-11-20).
    assert.match(html, /Not affiliated with Apple, Amazon, Google, Meta or Microsoft\. Still is a Bitrefill\s+affiliate: Bitrefill may pay Still a commission, which does not change your price\./);
    assert.doesNotMatch(html, /Not affiliated with[^.]*Bitrefill/);
    assert.doesNotMatch(withoutIcons(html), /0x[0-9a-f]{6}/i);
    // The brands that made one say how many, on their own card.
    assert.match(html, /<div class="line still-loops-made">2 Loops so far<\/div>/);
    assert.match(html, /<div class="line still-loops-made">1 Loop so far<\/div>/);
  });

  // 2026-11-20, the operator: «лого компаний в loops». Coinbase's icon of each stock pledged, the one the Stocks list shows.
  it('shows each company by the icon of the stock a Loop pledges, served from this origin', () => {
    assert.deepEqual(LOOP_LOGO_V1, {
      apple: '/api/public/stocks/icons/0xb200000000000000000000c2e324d24d7eecd1fb.png',
      amazon: '/api/public/stocks/icons/0xb200000000000000000000d9192b6b456483c2e8.png',
      google: '/api/public/stocks/icons/0xb2000000000000000000002d0ba3164cc74f58b7.png',
      meta: '/api/public/stocks/icons/0xb2000000000000000000008bc8786b856e61707c.png',
      microsoft: '/api/public/stocks/icons/0xb200000000000000000000ab99cfa739e253872b.png',
    });
    const html = renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(ANSWER), failed: false }} />);
    for (const src of Object.values(LOOP_LOGO_V1)) assert.match(html, new RegExp(`<img class="still-loops-logo" src="${src.replace(/[.]/g, '\\.')}" alt=""`));
    // A Loop on the wall wears its company's mark too.
    assert.match(html, /<div class="still-loops-tile-head"><img class="still-loops-logo" src="\/api\/public\/stocks\/icons\/0xb200000000000000000000c2e324d24d7eecd1fb\.png"/);
  });

  // 2026-11-19: three zeros at the top read as nobody coming.
  it('before the first Loop, says the first number is still unclaimed instead of three zeros', () => {
    const none = { ...ANSWER, counts: { total: 0, week: 0, viaAssistant: 0, byBrand: { apple: 0, amazon: 0, google: 0, meta: 0, microsoft: 0 } }, wall: [] };
    const html = renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(none), failed: false }} />);
    assert.match(html, /<span class="n">#1<\/span><span class="t">still unclaimed: no Loop has been made yet<\/span>/);
    // The ticket carries the five companies' marks.
    assert.equal(html.match(/<div class="still-loops-logos">(.*?)<\/div>/)?.[1]?.match(/<img /g)?.length, 5);
    assert.doesNotMatch(html, /this week/);
    assert.doesNotMatch(html, /so far<\/div>/, 'no brand counts before the first Loop');
    assert.match(html, /No Loop is on the wall yet\./);
    assert.equal(stillLoopDayV1('2026-11-25'), '25\u00a0Nov\u00a02026');
    assert.equal(stillLoopDayV1('not a day'), 'not a day');
  });

  // 2026-11-19: a Loop made in an assistant's chat had no way to the wall but the review page.
  it('shows a signed-in wallet its own Loops, each with the wall to put it on', () => {
    const own = stillLoopsMineViewV1({ outcome: 'mine', loops: [
      { ...LOOP, executionId: EXECUTION, productName: 'iTunes Germany', packageLabel: '25 EUR', day: '2026-11-21' },
      { ...LOOP, loopNo: 0, executionId: EXECUTION, productName: 'x', packageLabel: 'y', day: '2026-11-21' },
    ] });
    assert.equal(own?.length, 1, 'a row of another shape is left out');
    assert.equal(stillLoopsMineViewV1({ outcome: 'nope', loops: [] }), null);
    const html = renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(ANSWER), failed: false, mine: { loops: own, onWall: never } }} />);
    assert.match(html, /<h2 id="still-loops-mine" class="still-more-group-head">Your Loops<\/h2>/);
    assert.match(html, /aria-label="Loop #7"/);
    assert.match(html, />Put it on the Loop wall</);
    const none = renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(ANSWER), failed: false, mine: { loops: [], onWall: never } }} />);
    assert.doesNotMatch(none, /Your Loops/);
  });

  it('says when Loops are not open, are being read, or could not be read', () => {
    assert.match(renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: null, failed: false }} />), /Loops are not open yet\./);
    assert.match(renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: undefined, failed: false }} />), /Reading the Loops…/);
    assert.match(renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: undefined, failed: true }} />), /This is our failure/);
  });

  it('More offers Loops only once the server opened them', () => {
    const off = renderToStaticMarkup(<StillMore model={{ sky: SKY, account: null, signInHref: '/signin' }} />);
    assert.doesNotMatch(off, /href="\/loops"/);
    const on = renderToStaticMarkup(<StillMore model={{ sky: SKY, account: null, signInHref: '/signin', loops: true }} />);
    assert.match(on, /aria-label="Loops"><h2 class="still-more-group-head">Loops<\/h2>/);
    assert.match(on, /href="\/loops"/);
  });
});

describe('/loops: the draw', () => {
  const SKY = skyStateV1({ now: new Date('2026-11-22T12:00:00Z') });
  const OPEN = { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z', closesAt: '2026-11-28T18:00:00.000Z', winnerCount: 1, prizeUsdc: '10', state: 'open',
    entries: 4, entriesHash: null, lockedAt: null, blockAt: null, block: null, winners: [] };
  const DRAWN = { ...OPEN, state: 'drawn', entries: 3, entriesHash: `0x${'1'.repeat(64)}`, lockedAt: '2026-11-28T18:00:31.000Z', blockAt: '2026-11-28T18:05:31.000Z',
    block: { number: '38912345', hash: `0x${'2'.repeat(64)}`, time: '2026-11-28T18:05:31.000Z' }, winners: [{ no: 2, label: 'Entry K3F9X2', paid: true }],
    stamps: [{ tsa: 'http://timestamp.digicert.com', genTime: '2026-11-28T18:00:31.700Z' }, { tsa: 'http://timestamp.sectigo.com', genTime: '2026-11-28T18:00:32.100Z' }] };
  const answer = (draws: unknown) => ({ outcome: 'loops', weekStartsAt: '2026-11-16T00:00:00.000Z',
    counts: { total: 0, week: 0, viaAssistant: 0, byBrand: { apple: 0, amazon: 0, google: 0, meta: 0, microsoft: 0 } }, wall: [], draws });
  const render = (draws: unknown, entry?: Parameters<typeof StillLoops>[0]['model']['entry']) =>
    renderToStaticMarkup(<StillLoops model={{ sky: SKY, view: stillLoopsViewV1(answer(draws)), failed: false, entry }} />);
  const signedOut = { signedIn: false, signInHref: '/signin?next=%2Floops', mine: null, onEnter: never };
  const mine = (patch: Record<string, unknown> = {}) => stillLoopDrawMineViewV1({ outcome: 'mine', team: false,
    current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: null, loop: null }, entered: [], ...patch });

  it('reads the draws the server sends, and leaves the page whole when it cannot', () => {
    assert.equal(stillLoopsViewV1(answer({ current: OPEN, past: [] }))?.draws?.current?.entries, 4);
    assert.equal(stillLoopsViewV1(answer(null))?.draws, null);
    assert.equal(stillLoopsViewV1(answer({ current: { ...OPEN, state: 'maybe' }, past: [] }))?.draws, null);
    assert.equal(stillLoopsViewV1(answer({ current: OPEN, past: [{ ...DRAWN, entriesHash: '0x12' }] }))?.draws, null);
    assert.equal(stillLoopsViewV1(answer({ current: { ...OPEN, winnerCount: 0 }, past: [] }))?.draws, null);
    assert.equal(stillLoopsViewV1(answer({ current: OPEN, past: [{ ...DRAWN, winners: [{ no: 2, label: 'x', paid: 'yes' }] }] }))?.draws, null);
    assert.equal(stillLoopsViewV1(answer({ current: OPEN, past: [] }))?.wall.length, 0);
    assert.equal(stillLoopDrawTimeV1('2026-11-28T18:00:00.000Z'), 'Sat 28 Nov, 18:00 UTC');
    assert.equal(mine()?.current?.entry, null);
    assert.equal(stillLoopDrawMineViewV1({ outcome: 'mine', team: false, current: { drawId: 'x', closesAt: 'never', entry: null }, entered: [] }), null);
  });

  it('offers two ways in side by side, the same button for each, with the prize, the close and the rules', () => {
    const html = render({ current: OPEN, past: [] }, signedOut);
    assert.match(html, /The draw · 10 USDC/);
    assert.match(html, /Closes Sat 28 Nov, 18:00 UTC\. 4 entries so far\. One winner, 10 USDC\./);
    assert.match(html, /Make a Loop.*A Loop made while the draw is open lets you enter with it, with no other check/);
    assert.match(html, /Enter free.*No loan: the same chance as a Loop/);
    // Two free checks, Coinbase's one of them (2026-11-20, the operator): the attestation, or a past swap of 10 USDC.
    assert.match(html, /Your wallet needs one of two: Coinbase’s Verified Account attestation, which needs no purchase/);
    assert.match(html, /a swap of at least\s+10 USDC, to or from USDC, made through Still at any time \(<a href="\/routes"[^>]*>Swap AI<\/a>, or Buy and Sell on Stocks\)/);
    assert.match(html, /the first Base block at least five and a half minutes after the close/);
    assert.match(html, /could not be fixed within two minutes of the close, the block is the first at least five minutes after it was/);
    assert.match(html, /The Still team has committed not to enter\./);
    assert.match(html, /href="\/spend" class="still-btn sec" aria-label="Spend: pick a card to make a Loop">Spend</);
    // Each brand's link says its card to a screen reader (audit UI-5).
    assert.match(html, /href="\/spend\?card=apple" class="still-btn sec" aria-label="Spend: An Apple gift card">Spend</);
    assert.match(html, /href="\/signin\?next=%2Floops" class="still-btn sec">Sign in to enter</, 'the same button as Spend');
    // One rule both ways, and one that can be checked (audit LOOP-2): per wallet, not per person.
    assert.match(html, /the same step: enter here before the close/);
    assert.match(html, /One entry per wallet per draw\./);
    assert.doesNotMatch(html, /per person|one person/);
    assert.match(html, /public time-stamping authorities sign that it existed then/);
    assert.match(html, /not U\.S\. persons/);
    assert.match(html, /keccak256\(block hash, draw\) mod N \+ 1/);
    assert.match(html, /href="https:\/\/github\.com\/mioku50\/miorail\/blob\/main\/scripts\/verify_loop_draw\.ts"/);
    assert.match(html, /href="https:\/\/www\.coinbase\.com\/onchain-verify"/);
    assert.match(html, /10 USDC is sent on Base to the winning wallet within 7 days/);
  });

  it('asks a signed-in person to accept the rules, says when they are in, and never offers it to the team', () => {
    const ask = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true, mine: mine() });
    assert.match(ask, /type="checkbox"/);
    assert.match(ask, /I am 18 or older and I accept the rules below/);
    assert.match(ask, /<button type="button" class="still-btn sec" disabled="">Enter free<\/button>/, 'pressed only once the rules are accepted');
    const reading = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true, mine: undefined });
    assert.match(reading, /Reading your entry…/);
    assert.match(ask, /Free entry needs one of two on this wallet: a swap of at least 10 USDC, to or from USDC, made through Still at any\s+time, or Coinbase’s Verified Account attestation/);
    const loop = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true,
      mine: mine({ current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: { label: 'Loop #7', kind: 'loop' }, loop: null } }) });
    assert.match(loop, /You are in this draw as Loop #7\. One entry per wallet/);
    assert.doesNotMatch(loop, /<button[^>]*>Enter free<\/button>/);
    // A Loop made while open is offered, by the same press and the same confirmations, with no attestation asked.
    const ready = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true,
      mine: mine({ current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: null, loop: { loopNo: 7, ready: true } } }) });
    assert.match(ready, /I am 18 or older and I accept the rules below/);
    assert.match(ready, /<button type="button" class="still-btn sec" disabled="">Enter with Loop #7<\/button>/);
    assert.doesNotMatch(ready, /Free entry needs/);
    const waiting = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true,
      mine: mine({ current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: null, loop: { loopNo: 7, ready: false } } }) });
    assert.match(waiting, /Loop #7: Bitrefill has not delivered its card yet\. Enter with it once the card arrives, before the close\./);
    assert.match(waiting, />Enter free<\/button>/);
    assert.deepEqual(mine({ current: { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: null, loop: { loopNo: 0, ready: true } } })?.current?.loop, null);
    const team = render({ current: OPEN, past: [] }, { ...signedOut, signedIn: true, mine: mine({ team: true }) });
    assert.match(team, /The Still team does not enter its own draws\./);
    assert.doesNotMatch(team, /<button[^>]*>Enter free<\/button>/);
  });

  it('says when the next one opens, and what each past draw fixed, picked and paid, with the person’s own part', () => {
    const upcoming = render({ current: { ...OPEN, state: 'upcoming', entries: 0 }, past: [] }, signedOut);
    assert.match(upcoming, /Opens Sat 21 Nov, 00:00 UTC; closes Sat 28 Nov, 18:00 UTC\./);
    assert.match(upcoming, /Entry opens with the draw\./);
    assert.doesNotMatch(upcoming, /Sign in to enter/);
    const past = render({ current: { ...OPEN, drawId: '2026-12-03', closesAt: '2026-12-03T18:00:00.000Z' }, past: [DRAWN] },
      { ...signedOut, signedIn: true, mine: mine({ entered: [{ drawId: '2026-11-28', label: 'Entry K3F9X2', won: true, paid: true, prizeUsdc: '10' }] }) });
    assert.match(past, /Draw of Sat 28 Nov · 10 USDC/);
    assert.match(past, /3 entries · list 0x11111111…111111 · time-stamped by timestamp\.digicert\.com and timestamp\.sectigo\.com · Base block 38912345 · won by Entry K3F9X2 \(paid\)/);
    assert.match(past, /You won as Entry K3F9X2\. 10 USDC was sent to this wallet\./);
    const nobody = render({ current: null, past: [{ ...DRAWN, entries: 0, entriesHash: `0x${'1'.repeat(64)}`, block: null, blockAt: null, winners: [], stamps: [] }] }, signedOut);
    assert.match(nobody, /No draw is open now\./);
    assert.match(nobody, /nobody entered, so nobody won/);
    assert.doesNotMatch(withoutIcons(past + nobody), /0x[0-9a-f]{40}(?![0-9a-f])/i, 'never a wallet');
  });

  // 2026-11-20: the prize said large, with the time left by the page's own clock.
  it('counts down to the open and then to the close, by the page’s clock, and puts the free way first', () => {
    assert.equal(stillLoopCountdownV1('2026-11-21T00:00:00.000Z', '2026-11-20T04:34:00.000Z'), '19 h 26 min');
    assert.equal(stillLoopCountdownV1('2026-11-28T18:00:00.000Z', '2026-11-22T12:00:00.000Z'), '6 d 6 h');
    assert.equal(stillLoopCountdownV1('2026-11-21T00:00:00.000Z', '2026-11-20T23:59:30.000Z'), '1 min');
    assert.equal(stillLoopCountdownV1('2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'), null);
    assert.equal(stillLoopCountdownV1('never', '2026-11-21T00:00:00.000Z'), null);
    const open = render({ current: { ...OPEN, winnerCount: 3, prizeUsdc: '5' }, past: [] }, signedOut);
    assert.match(open, /<span class="still-loops-prize-amount">3 × 5 USDC<\/span><span class="still-loops-countdown">Closes in 6 d 6 h<\/span>/);
    assert.ok(open.indexOf('Enter free') < open.indexOf('Make a Loop'), 'the free way first');
    const upcoming = renderToStaticMarkup(<StillLoops model={{ sky: skyStateV1({ now: new Date('2026-11-20T04:34:00Z') }),
      view: stillLoopsViewV1(answer({ current: { ...OPEN, state: 'upcoming', entries: 0 }, past: [] })), failed: false, entry: signedOut }} />);
    assert.match(upcoming, />Opens in 19 h 26 min</);
  });

  it('says a list was fixed late, or not time-stamped, instead of leaving it out (audits LOOP-2, LOOP-3)', () => {
    const stamped = render({ current: OPEN, past: [DRAWN] }, signedOut);
    assert.match(stamped, /time-stamped by timestamp\.digicert\.com and timestamp\.sectigo\.com/);
    assert.doesNotMatch(stamped, /fixed late, so its block|no time-stamp:/);
    const late = render({ current: OPEN, past: [{ ...DRAWN, fixedLate: true, stamps: [] }] }, signedOut);
    assert.match(late, /fixed late, so its block followed the moment it was fixed/);
    assert.match(late, /no time-stamp: when it was fixed rests on Still’s word/);
    assert.equal(stillLoopsViewV1(answer({ current: OPEN, past: [{ ...DRAWN, fixedLate: 'yes' }] }))?.draws?.past[0]?.fixedLate, false);
  });

  it('says how many win and how much each, and names every winner', () => {
    const three = { ...OPEN, winnerCount: 3, prizeUsdc: '5' };
    const html = render({ current: three, past: [{ ...DRAWN, winnerCount: 3, prizeUsdc: '5',
      winners: [{ no: 2, label: 'Entry K3F9X2', paid: true }, { no: 3, label: 'Loop #4', paid: false }, { no: 1, label: 'Entry AB12CD', paid: false }] }] }, signedOut);
    assert.match(html, /The draw · 3 × 5 USDC/);
    assert.match(html, /4 entries so far\. Three winners, 5 USDC each\./);
    assert.match(html, /Each next winner is picked the same way from the entries not yet picked, so nobody wins twice\./);
    assert.match(html, /5 USDC is sent on Base to each winning wallet within 7 days/);
    assert.match(html, /Draw of Sat 28 Nov · 3 × 5 USDC/);
    assert.match(html, /won by Entry K3F9X2 \(paid\), Loop #4, Entry AB12CD/);
    assert.equal(stillLoopDrawPrizeV1({ winnerCount: 1, prizeUsdc: '10' }), '10 USDC');
  });
});

describe('the draw’s times by the reader’s clock (audit UI-3)', () => {
  it('adds the local time beside UTC, with the day when it differs, and nothing in UTC', () => {
    assert.equal(stillLoopLocalTimeV1('2026-11-28T18:00:00.000Z', -180), ' (21:00 your time)');
    assert.equal(stillLoopLocalTimeV1('2026-11-21T00:00:00.000Z', 300), ' (Fri 19:00 your time)');
    assert.equal(stillLoopLocalTimeV1('2026-11-28T18:00:00.000Z', 0), '');
    assert.equal(stillLoopLocalTimeV1('never', -180), '');
  });
});

// 2026-11-20, the operator: «ненавязчиво аккуратно добавить на главную страничку loops в виде подарка».
describe('Home: the quiet door to Loops', () => {
  const NO_BRANDS = { apple: 0, amazon: 0, google: 0, meta: 0, microsoft: 0 };
  const DRAW = { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z', closesAt: '2026-11-28T18:00:00.000Z', winnerCount: 3, prizeUsdc: '5',
    state: 'upcoming', entries: 0, entriesHash: null, lockedAt: null, blockAt: null, block: null, winners: [], stamps: [] };
  const view = (draws: unknown) => stillLoopsViewV1({ outcome: 'loops', weekStartsAt: '2026-11-16T00:00:00.000Z',
    counts: { total: 0, week: 0, viaAssistant: 0, byBrand: NO_BRANDS }, wall: [], draws });

  it('says the prize and its free way in, while a draw is coming or open, after the other doors', () => {
    const upcoming = renderToStaticMarkup(<StillSpendDoor loops={view({ current: DRAW, past: [] })} now={Date.parse('2026-11-20T12:00:00.000Z')} />);
    assert.match(upcoming, /<a href="\/loops" class="still-extra is-gift">/);
    assert.match(upcoming, /Free draw: 3 × 5 USDC/);
    // What the free entry takes, not "no loan or purchase needed" alone (audit UI-2, 2026-11-20).
    assert.match(upcoming, /Opens Sat 21 Nov, 00:00 UTC\. Free to enter with Coinbase verification or any past swap of 10\+ USDC on Still\./);
    assert.ok(upcoming.indexOf('Pay a subscription') < upcoming.indexOf('Free draw'), 'the last door');
    const open = renderToStaticMarkup(<StillSpendDoor loops={view({ current: { ...DRAW, state: 'open', entries: 4 }, past: [] })} now={Date.parse('2026-11-22T12:00:00.000Z')} />);
    assert.match(open, /Open until Sat 28 Nov, 18:00 UTC\. Free to enter with Coinbase verification or any past swap of 10\+ USDC on Still\./);
    // Home reads the draws once: the page's clock, not that read, says whether it opened, and the door goes at the close.
    const opened = renderToStaticMarkup(<StillSpendDoor loops={view({ current: DRAW, past: [] })} now={Date.parse('2026-11-21T00:00:01.000Z')} />);
    assert.match(opened, /Open until Sat 28 Nov, 18:00 UTC\./);
    const closed = renderToStaticMarkup(<StillSpendDoor loops={view({ current: { ...DRAW, state: 'open' }, past: [] })} now={Date.parse('2026-11-28T18:00:00.000Z')} />);
    assert.doesNotMatch(closed, /Free draw/);
    assert.match(closed, /<span class="still-extra-title">Loops<\/span>/);
    assert.doesNotMatch(upcoming + open, /borrow to|win by|loan to win/i);
  });

  it('names Loops alone between draws, and is not there while Loops are closed', () => {
    const between = renderToStaticMarkup(<StillSpendDoor loops={view({ current: null, past: [] })} />);
    assert.match(between, /<span class="still-extra-title">Loops<\/span>/);
    assert.doesNotMatch(between, /Free draw/);
    assert.doesNotMatch(renderToStaticMarkup(<StillSpendDoor loops={null} />), /href="\/loops"/);
    assert.doesNotMatch(renderToStaticMarkup(<StillSpendDoor />), /href="\/loops"/);
  });
});
