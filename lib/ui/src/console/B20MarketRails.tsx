import React from 'react';
import {
  exitCoverageV1,
  type ExitCapacityLeaderV1,
  type MarketObservationV1,
  type MeasuredMoverV1,
} from '@mioagent/opportunity-rail/marketRails';
import { formatCompactAtomicAmount } from '../formatAtomicAmount';
import { bpsLabelV1 } from './B20ExitCard';
import { factValueClassV1 } from './opportunityCardView';
import { TokenIdentityV1 } from './TokenIdentity';

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

function amountLabelV1(atomic: string, decimals: number | null, unit: string): string {
  // Unknown decimals are stated, never divided by an assumed 18.
  if (decimals === null) return `${atomic} (atomic)`;
  return formatCompactAtomicAmount(atomic, decimals) + ' ' + unit;
}

/**
 * How long a measurement counts as current, read off the data.
 *
 * The window is the worker's `--stale-after` and this file may not assume it:
 * a number typed here becomes a lie the first time an operator changes the
 * flag. Null when there is nothing to read, or when the rows disagree — then
 * the screen says nothing rather than picking one of them to state as the rule.
 */
export function freshnessWindowLabelV1(
  leaders: readonly { measuredAt: string; staleAfter: string }[],
): string | null {
  const windows = new Set<number>();
  for (const leader of leaders) {
    const span = Date.parse(leader.staleAfter) - Date.parse(leader.measuredAt);
    if (!Number.isFinite(span) || span <= 0) return null;
    windows.add(span);
  }
  if (windows.size !== 1) return null;
  const ms = [...windows][0]!;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
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

/**
 * The same clock, worded as a VALUE rather than a sentence.
 *
 * The rail rows now sit under a `Freshness` label, and "Freshness · measured
 * 4 h ago" says the same word twice. Same thresholds as `measuredAgoLabelV1`,
 * which stays because Your Exit Coverage renders a sentence, not a field.
 */
export function measuredAgeLabelV1(measuredAt: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(measuredAt)) / 1000));
  if (seconds < 60) return 'just measured';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min old`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h old`;
  return `${Math.floor(seconds / 86_400)} d old`;
}

/** Basis points as a signed percentage, for a 24h move. */
export function signedBpsLabelV1(bps: number): string {
  return `${bps > 0 ? '+' : ''}${bpsLabelV1(bps)}`;
}

/**
 * A 24h change in ROUND-TRIP COST, in percentage points.
 *
 * `+1.97%` beside a token symbol is read as "this token is up 1.97%". It is
 * not: it is the change in what a measured round trip COSTS, so a positive
 * number is worse rather than better, and it is a difference between two
 * percentages — which makes its unit a percentage point, not a percent.
 *
 * The arrow carries the direction because a leading `+` is the one character a
 * reader most associates with a price going up. The calculation is untouched;
 * `signedBpsLabelV1` stays for anything that really is a signed percentage.
 */
export function roundTripChangeLabelV1(bps: number): string {
  if (bps === 0) return 'no change';
  const points = Math.abs(bps) / 100;
  const rendered = Number.isInteger(points) ? String(points) : points.toFixed(2);
  return `${bps > 0 ? '↑' : '↓'} ${rendered} pp`;
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

// ---------------------------------------------------------------------------
// A rail row, as a reader meets it.
//
// It used to be one right-aligned stack:
//
//   ≥ 1.026B BWIF / 100% of reference entry / 4.11% round trip /
//   outside 3% reference / past freshness window
//
// — five measured facts run together with nothing saying which was which, so
// the only way to read it was to already know the vocabulary. Every one of
// those facts is still here, each under the name of what it is. Nothing was
// dropped, rounded differently or turned into a word: `≥` still marks a lower
// bound, an unmeasured round trip still says so instead of showing a number,
// and a stale row still carries its window.
// ---------------------------------------------------------------------------

interface RailFactV1 {
  label: string;
  value: string;
  /**
   * A one-word state marker beside the value, or null.
   *
   * Reserved for the one thing a reader must not read wrongly at a glance: a
   * measurement past its freshness window sitting in what looks like a live
   * ranking. Every other qualifier — what the bound means, what the reference
   * is — is said once under "How this is ranked" instead of on every row.
   */
  mark: string | null;
  tone: 'plain' | 'warn' | 'off';
}

function RailRow({
  symbol,
  tokenAddress,
  facts,
  onOpenToken,
}: {
  symbol: string;
  tokenAddress: string;
  facts: readonly RailFactV1[];
  onOpenToken?: (tokenAddress: string) => void;
}) {
  return (
    <div className="qrow rail-row" key={tokenAddress}>
      {/* Symbol AND address. Two rows reading `CHEESEBURGE` were two different
          contracts with different numbers, and nothing on the rail said so. */}
      <span className="rail-token">
        <TokenIdentityV1 symbol={symbol} tokenAddress={tokenAddress} />
      </span>
      <dl className="rail-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              <strong className={`rail-fact-v ${fact.tone} ${factValueClassV1(fact.value)}`}>
                {fact.value}
              </strong>
              {fact.mark ? <span className="pill n rail-fact-mark">{fact.mark}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {onOpenToken && (
        <button type="button" className="btn sec rail-open" onClick={() => onOpenToken(tokenAddress)}>
          View measurement
        </button>
      )}
    </div>
  );
}

/**
 * Freshness as a fact, with the one marker that stays on the row.
 *
 * Stale keeps its age — a measurement past its window is still the measurement
 * that was taken, and hiding the age would leave a reader unable to tell an
 * hour-old reading from a week-old one. The `stale` chip is what stops that age
 * being read as part of a current ranking.
 */
function freshnessFactV1(measuredAt: string, freshness: 'fresh' | 'stale', now: Date): RailFactV1 {
  return {
    label: 'Freshness',
    value: measuredAgeLabelV1(measuredAt, now),
    mark: freshness === 'stale' ? 'stale' : null,
    tone: freshness === 'stale' ? 'off' : 'plain',
  };
}

/** The round-trip cost. Null renders the words: a round trip that did not
 * measure is not a round trip of zero. Amber says it is above the configured
 * reference; what that reference is, is stated once under the header. */
function roundTripFactV1(input: {
  optimisticRoundTripBps: number | null;
  roundTripReferenceBps: number;
  profileStatus: string;
}): RailFactV1 {
  if (input.optimisticRoundTripBps === null) {
    return { label: 'Round-trip cost', value: 'not measured', mark: null, tone: 'off' };
  }
  return {
    label: 'Round-trip cost',
    value: bpsLabelV1(input.optimisticRoundTripBps),
    mark: null,
    tone: input.profileStatus === 'outside_round_trip_reference' ? 'warn' : 'plain',
  };
}

// ---------------------------------------------------------------------------
// The qualifiers, said once.
//
// Every rail row used to carry its own explanation: "lower bound · 100% of
// reference entry" under the size, "above 3% reference" under the cost, "past
// freshness window" under the age. Five rows meant fifteen repetitions of three
// sentences, and the numbers a reader came for were the smallest thing in the
// column.
//
// Nothing was dropped. Each of those sentences is here, in full, under the
// header — where a reader meets it once and can return to it. The one qualifier
// that stays on the row is the `stale` chip, because that one changes what the
// row IS rather than explaining what it means.
// ---------------------------------------------------------------------------
function RailGuide({ children, summary }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="discover-guide rail-guide">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

// ---------------------------------------------------------------------------
// When the whole rail is historical, the rail says so — in its NAME.
//
// A per-row `stale` chip is the right marker for one row among fresh ones. It
// is the wrong marker when every row carries it: the reader meets the title
// first, then a ranked list of big numbers, and only afterwards a chip they
// have already learned to skip. The list reads as a current leaderboard for as
// long as it takes to notice five identical chips.
//
// So the title changes with the content. "Measured exit liquidity" is a claim
// about now; "Historical exit measurements" is a claim about the past, and only
// one of them can be true of a rail where nothing is inside its window. The
// badge sits beside it for the reader who scans headers and never reads prose,
// and the row chips stay exactly as they were.
// ---------------------------------------------------------------------------
function RailHeading({
  live,
  historical,
  allStale,
  trailing,
}: {
  live: string;
  historical: string;
  allStale: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="rph">
      {allStale ? historical : live}
      {allStale && <span className="pill a">STALE DATA</span>}
      {trailing}
    </div>
  );
}

export function B20ExitCapacityLeadersCard(model: B20MarketRailsModelV1) {
  const { shown, outsideReference } = defaultRailLeadersV1(model.leaders);
  const visible = shown.slice(0, model.expanded ? RAIL_FULL_V1 : RAIL_TOP_V1);
  // Of what is ON SCREEN. A note about rows the reader cannot see would be
  // about a different list than the one they are reading.
  const allStale = visible.length > 0 && visible.every((leader) => leader.freshness === 'stale');
  const freshnessWindow = freshnessWindowLabelV1(shown);

  return (
    <div className="rp">
      {/* "Capacity" is the measurement's word. "Exit liquidity" is the thing
          it measures, and "Measured" stays in front of it because the whole
          rail is a claim about what was tested, not about what is available. */}
      <RailHeading
        live="Measured exit liquidity"
        historical="Historical exit measurements"
        allStale={allStale}
        trailing={<span className="rt">{bpsLabelV1(model.toleranceBps)} exit slippage</span>}
      />
      <div className="rpb">
        <RailGuide summary="How this is ranked">
          <p>
            Ordered only by measured exit coverage relative to one Miorail reference entry, within{' '}
            {bpsLabelV1(model.toleranceBps)} slippage. Largest tested exit is a lower bound: it is the biggest
            size that passed, nothing above it was tested, and nothing between it and the first failing size was
            measured either. Round-trip cost in amber is above the feed’s {bpsLabelV1(model.toleranceBps)}{' '}
            reference; the measurement stays on the rail rather than being hidden by it.
            {outsideReference > 0
              ? ` ${outsideReference} of the measured profiles here ${outsideReference === 1 ? 'is' : 'are'} above that reference.`
              : ''}{' '}
            A row marked stale is past its freshness window: historical evidence, not a current quote.
            {freshnessWindow
              ? ` A measurement counts as current for ${freshnessWindow} after it was taken, so a reading older than that is marked stale even when nothing about the token changed.`
              : ''}{' '}
            {MARKET_RAIL_DISCLAIMER_V1}
          </p>
        </RailGuide>
        {/* Marking each row stale understates it when EVERY row is stale: the
            reader is then looking at a list that is historical as a whole, and
            five identical chips read as a property of the rows rather than of
            the ranking. Said once, above them, and only when it is true of all
            of them. */}
        {allStale && (
          <p className="note warn">
            Every row below is past its freshness window. This is a ranking of past measurements, not
            of what the market looks like now.
          </p>
        )}
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
              <RailRow
                key={leader.tokenAddress}
                symbol={leader.symbol}
                tokenAddress={leader.tokenAddress}
                onOpenToken={model.onOpenToken}
                facts={[
                  {
                    label: 'Largest tested exit',
                    // The BOUND. `≥` is not decoration: the ladder knows the
                    // largest size that passed and nothing above it. What that
                    // means is stated once, under the header.
                    // "tokens", not the symbol: the row is already headed by
                    // the symbol, and repeating it made the number the second
                    // thing on its own line.
                    value: `≥ ${amountLabelV1(leader.largestPassingSizeAtomic, leader.decimals, 'tokens')}`,
                    mark: null,
                    tone: 'plain',
                  },
                  roundTripFactV1(leader),
                  freshnessFactV1(leader.measuredAt, leader.freshness, model.now),
                ]}
              />
            ))}
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
  // Same rule as the exit rail. A 24h comparison built from two readings that
  // are both past their window is still useful evidence, and it is still not a
  // live signal — "24h" in the title is what makes it read as one.
  const allStale = visible.length > 0 && visible.every((mover) => mover.freshness === 'stale');

  return (
    <div className="rp">
      <RailHeading
        live="24h Route Cost Changes"
        historical="Historical route cost changes"
        allStale={allStale}
        trailing={<span className="rt">Miorail quotes</span>}
      />
      <div className="rpb">
        {/* The server's own label and note, said once and verbatim. Shortening
            "24h change from Miorail measured quotes" to "24h" is exactly the
            paraphrase this metric must not suffer. */}
        <RailGuide summary="How this is measured">
          {model.moveLabel ? <p>{model.moveLabel}</p> : null}
          {model.moveNote ? <p>{model.moveNote}</p> : null}
          <p>
            A rise means the exit got MORE expensive, which is why it is amber, and the unit is percentage
            points because it is the difference between two percentages. A row marked stale is past its
            freshness window: historical evidence, not a current quote. {MARKET_RAIL_DISCLAIMER_V1}
          </p>
        </RailGuide>
        {allStale && (
          <p className="note warn">
            Both readings behind every change below are past their freshness window. This is a comparison
            of past measurements, not a live move.
          </p>
        )}
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
              <RailRow
                key={mover.tokenAddress}
                symbol={mover.symbol}
                tokenAddress={mover.tokenAddress}
                onOpenToken={model.onOpenToken}
                facts={[
                  {
                    // Named in full. `↑ 1.97 pp` beside a symbol with no label
                    // is the shape a price return takes, and this is the change
                    // in what an exit COSTS — so up is worse, and the label has
                    // to say which number this is.
                    label: '24h route cost change',
                    value: roundTripChangeLabelV1(mover.changeBps),
                    mark: null,
                    tone: mover.changeBps > 0 ? 'warn' : 'plain',
                  },
                  roundTripFactV1(mover),
                  freshnessFactV1(mover.measuredAt, mover.freshness, model.now),
                ]}
              />
            ))}
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
