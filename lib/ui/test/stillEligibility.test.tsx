import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STILL_ELIGIBILITY_STATEMENT_V1, STILL_ELIGIBILITY_VERSION_V1 } from '@mioagent/still-engine/eligibility';
import { StillEligibilityBarV1, StillEligibilityContext, StillFrame, skyStateV1, spendOrderErrorV1, stillEligibilityViewV1, stillRegionRefusalDetailV1 } from '../src/still';
import { stillPlaceInSentenceV1 } from '../src/still/stillEligibility';
import { swapPrepareNoticeV1 } from '../src/console/consoleFlow';
import { stockConfirmFailureCopyV1 } from '../src/console/stockActionReviewConsole';

void React;

// Still is not offered in the United States or to US persons (2026-11-10).
// What the server sees decides; these words only say what it decided.
const read = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 'still-eligibility/v1', gate: 'on', region: { state: 'allowed', country: 'DE', reason: null },
  table: { loaded: true, month: '2026-11' }, signedIn: true, confirmed: false, confirmedAt: null,
  statement: STILL_ELIGIBILITY_STATEMENT_V1, version: STILL_ELIGIBILITY_VERSION_V1,
  restrictedDetail: 'Still is not available where you are connecting from. It prepares no new loan, purchase or stock buy for anyone in the United States, or for a US person. You can still repay a loan, take your collateral back and sell.',
  open: 'You can still repay a loan, take your collateral back and sell.', attribution: { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' }, ...over,
});
const US = 'Still is not available where you are connecting from. It prepares no new loan, purchase or stock buy for anyone in the United States, or for a US person. You can still repay a loan, take your collateral back and sell.';

describe('where Still is offered, as a page says it', () => {
  it('reads the server’s answer into one of four things to say', () => {
    assert.deepEqual(stillEligibilityViewV1(read()), { kind: 'confirm', statement: STILL_ELIGIBILITY_STATEMENT_V1, version: STILL_ELIGIBILITY_VERSION_V1 });
    assert.deepEqual(stillEligibilityViewV1(read({ confirmed: true })), { kind: 'clear' });
    assert.deepEqual(stillEligibilityViewV1(read({ signedIn: false })), { kind: 'clear' });
    assert.deepEqual(stillEligibilityViewV1(read({ gate: 'off', region: { state: 'restricted', country: 'US', reason: null } })), { kind: 'clear' });
    const us = stillEligibilityViewV1(read({ region: { state: 'restricted', country: 'US', reason: null } }));
    assert.deepEqual(us, { kind: 'restricted', country: 'US', place: 'United States', detail: US,
      reason: 'Still prepares no new loan, purchase or stock buy for a connection from the United States.', open: 'You can still repay a loan, take your collateral back and sell.' });
    // The server's own reason, of the place the connection is in, when it gives one.
    const iran = stillEligibilityViewV1(read({ region: { state: 'restricted', country: 'IR', reason: null }, restrictedReason: 'Still prepares nothing new from Iran.' }));
    assert.equal(iran?.kind === 'restricted' && iran.reason, 'Still prepares nothing new from Iran.');
    // An unchecked place says to try again later, as the server does.
    assert.match((stillEligibilityViewV1(read({ region: { state: 'unchecked', country: null, reason: 'no_table' } })) as { detail: string }).detail, /sell\. Try again later\.$/);
    assert.deepEqual(['United States', 'U.S. Virgin Islands', 'United Kingdom', 'Iran', 'Puerto Rico', 'Northern Mariana Islands'].map(stillPlaceInSentenceV1),
      ['the United States', 'the U.S. Virgin Islands', 'the United Kingdom', 'Iran', 'Puerto Rico', 'the Northern Mariana Islands']);
    assert.equal(stillEligibilityViewV1(read({ region: { state: 'unchecked', country: null, reason: 'no_table' } }))?.kind, 'unchecked');
    // The sentence confirmed is the server's own, under its own name.
    assert.deepEqual(stillEligibilityViewV1(read({ statement: 'A newer sentence.', version: 'not-us-person-2027-01-01' })), { kind: 'confirm', statement: 'A newer sentence.', version: 'not-us-person-2027-01-01' });
    for (const broken of [null, {}, read({ schemaVersion: 'v0' }), read({ region: null }), read({ region: { state: 'maybe' } }), read({ region: { state: 'restricted', country: 'usa' } })]) {
      assert.equal(stillEligibilityViewV1(broken), null);
    }
  });

  it('draws the refusal with the place and the source, the confirmation as one box, and nothing when clear', () => {
    const restricted = renderToStaticMarkup(<StillEligibilityBarV1 view={stillEligibilityViewV1(read({ region: { state: 'restricted', country: 'US', reason: null } }))} onConfirm={() => {}} />);
    assert.match(restricted, /class="still-eligibility is-restricted" role="status"/);
    // What stays open first, the reason once, and why a person elsewhere may be placed there (audit UI-11).
    assert.match(restricted, /<strong>New loans, purchases and stock buys are not offered from here<\/strong><p>You can still repay a loan, take your collateral back and sell\.<\/p><p>Still prepares no new loan, purchase or stock buy for a connection from the United States\.<\/p>/);
    assert.doesNotMatch(restricted, /not available where you are connecting from/);
    assert.match(restricted, /placed in the United States by its IP address\. If you are not there,\s+the address may belong to a VPN, a proxy or a network that routes through it\./);
    assert.match(restricted, /<a href="https:\/\/db-ip.com" target="_blank" rel="noopener noreferrer">IP geolocation by DB-IP<\/a>/);
    assert.doesNotMatch(restricted, /type="checkbox"/);
    const confirm = renderToStaticMarkup(<StillEligibilityBarV1 view={stillEligibilityViewV1(read())} onConfirm={() => {}} />);
    assert.equal(confirm.includes(`<input type="checkbox"/><span>${STILL_ELIGIBILITY_STATEMENT_V1}</span>`), true);
    // Eligible jurisdictions, with the sanctioned places named in the sentence itself (audit BASE-2).
    assert.equal(STILL_ELIGIBILITY_STATEMENT_V1, 'I am not a U.S. person, and I am not currently located in the United States, Cuba, Iran, North Korea, Syria, Crimea, or the so-called Donetsk or Luhansk People’s Republics.');
    assert.match(confirm, /Still is offered only in eligible jurisdictions, and never to U\.S\. persons\./);
    // Who a U.S. person is, right under the box: a citizen abroad is one (audit UI-18).
    assert.match(confirm, /<\/label><p class="still-eligibility-define">A U\.S\. person is a U\.S\. citizen or green-card holder, wherever they live, or anyone resident in the United States\.<\/p>/);
    assert.match(confirm, /<button type="button" class="still-eligibility-confirm" disabled="">Confirm<\/button>/);
    assert.match(confirm, /Repaying, taking collateral back and selling never ask for this/);
    const failed = renderToStaticMarkup(<StillEligibilityBarV1 view={stillEligibilityViewV1(read())} error="Your confirmation could not be saved." onConfirm={() => {}} />);
    assert.match(failed, /role="alert">Your confirmation could not be saved.<\/p>/);
    assert.equal(renderToStaticMarkup(<StillEligibilityBarV1 view={{ kind: 'clear' }} onConfirm={() => {}} />), '');
    assert.equal(renderToStaticMarkup(<StillEligibilityBarV1 view={null} onConfirm={() => {}} />), '');
  });

  it('sits at the top of every Still page, before the page itself', () => {
    const html = renderToStaticMarkup(
      <StillEligibilityContext.Provider value={<p className="line">where</p>}>
        <StillFrame tab="assets" sky={skyStateV1({ now: new Date('2026-11-10T12:00:00Z') })}><p className="page">page</p></StillFrame>
      </StillEligibilityContext.Provider>,
    );
    assert.match(html, /<main class="still-main"><p class="line">where<\/p><p class="page">page<\/p><\/main>/);
  });

  it('carries the server’s sentence into Swap AI, a stock buy, Spend and the confirmation itself', () => {
    const detail = 'Still is not available where you are connecting from.';
    assert.equal(stillRegionRefusalDetailV1(new Error(`region_restricted: ${detail}`)), detail);
    assert.equal(stillRegionRefusalDetailV1(new Error('spend_rate_limited')), null);
    assert.deepEqual(swapPrepareNoticeV1({ outcome: 'unsupported', reason: 'region_restricted', detail } as never), { title: 'Still does not prepare a stock buy from here', detail });
    const confirmFirst = swapPrepareNoticeV1({ outcome: 'unsupported', reason: 'eligibility_required', detail: 'Confirm first.' } as never);
    assert.equal(confirmFirst?.canCompareAgain, true);
    assert.match(confirmFirst?.detail ?? '', /Confirm at the top of this page, then compare again\./);
    assert.equal(stockConfirmFailureCopyV1(new Error(`region_restricted: ${detail}`)), detail);
    assert.match(stockConfirmFailureCopyV1(new Error('eligibility_required: Confirm first.')), /then confirm the buy again/);
    assert.equal(spendOrderErrorV1(`region_restricted: ${detail}`), detail);
    assert.match(spendOrderErrorV1('region_unchecked'), /Nothing was opened/);
  });
});
