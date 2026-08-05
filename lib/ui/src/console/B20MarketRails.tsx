import React from 'react';
import {
  exitCoverageV1,
  type ExitCapacityLeaderV1,
  type MarketObservationV1,
  type MeasuredMoverV1,
} from '@mioagent/opportunity-rail/marketRails';
import { formatAtomicAmount } from '../formatAtomicAmount';
import { bpsLabelV1 } from './B20ExitCard';

void React;

// ---------------------------------------------------------------------------
// T73-UI — the market rails on Portfolio.
//
// Every number here was computed by the server from stored observations. The
// client sorts nothing, ranks nothing and recomputes nothing (§2/§4): if a
// figure is not in the response it is not on the screen. The one thing this
// file decides is which rows a user is shown by DEFAULT, and it says so out
// loud rather than filtering quietly.
//
// The exception is Your Exit Coverage, which cannot be computed server-side:
// it needs the wallet's position, and Miorail's server never receives a
// balance. So it calls the SAME shared projection the server would have used,
// imported directly rather than reimplemented.
// ---------------------------------------------------------------------------

/** §6 — on every card. These are measurements, not advice. */
export const MARKET_RAIL_DISCLAIMER_V1 = 'A measured view, not a recommendation.';

/**
 * §4 — rejected tokens are not shown by default.
 *
 * The API still returns them, and deliberately: a rejected token can have real
 * measured capacity, and the endpoint's job is to report what was measured.
 * Deciding that a user browsing their portfolio should not be handed a list
 * headed by a token Miorail rejected is a PRODUCT choice, so it is made here,
 * once, with the count of what it hid stated on the card.
 */
export function defaultRailLeadersV1(leaders: readonly ExitCapacityLeaderV1[]): {
  shown: ExitCapacityLeaderV1[];
  hiddenRejected: number;
} {
  const shown = leaders.filter((entry) => entry.state !== 'rejected');
  return { shown, hiddenRejected: leaders.length - shown.length };
}

function amountLabelV1(atomic: string, decimals: number | null, symbol: string): string {
  // Unknown decimals are stated, never divided by an assumed 18.
  if (decimals === null) return `${atomic} (atomic)`;
  return `${formatAtomicAmount(atomic, decimals)} ${symbol}`;
}

/** "measured 4 min ago". Whole minutes: a measurement age to the second
 * implies a precision the pass schedule does not have. */
export function measuredAgoLabelV1(measuredAt: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(measuredAt)) / 1000));
  if (seconds < 60) return 'measured just now';
  if (seconds < 3600) return `measured ${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `measured ${Math.floor(seconds / 3600)} h ago`;
  return `measured ${Math.floor(seconds / 86_400)} d ago`;
}

/** Basis points as a signed percentage, for a 24h move. */
export function signedBpsLabelV1(bps: number): string {
  return `${bps > 0 ? '+' : ''}${bpsLabelV1(bps)}`;
}

export type MarketRailStateV1 = 'loading' | 'ready' | 'unavailable' | 'collecting_history';

export interface B20MarketRailsModelV1 {
  loading: boolean;
  /** Present when the rails could not be read. Never an empty list instead. */
  unavailableReason: string | null;
  leaders: readonly ExitCapacityLeaderV1[];
  movers: readonly MeasuredMoverV1[];
  collectingHistory: boolean;
  toleranceBps: number;
  moveLabel: string;
  moveNote: string;
  now: Date;
  /** §3 — the rail shows five; the full ten opens from here. */
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenToken?: (tokenAddress: string) => void;
}

const RAIL_TOP_V1 = 5;
const RAIL_FULL_V1 = 10;

function RailEmpty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function B20ExitCapacityLeadersCard(model: B20MarketRailsModelV1) {
  const { shown, hiddenRejected } = defaultRailLeadersV1(model.leaders);
  const visible = shown.slice(0, model.expanded ? RAIL_FULL_V1 : RAIL_TOP_V1);

  return (
    <div className="rp">
      <div className="rph">
        Exit Capacity Leaders
        <span className="rt">{bpsLabelV1(model.toleranceBps)} slippage</span>
      </div>
      <div className="rpb">
        {model.loading ? (
          <RailEmpty>Reading measured exits…</RailEmpty>
        ) : model.unavailableReason ? (
          <RailEmpty>{model.unavailableReason}</RailEmpty>
        ) : visible.length === 0 ? (
          <RailEmpty>
            No fresh exit measurement passed the {bpsLabelV1(model.toleranceBps)} tolerance. That is about what
            Miorail has measured, not about what can be sold.
          </RailEmpty>
        ) : (
          <>
            {visible.map((leader) => (
              <div className="qrow" key={leader.tokenAddress}>
                <span>
                  {model.onOpenToken ? (
                    <button type="button" className="btn sec" onClick={() => model.onOpenToken?.(leader.tokenAddress)}>
                      {leader.symbol}
                    </button>
                  ) : (
                    leader.symbol
                  )}
                </span>
                <span className="v mono">
                  {/* The BOUND. "at least" is not decoration: the ladder knows
                      the largest size that passed and nothing above it. */}
                  ≥ {amountLabelV1(leader.largestPassingSizeAtomic, leader.decimals, leader.symbol)}
                </span>
              </div>
            ))}
            <p className="lnote">
              Largest size that passed a probe within tolerance. Nothing between that and the first failing size
              was measured. {MARKET_RAIL_DISCLAIMER_V1}
            </p>
            {hiddenRejected > 0 && (
              // §4 — stated, not silent. A filtered list that does not say it
              // filtered is a list a user cannot reason about.
              <p className="lnote">
                {hiddenRejected} token{hiddenRejected === 1 ? '' : 's'} with measured capacity {hiddenRejected === 1 ? 'is' : 'are'} hidden here
                because Miorail rejected {hiddenRejected === 1 ? 'it' : 'them'} on another measurement.
              </p>
            )}
            {shown.length > RAIL_TOP_V1 && (
              <button type="button" className="btn sec" onClick={model.onToggleExpanded}>
                {model.expanded ? 'Show top 5' : `View top ${Math.min(RAIL_FULL_V1, shown.length)}`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function B20MeasuredMoversCard(model: B20MarketRailsModelV1) {
  const visible = model.movers.slice(0, model.expanded ? RAIL_FULL_V1 : RAIL_TOP_V1);

  return (
    <div className="rp">
      <div className="rph">
        24h Measured Movers
        <span className="rt">Miorail quotes</span>
      </div>
      <div className="rpb">
        {model.loading ? (
          <RailEmpty>Reading measured quotes…</RailEmpty>
        ) : model.unavailableReason ? (
          <RailEmpty>{model.unavailableReason}</RailEmpty>
        ) : model.collectingHistory ? (
          // §5 — only when time is the ONLY thing missing. The server decides
          // that; the client does not infer it from an empty list.
          <>
            <RailEmpty>Collecting 24h history</RailEmpty>
            <p className="lnote">
              Miorail needs two measurements about 24 hours apart to state a change. It has not been measuring
              this set for long enough yet.
            </p>
          </>
        ) : visible.length === 0 ? (
          <RailEmpty>
            No token has two comparable measurements about 24 hours apart right now.
          </RailEmpty>
        ) : (
          <>
            {visible.map((mover) => (
              <div className="qrow" key={mover.tokenAddress}>
                <span>
                  {model.onOpenToken ? (
                    <button type="button" className="btn sec" onClick={() => model.onOpenToken?.(mover.tokenAddress)}>
                      {mover.symbol}
                    </button>
                  ) : (
                    mover.symbol
                  )}
                </span>
                <span className={`v mono${mover.changeBps > 0 ? ' ok' : ''}`}>{signedBpsLabelV1(mover.changeBps)}</span>
              </div>
            ))}
            {/* The label is the server's, verbatim. Shortening it to "24h" is
                exactly the paraphrase this metric must not suffer. */}
            <p className="lnote">{model.moveLabel}</p>
            <p className="lnote">{model.moveNote}</p>
            <p className="lnote">{MARKET_RAIL_DISCLAIMER_V1}</p>
            {model.movers.length > RAIL_TOP_V1 && (
              <button type="button" className="btn sec" onClick={model.onToggleExpanded}>
                {model.expanded ? 'Show top 5' : `View top ${Math.min(RAIL_FULL_V1, model.movers.length)}`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5 — Your Exit Coverage
// ---------------------------------------------------------------------------

export interface B20ExitCoverageModelV1 {
  tokenAddress: string;
  symbol: string;
  decimals: number | null;
  /** Atomic units of the token this wallet holds. */
  positionAtomic: string;
  /** The latest observation for this token, or null. */
  observation: MarketObservationV1 | null;
  now: Date;
}

const COVERAGE_TONE_V1: Record<string, string> = {
  covered: 'g',
  partial: 'a',
  uncovered: 'a',
  unmeasured: 'n',
};

const COVERAGE_LABEL_V1: Record<string, string> = {
  covered: 'position fits',
  partial: 'partly measured',
  uncovered: 'largely unmeasured',
  unmeasured: 'not measured',
};

export function B20ExitCoverageCard(model: B20ExitCoverageModelV1) {
  // The SAME projection the server uses. Computed here only because the server
  // never receives a wallet balance and must not start.
  const coverage = exitCoverageV1({
    tokenAddress: model.tokenAddress,
    symbol: model.symbol,
    decimals: model.decimals,
    positionAtomic: model.positionAtomic,
    observation: model.observation,
    now: model.now,
  });

  return (
    <div className="rp">
      <div className="rph">
        Your Exit Coverage
        <span className="rt">
          <span className={`pill ${COVERAGE_TONE_V1[coverage.verdict] ?? 'n'}`}>
            {COVERAGE_LABEL_V1[coverage.verdict]}
          </span>
        </span>
      </div>
      <div className="rpb">
        <div className="qrow">
          <span>Your position</span>
          <span className="v mono">{amountLabelV1(coverage.positionAtomic, model.decimals, model.symbol)}</span>
        </div>
        <div className="qrow">
          <span>Measured exit</span>
          <span className={`v mono${coverage.measuredCapacityAtomic ? '' : ' off'}`}>
            {/* Null renders the words. A 0% here would read as "you cannot sell
                this", which is a claim nothing measured. */}
            {coverage.measuredCapacityAtomic
              ? `≥ ${amountLabelV1(coverage.measuredCapacityAtomic, model.decimals, model.symbol)}`
              : 'not measured'}
          </span>
        </div>
        <div className="qrow">
          <span>Coverage</span>
          <span className="v mono">{coverage.coverageBps === null ? 'not measured' : bpsLabelV1(coverage.coverageBps)}</span>
        </div>
        {coverage.measuredAt && (
          <div className="qrow">
            <span>Freshness</span>
            <span className={`v${coverage.freshness === 'fresh' ? ' ok' : ' off'}`}>
              {coverage.freshness === 'fresh' ? measuredAgoLabelV1(coverage.measuredAt, model.now) : 'past its window'}
            </span>
          </div>
        )}
        <p className="lnote">{coverage.note}</p>
        {coverage.controlNote && <p className="note warn">{coverage.controlNote}</p>}
        <p className="lnote">{MARKET_RAIL_DISCLAIMER_V1}</p>
      </div>
    </div>
  );
}
