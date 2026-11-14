import React from 'react';
import { TERMS } from '@mioagent/still-engine/policy';
import type { SkyStateV1 } from './skyState';
import { STILL_ELIGIBILITY_STATEMENT_V1, STILL_ELIGIBLE_JURISDICTIONS_V1, STILL_REGION_ATTRIBUTION_V1, STILL_US_PERSON_DEFINITION_V1 } from '@mioagent/still-engine/eligibility';
import { STILL_ASSISTANTS_V1, StillHeader, StillLink } from './StillFrame';

void React;

// ---------------------------------------------------------------------------
// How Still keeps a loan safe: its risk engine, said for people (operator, 2026-11-08: asked
// about in X comments). Every number here is one of the engine's own terms, read from TERMS,
// so the page cannot say one rule while the engine runs another. It says the mechanism and the
// measured bound, never that a liquidation cannot happen: a fall bigger than the margin starts one.
// ---------------------------------------------------------------------------

export const STILL_SAFETY_V1 = { label: 'Loan safety', path: '/safety' } as const;

const BPS_V1 = 10_000;
/** 5000 → "50%", 3750 → "37.5%". */
const percentV1 = (bps: number): string => `${bps / 100}%`;
/** The health factor at which a margin begins: 1 / (1 − margin), as people read it (1.6, 1.25). */
const healthAtV1 = (marginBps: number): string => String(Math.round((BPS_V1 / (BPS_V1 - marginBps)) * 100) / 100);
/** A New York wall-clock hour as people say it: 20 → "8 PM", 0 → "midnight". */
const clockV1 = ({ hour, minute }: { hour: number; minute: number }): string => {
  if (hour === 0 && minute === 0) return 'midnight';
  if (hour === 12 && minute === 0) return 'noon';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
};

export interface StillSafetyModelV1 {
  sky: SkyStateV1;
}

export function StillSafety({ model }: { model: StillSafetyModelV1 }) {
  const share = Number(TERMS.shareOfProtocolBps);
  const closed = Number(TERMS.weekendStockShareOfProtocolBps);
  const earnings = Number(TERMS.earningsStockShareOfProtocolBps);
  const watch = Number(TERMS.watchBelowBps), act = Number(TERMS.actBelowBps);
  const stricter = closed === earnings
    ? `${percentV1(closed)} of the protocol’s limit`
    : `${percentV1(closed)} of the protocol’s limit while the market is closed and ${percentV1(earnings)} around a report`;
  return (
    <div className="still-safety-page">
      <StillHeader title={STILL_SAFETY_V1.label} sky={model.sky} />
      <div className="still-section">
        <div className="still-word">How Still keeps a loan safe.</div>
        <div className="still-sub">
          Still lends against your stocks and crypto through Aave V4 and Morpho. It keeps each loan far from the point where those protocols
          would liquidate it, and it says how far, in numbers. This is what its engine does, with the terms it uses, and what it cannot prevent.
        </div>
        {/* The three numbers the rest of the page explains, first. */}
        <div className="still-safety-figures">
          <div className="still-safety-figure"><span className="n">{percentV1(share)}</span><span className="t">of what Aave V4 or Morpho would lend, at most</span></div>
          <div className="still-safety-figure"><span className="n">{percentV1(Math.min(closed, earnings))}</span><span className="t">against a stock while Wall Street is closed, or around its earnings</span></div>
          <div className="still-safety-figure"><span className="n">≈{percentV1(BPS_V1 - share)}</span><span className="t">the fall your collateral could take at Still’s full limit before liquidation could start</span></div>
        </div>
      </div>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-half">
        <h2 id="still-safety-half" className="still-safety-head">It lends {share === 5_000 ? 'half' : percentV1(share)} of what the protocol would.</h2>
        <p className="still-note">
          Aave V4 and Morpho each set how much a collateral may borrow, and they liquidate a loan at that same limit. Still lends at most{' '}
          {percentV1(share)} of it. So at Still’s full limit your collateral could lose about {percentV1(BPS_V1 - share)} of its value before
          liquidation could start. The margin is smaller as interest adds to the debt, and it moves with prices.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-closed">
        <h2 id="still-safety-closed" className="still-safety-head">Stricter while Wall Street is closed, and around earnings.</h2>
        <p className="still-note">
          On weekends and market holidays a stock’s reference price stands still while its token keeps trading on Base, and when the market
          reopens the price can jump at once. So from {clockV1(TERMS.weekendStartsFriday)} New York time before a day without a session to{' '}
          {clockV1(TERMS.weekendEndsSunday)} on the evening before the next one, Still lends at most {percentV1(closed)} of the protocol’s limit
          against a stock. An earnings report can move a price the same way: from {clockV1(TERMS.earningsStartsDayBefore)} the day before the
          report date to {clockV1(TERMS.earningsEndsDayAfter)} the day after it, New York time, Still lends at most {percentV1(earnings)} against
          that stock. The two never stack. At {stricter}, the collateral could lose about {percentV1(BPS_V1 - Math.min(closed, earnings))} before
          liquidation could start.
        </p>
        {/* As the engine reads it (calendar.ts, mirror.ts): a stock the calendar lists with an empty list has no report
            scheduled; a stock it leaves out, or a calendar that did not answer, was not read (audit DOC-1, 2026-11-14). */}
        <p className="still-note">
          Still takes report dates from Aave’s own earnings calendar. When that calendar cannot be read, or leaves a stock out, Still cannot
          know that a report is not due, so it lends at most {percentV1(earnings)} against that stock until the stock is back in the calendar:
          for as long as that takes, not for two days. A stock the calendar lists with no upcoming report counts at the usual rate. The line
          under the sky names the stocks this holds for now.
        </p>
        <p className="still-note">
          While the market is open, a stock’s reference price is refreshed at least once a day. If one has gone more than{' '}
          {TERMS.stockPriceStaleAfterHours} hours of open market without a new price, Still does not rely on it at the open rate: it lends at
          most {percentV1(closed)} against that stock until a new price arrives, and Assets says so on that stock’s row. Hours while the
          market is closed do not count, since no price is due then.
        </p>
        <p className="still-note">
          The windows change what you can borrow, not a loan you already have: Still never repays or sells for you. Collateral on Morpho
          (cbBTC, WETH or ETH, and PAXG gold) stays at {percentV1(share)} at all times.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-bands">
        <h2 id="still-safety-bands" className="still-safety-head">Safety bands, read every few minutes.</h2>
        <p className="still-note">
          Still turns a loan’s health factor into a margin: how far all its collateral could fall together before liquidation, which is
          1 − 1 / health factor.
        </p>
        <ul className="still-safety-bands">
          <li><strong>Calm</strong>: a margin of {percentV1(watch)} or more, a health factor of {healthAtV1(watch)} or above.</li>
          <li><strong>Watch</strong>: a margin below {percentV1(watch)}.</li>
          <li><strong>Act</strong>: a margin below {percentV1(act)}, a health factor below {healthAtV1(act)}.</li>
          <li><strong>Liquidation</strong>: a health factor of 1 or below, where the protocol may liquidate the loan.</li>
        </ul>
        <p className="still-note">
          Connect Still’s Telegram alerts and it reads your loans every few minutes, and tells you when one moves into a worse band.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-block">
        <h2 id="still-safety-block" className="still-safety-head">Every figure is read from Base, at one block.</h2>
        <p className="still-note">
          The prices are the protocols’ own oracle prices, the ones they liquidate by. Still reads your position, the protocol’s limits and those
          prices at one Base block, and shows which block. A figure it could not read is shown as not read, never as zero.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-sign">
        <h2 id="still-safety-sign" className="still-safety-head">Checked again before you sign.</h2>
        <p className="still-note">
          Before your wallet is asked, Still reads the position again at the latest block and simulates the exact calls your wallet will send:
          what arrives, the debt after, the health factor after, and Still’s limit. If anything changed since you read it, the review says what.
          Your wallet signs every step. Still holds no keys, and it cannot move your funds.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-ask">
        <h2 id="still-safety-ask" className="still-safety-head">Ask what a fall would do.</h2>
        <p className="still-note">
          Still’s Agent, and your own assistant through <StillLink href={STILL_ASSISTANTS_V1.path}>Still’s MCP server</StillLink>, run the same
          calculation with a price changed, more borrowed or some repaid: for example, what a 30% fall in NVIDIA would do to your loan. The engine
          recalculates the position; a language model only explains the numbers it gives.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-who">
        <h2 id="still-safety-who" className="still-safety-head">Offered only in eligible jurisdictions.</h2>
        <p className="still-note">
          {STILL_ELIGIBLE_JURISDICTIONS_V1} Before it prepares one, the server reads which country your connection comes from (by its IP
          address, <a href={STILL_REGION_ATTRIBUTION_V1.url} target="_blank" rel="noopener noreferrer">{STILL_REGION_ATTRIBUTION_V1.text}</a>),
          and it asks you to confirm once for each sign-in: “{STILL_ELIGIBILITY_STATEMENT_V1}” {STILL_US_PERSON_DEFINITION_V1} An IP address cannot tell Crimea and the
          so-called Donetsk and Luhansk People’s Republics apart from the rest of Ukraine, so for those regions the sentence is the check.
          Do not use a VPN or a proxy to get around it.
        </p>
        <p className="still-note">
          What closes a position is never blocked: from anywhere you can repay a loan, take your collateral back and sell.
        </p>
      </section>

      <section className="still-section still-safety-part" aria-labelledby="still-safety-limits">
        <h2 id="still-safety-limits" className="still-safety-head">What Still cannot prevent.</h2>
        <p className="still-note">
          A fall bigger than the margin can still liquidate a loan, and a price can jump past it at once when the market reopens. Still cannot
          stop a liquidation, and it never repays or sells for you. Aave V4 and Morpho are separate protocols with their own contracts and
          oracles, and Still cannot undo a fault in them. Prices on Base can differ from Wall Street’s.
        </p>
        <p className="still-note">
          Borrowing creates debt, and collateral can be liquidated. Still measures; it gives no advice. These are Still’s terms of {TERMS.version};
          they are versioned, and a review keeps the terms it was made under. Assistants read them with <span className="mono">get_still_terms</span>.
        </p>
      </section>
    </div>
  );
}
