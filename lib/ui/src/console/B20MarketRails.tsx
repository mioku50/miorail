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
// figure is not in the response it is not on the screen. Rows outside the
// configured round-trip reference remain visible and are labelled here.
//
// The exception is Your Exit Coverage, which cannot be computed server-side:
// it needs the wallet's position, and Miorail's server never receives a
// balance. So it calls the SAME shared projection the server would have used,
// imported directly rather than reimplemented.
// ---------------------------------------------------------------------------

/** §6 — on every card. These are measurements, not advice. */
export const MARKET_RAIL_DISCLAIMER_V1 = 'A measured view, not a recommendation.';

/** A round-trip profile miss is still measured evidence. The default rail
 * keeps it visible and counts it so the card can state the distinction instead
 * of allowing a 3% reference to turn a working measurement into an empty UI. */
export function defaultRailLeadersV1(leaders: readonly ExitCapacityLeaderV1[]): {
  shown: ExitCapacityLeaderV1[];
  outsideReference: number;
} {
  return {
    shown: [...leaders],
    outsideReference: leaders.filter((entry) => entry.profileStatus === 'outside_round_trip_reference').length,
  };
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
  const { shown, outsideReference } = defaultRailLeadersV1(model.leaders);
  const visible = shown.slice(0, model.expanded ? RAIL_FULL_V1 : RAIL_TOP_V1);

  return (
    <div className="rp">
      <div className="rph">
        Measured Exit Capacity
        <span className="rt">{bpsLabelV1(model.toleranceBps)} exit slippage</span>
      </div>
      <div className="rpb">
        {model.loading ? (
          <RailEmpty>Reading measured exits…</RailEmpty>
        ) : model.unavailableReason ? (
          <RailEmpty>{model.unavailableReason}</RailEmpty>
        ) : visible.length === 0 ? (
          <RailEmpty>
            No stable exit ladder has measured capacity within {bpsLabelV1(model.toleranceBps)} exit
            slippage. That is about Miorail evidence, not about what can be sold.
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
                <span className={`v mono${leader.profileStatus === 'outside_round_trip_reference' ? ' warn' : ''}`}>
                  {/* The BOUND. "at least" is not decoration: the ladder knows
                      the largest size that passed and nothing above it. */}
                  ≥ {amountLabelV1(leader.largestPassingSizeAtomic, leader.decimals, leader.symbol)}
                  <span className="rail-reference">
                    {bpsLabelV1(leader.capacityCoverageBps)} of reference entry ·{' '}
                    {leader.optimisticRoundTripBps === null
                      ? 'round trip not measured'
                      : `${bpsLabelV1(leader.optimisticRoundTripBps)} round trip · ${
                          leader.profileStatus === 'outside_round_trip_reference' ? 'outside' : 'within'
                        } ${bpsLabelV1(leader.roundTripReferenceBps)} reference`}
                  </span>
                  <span className={`rail-reference rail-freshness${leader.freshness === 'stale' ? ' off' : ''}`}>
                    {leader.freshness === 'stale' ? 'past freshness window · ' : ''}
                    {measuredAgoLabelV1(leader.measuredAt, model.now)}
                  </span>
                </span>
              </div>
            ))}
            <p className="lnote">
              Ordered only by measured exit coverage relative to one Miorail reference entry, within{' '}
              {bpsLabelV1(model.toleranceBps)} slippage. Nothing between the largest passing and first failing size
              was measured. {MARKET_RAIL_DISCLAIMER_V1}
            </p>
            {outsideReference > 0 && (
              <p className="lnote">
                {outsideReference} measured profile{outsideReference === 1 ? '' : 's'} exceed
                {outsideReference === 1 ? 's' : ''} the configured round-trip reference and remain
                {outsideReference === 1 ? 's' : ''} visible in amber.
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
                <span
                  className={`v mono${
                    mover.profileStatus === 'outside_round_trip_reference' ? ' warn' : mover.changeBps > 0 ? ' ok' : ''
                  }`}
                >
                  {signedBpsLabelV1(mover.changeBps)}
                  <span className="rail-reference">
                    {bpsLabelV1(mover.optimisticRoundTripBps)} round trip ·{' '}
                    {mover.profileStatus === 'outside_round_trip_reference' ? 'outside' : 'within'}{' '}
                    {bpsLabelV1(mover.roundTripReferenceBps)} reference
                  </span>
                  <span className={`rail-reference rail-freshness${mover.freshness === 'stale' ? ' off' : ''}`}>
                    {mover.freshness === 'stale' ? 'past freshness window · ' : ''}
                    {measuredAgoLabelV1(mover.measuredAt, model.now)}
                  </span>
                </span>
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
