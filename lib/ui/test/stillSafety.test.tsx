import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STILL_ELIGIBILITY_STATEMENT_V1 } from '@mioagent/still-engine/eligibility';
import { TERMS } from '@mioagent/still-engine/policy';
import { skyStateV1 } from '../src/still/skyState';
import { STILL_SAFETY_V1, StillSafety } from '../src/still/StillSafety';

void React;

// 2026-11-08: people asked in X comments how Still's risk engine works. The page says it with the
// engine's own terms, so these tests read the numbers from TERMS, not from the page's own words.
const html = renderToStaticMarkup(<StillSafety model={{ sky: skyStateV1({ now: new Date('2026-11-04T15:00:00Z') }) }} />);
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const pct = (bps: bigint) => `${Number(bps) / 100}%`;

describe('How Still keeps a loan safe', () => {
  it('is a public page under More, by its own path', () => {
    assert.deepEqual(STILL_SAFETY_V1, { label: 'Loan safety', path: '/safety' });
    assert.match(html, /How Still keeps a loan safe\./);
    // The three numbers the page explains, first: the share, the stricter share, the fall a full limit leaves.
    assert.match(html, /<div class="still-safety-figures"><div class="still-safety-figure"><span class="n">50%<\/span>.*?<span class="n">40%<\/span>.*?<span class="n">≈50%<\/span>/);
  });

  it('says each rule with the number the engine lends by', () => {
    assert.match(text, /It lends half of what the protocol would\./);
    assert.ok(text.includes(`Still lends at most ${pct(TERMS.shareOfProtocolBps)} of it.`));
    assert.ok(text.includes(`could lose about ${pct(BigInt(10_000) - TERMS.shareOfProtocolBps)} of its value before liquidation could start`));
    // Closed market and earnings: the stricter share, its windows in New York time, and the margin it leaves.
    assert.ok(text.includes(`Still lends at most ${pct(TERMS.weekendStockShareOfProtocolBps)} of the protocol’s limit against a stock`));
    assert.ok(text.includes(`Still lends at most ${pct(TERMS.earningsStockShareOfProtocolBps)} against that stock`));
    assert.match(text, /from 8 PM New York time before a day without a session to 8 PM on the evening before the next one/);
    assert.match(text, /from midnight the day before the report date to 8 PM the day after it, New York time/);
    assert.match(text, /The two never stack\. At 40% of the protocol’s limit, the collateral could lose about 60% before liquidation could start\./);
    // A price the feed stopped refreshing (audit BASE-7): the hours the engine waits, and the share it then lends at.
    assert.ok(text.includes(`If one has gone more than ${TERMS.stockPriceStaleAfterHours} hours of open market without a new price`));
    assert.ok(text.includes(`it lends at most ${pct(TERMS.weekendStockShareOfProtocolBps)} against that stock until a new price arrives`));
    assert.match(text, /Hours while the market is closed do not count, since no price is due then\./);
    // The calendar as the engine reads it: unread or left out lowers the stock; listed with no report does not (audit DOC-1).
    assert.ok(text.includes(`When that calendar cannot be read, or leaves a stock out, Still cannot know that a report is not due, so it lends at most ${pct(TERMS.earningsStockShareOfProtocolBps)} against that stock until the stock is back in the calendar`));
    assert.match(text, /A stock the calendar lists with no upcoming report counts at the usual rate\./);
    assert.doesNotMatch(text, /While that calendar lists no date for a stock/);
    assert.match(text, /Collateral on Morpho \(cbBTC, WETH or ETH, and PAXG gold\) stays at 50% at all times\./);
    // The bands, as the margin and the health factor where each begins.
    assert.ok(text.includes(`a margin of ${pct(TERMS.watchBelowBps)} or more, a health factor of 1.6 or above`));
    assert.ok(text.includes(`a margin below ${pct(TERMS.actBelowBps)}, a health factor below 1.25`));
    assert.match(text, /1 − 1 \/ health factor/);
    assert.ok(text.includes(`These are Still’s terms of ${TERMS.version};`));
  });

  it('says what checks a loan and what Still cannot prevent, and never that a liquidation cannot happen', () => {
    assert.match(text, /The prices are the protocols’ own oracle prices, the ones they liquidate by\./);
    assert.match(text, /A figure it could not read is shown as not read, never as zero\./);
    assert.match(text, /simulates the exact calls your wallet will send/);
    assert.match(text, /The engine recalculates the position; a language model only explains the numbers it gives\./);
    assert.match(text, /A fall bigger than the margin can still liquidate a loan/);
    assert.match(text, /Still cannot stop a liquidation, and it never repays or sells for you\./);
    assert.match(text, /Borrowing creates debt, and collateral can be liquidated\. Still measures; it gives no advice\./);
    assert.doesNotMatch(text, /liquidation[^.]*(?:impossible|excluded|cannot happen|never happens)|no liquidation|risk-free|guaranteed|you should/i);
    assert.match(html, /href="\/assistants"[^>]*>Still’s MCP server</);
  });

  it('says where Still is offered: eligible jurisdictions, the places named, and who a U.S. person is (audits BASE-2, UI-18)', () => {
    assert.match(html, /<h2 id="still-safety-who" class="still-safety-head">Offered only in eligible jurisdictions\.<\/h2>/);
    assert.match(text, /Coinbase’s tokenized stocks are available only to persons in eligible jurisdictions outside the United States\./);
    assert.match(text, /for a U\.S\. person, or for anyone in the United States, Cuba, Iran, North Korea, Syria, Crimea, or the so-called Donetsk or Luhansk People’s Republics\./);
    assert.ok(text.includes(`“${STILL_ELIGIBILITY_STATEMENT_V1}” A U.S. person is a U.S. citizen or green-card holder, wherever they live, or anyone resident in the United States.`));
    assert.match(text, /An IP address cannot tell Crimea and the so-called Donetsk and Luhansk People’s Republics apart from the rest of Ukraine/);
    assert.match(text, /from anywhere you can repay a loan, take your collateral back and sell\./);
  });
});
