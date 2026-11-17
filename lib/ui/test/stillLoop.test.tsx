import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

void React;

import { lendingLoopWireV1, parseLendingExecutionWireV1 } from '../src/console/lendingReviewView';
import { StillLoopOffer, loopSentenceV1, loopShareTextV1 } from '../src/still/StillLoop';
import { STILL_LOOP_PROMPT_V1, StillLoops, stillLoopsViewV1 } from '../src/still/StillLoops';
import { StillMore } from '../src/still/StillPages';
import { skyStateV1 } from '../src/still/skyState';

const LOOP = { loopNo: 7, brand: 'apple' as const, complete: true, undelivered: null, onWall: false, team: false };
const EXECUTION = '0f6b2a8e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
const never = async () => { throw new Error('not pressed'); };

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
    assert.match(html, /never your wallet or the transaction\. Not affiliated with Apple\./);
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
    const walled = renderToStaticMarkup(<StillLoopOffer model={{ loop: { ...LOOP, onWall: true }, onWall: never }} />);
    assert.match(walled, /On the Loop wall as Loop #7\./);
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
    assert.match(html, /An Apple gift card, paid by a loan against AAPLc/);
    assert.match(html, /An Xbox card, paid by a loan against MSFTc/);
    assert.match(html, new RegExp(STILL_LOOP_PROMPT_V1.replace(/[.€]/g, '.')));
    assert.match(html, /Loop #2 · alice\.base\.eth/);
    assert.match(html, /Apple stock stayed\. iTunes Germany \(25 EUR\) arrived\./);
    assert.match(html, /about \$27 · Aave · Done in Claude · 2026-11-17/);
    assert.match(html, /can be liquidated if prices fall/);
    assert.match(html, /Not affiliated with Apple, Amazon, Google, Meta, Microsoft or Bitrefill/);
    assert.doesNotMatch(html, /0x[0-9a-f]{6}/i);
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
