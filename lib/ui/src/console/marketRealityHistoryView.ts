import { formatAtomicAmount } from '../formatAtomicAmount';
import {
  quoteAgeLabelV1,
  type IssuerIdV1,
  type MarketRealityDirectionV1,
  type MarketRealityWireV1,
  type RepresentationKindV1,
} from './marketRealityView';

// ---------------------------------------------------------------------------
// Phase 12.1 — one exact market question, observed at different times.
//
// This is deliberately a projection over the append-only Phase 10C evidence.
// The raw history endpoint retains technical failures for operators; this view
// admits only successful router-market outcomes captured with the immutable
// snapshot. A provider outage therefore remains evidence that Miorail failed
// to read, but can never become a value or a derived market change here.
// ---------------------------------------------------------------------------

export const MARKET_REALITY_HISTORY_PERIODS_V1 = [
  { key: 'now', label: 'Now' },
  { key: '1h', label: '1H' },
  { key: '6h', label: '6H' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
] as const;

export type MarketRealityHistoryPeriodV1 =
  (typeof MARKET_REALITY_HISTORY_PERIODS_V1)[number]['key'];
export type MarketRealityPastPeriodV1 = Exclude<MarketRealityHistoryPeriodV1, 'now'>;

const PERIOD_MS_V1: Readonly<Record<MarketRealityPastPeriodV1, number>> = {
  '1h': 60 * 60 * 1_000,
  '6h': 6 * 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
};

/**
 * Production measures the public ladder hourly with up to five minutes of
 * jitter. A historical label is therefore a target, not a fabricated exact
 * timestamp: select the nearest captured observation inside one bounded
 * cadence window and always show its real age. The 7d edge only returns points
 * on or after the API boundary, so its one-sided tolerance is wider.
 */
const TARGET_TOLERANCE_MS_V1: Readonly<Record<MarketRealityPastPeriodV1, number>> = {
  '1h': 40 * 60 * 1_000,
  '6h': 40 * 60 * 1_000,
  '24h': 40 * 60 * 1_000,
  '7d': 70 * 60 * 1_000,
};

interface HistorySnapshotWireV1 {
  tokenAddress: string;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string | null;
  destination: 'USDC' | 'ETH';
  source: string;
  approvedSources: readonly string[];
  routePolicyKey: string;
  marketStatus: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed';
  marketObservedAt: string;
  effectivePriceAtomic: string | null;
  effectivePriceDecimals: number | null;
  basis: {
    status: 'comparable' | 'withheld';
    premiumDiscountBps: string | null;
    reason: string;
  };
}

export interface MarketRealityHistoryPointWireV1 {
  observedAt: string;
  status: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed';
  source: string;
  returnedCashAtomic: string | null;
  testedTokenAtomic: string | null;
  errorCode: string | null;
  approvedSources: readonly string[];
  marketReality: HistorySnapshotWireV1 | null;
}

export interface MarketRealityHistorySeriesWireV1 {
  tokenAddress: string;
  issuerId: IssuerIdV1 | null;
  representationKind: RepresentationKindV1 | null;
  points: readonly MarketRealityHistoryPointWireV1[];
  pointCount: number;
  quotedCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export interface MarketRealityHistoryWireV1 {
  underlyingKey: string;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  window: MarketRealityPastPeriodV1;
  since: string;
  interpolated: false;
  representations: readonly MarketRealityHistorySeriesWireV1[];
  assembledAt: string;
}

export interface ComparableMarketHistoryMetricV1 {
  label: string;
  value: string;
  note: string | null;
}

export interface ComparableMarketHistoryRepresentationV1 {
  tokenAddress: string;
  issuerName: string;
  structureLabel: string;
  state: 'quoted' | 'no_route' | 'no_comparable_observation';
  stateLabel: string;
  observedAge: string | null;
  observedAt: string | null;
  source: string | null;
  summary: string;
  metrics: ComparableMarketHistoryMetricV1[];
  changesToNow: ComparableMarketHistoryMetricV1[];
  changeNote: string | null;
}

export interface ComparableMarketHistoryViewV1 {
  period: MarketRealityPastPeriodV1;
  targetLabel: string;
  exactQuestion: string;
  interpolated: false;
  representations: ComparableMarketHistoryRepresentationV1[];
  comparableCount: number;
  scope: string;
}

const ISSUER_NAME_V1: Readonly<Record<IssuerIdV1, string>> = {
  coinbase: 'Coinbase',
  dinari: 'Dinari',
  backed: 'Backed',
};

const STRUCTURE_LABEL_V1: Readonly<Record<RepresentationKindV1, string>> = {
  b20_asset: 'B20 asset',
  rebasing_erc20: 'Rebasing ERC-20',
  non_rebasing_erc4626_wrapper: 'ERC-4626 wrapper',
};

const PERIOD_TARGET_LABEL_V1: Readonly<Record<MarketRealityPastPeriodV1, string>> = {
  '1h': '1 hour ago',
  '6h': '6 hours ago',
  '24h': '24 hours ago',
  '7d': '7 days ago',
};

function groupedUsdV1(atomic: string, decimals = 6): string {
  const plain = formatAtomicAmount(atomic, decimals);
  const [whole, fraction] = plain.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `$${grouped}.${fraction.slice(0, 2).padEnd(2, '0')}` : `$${grouped}.00`;
}

function signedUsdDeltaV1(deltaAtomic: bigint, decimals = 6): string {
  const sign = deltaAtomic > BigInt(0) ? '+' : deltaAtomic < BigInt(0) ? '−' : '';
  const magnitude = deltaAtomic < BigInt(0) ? -deltaAtomic : deltaAtomic;
  return `${sign}${groupedUsdV1(magnitude.toString(), decimals)}`;
}

function roundedDivisionV1(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) return BigInt(0);
  const negative = numerator < BigInt(0);
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * BigInt(2) >= denominator) quotient += BigInt(1);
  return negative ? -quotient : quotient;
}

/** SELL cost against the exact cash-equivalent rung, in whole basis points. */
export function marketExitCostBpsV1(
  requestedCashAtomic: string,
  returnedCashAtomic: string,
): string {
  const requested = BigInt(requestedCashAtomic);
  const returned = BigInt(returnedCashAtomic);
  return roundedDivisionV1((requested - returned) * BigInt(10_000), requested).toString();
}

function percentFromBpsV1(bps: string): string {
  const value = BigInt(bps);
  const sign = value > BigInt(0) ? '' : value < BigInt(0) ? '−' : '';
  const magnitude = value < BigInt(0) ? -value : value;
  const whole = magnitude / BigInt(100);
  const fraction = (magnitude % BigInt(100)).toString().padStart(2, '0');
  return `${sign}${whole.toString()}.${fraction}%`;
}

/** Signed percent, for the rows where a basis point was the primary value.
 * The neighbouring exit-cost rows already read percent-first; the reference
 * basis did not, so one screen quoted two units for the same kind of figure. */
function signedPercentFromBpsV1(value: bigint): string {
  const sign = value > BigInt(0) ? '+' : '';
  return `${sign}${percentFromBpsV1(value.toString())}`;
}

function signedBpsV1(value: bigint): string {
  const sign = value > BigInt(0) ? '+' : value < BigInt(0) ? '−' : '';
  const magnitude = value < BigInt(0) ? -value : value;
  return `${sign}${magnitude.toString()} bps`;
}

function exactQuestionV1(wire: MarketRealityWireV1): string {
  const cash = groupedUsdV1(wire.question.requestedCashAtomic, wire.question.cashDecimals);
  return wire.question.direction === 'sell'
    ? `${cash} SELL → ${wire.question.destination}`
    : `${cash} BUY with ${wire.question.destination}`;
}

function sameStringSetV1(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function exactSuccessfulPointV1(input: {
  point: MarketRealityHistoryPointWireV1;
  tokenAddress: string;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  routePolicyKey: string;
}): boolean {
  const snapshot = input.point.marketReality;
  if (!snapshot || !['quoted', 'no_route'].includes(input.point.status)) return false;
  return (
    snapshot.marketStatus === input.point.status &&
    snapshot.tokenAddress.toLowerCase() === input.tokenAddress.toLowerCase() &&
    snapshot.direction === input.direction &&
    snapshot.requestedCashAtomic === input.requestedCashAtomic &&
    snapshot.destination === input.destination &&
    snapshot.routePolicyKey === input.routePolicyKey &&
    snapshot.source === input.point.source &&
    sameStringSetV1(snapshot.approvedSources, input.point.approvedSources)
  );
}

function nearestPointV1(input: {
  series: MarketRealityHistorySeriesWireV1;
  nowMs: number;
  period: MarketRealityPastPeriodV1;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  routePolicyKey: string;
}): MarketRealityHistoryPointWireV1 | null {
  const targetMs = input.nowMs - PERIOD_MS_V1[input.period];
  const toleranceMs = TARGET_TOLERANCE_MS_V1[input.period];
  return (
    input.series.points
      .filter((point) =>
        exactSuccessfulPointV1({
          point,
          tokenAddress: input.series.tokenAddress,
          direction: input.direction,
          requestedCashAtomic: input.requestedCashAtomic,
          destination: input.destination,
          routePolicyKey: input.routePolicyKey,
        }),
      )
      .map((point) => ({
        point,
        observedMs: Date.parse(point.marketReality!.marketObservedAt),
      }))
      .filter(
        (row) =>
          Number.isFinite(row.observedMs) && Math.abs(row.observedMs - targetMs) <= toleranceMs,
      )
      .sort((left, right) => {
        const distance =
          Math.abs(left.observedMs - targetMs) - Math.abs(right.observedMs - targetMs);
        if (distance !== 0) return distance;
        const leftAfter = left.observedMs > targetMs;
        const rightAfter = right.observedMs > targetMs;
        if (leftAfter !== rightAfter) return leftAfter ? 1 : -1;
        return right.observedMs - left.observedMs;
      })[0]?.point ?? null
  );
}

function currentMarketOutcomeV1(
  representation: MarketRealityWireV1['representations'][number],
): 'quoted' | 'no_route' | null {
  if (representation.liveness !== 'live' || representation.routePolicyKey === null) return null;
  if (representation.status === 'full') return 'quoted';
  if (representation.status === 'unavailable') return 'no_route';
  return null;
}

function currentQuotedSourceV1(
  representation: MarketRealityWireV1['representations'][number],
): string | null {
  return (
    representation.sources
      .filter((row) => row.status === 'quoted' && row.quoteEvidence !== null)
      .sort((left, right) => {
        const leftOutput = BigInt(left.quoteEvidence!.outputAtomic);
        const rightOutput = BigInt(right.quoteEvidence!.outputAtomic);
        return leftOutput === rightOutput
          ? left.source.localeCompare(right.source)
          : leftOutput > rightOutput
            ? -1
            : 1;
      })[0]?.source ?? null
  );
}

function pointMetricsV1(input: {
  point: MarketRealityHistoryPointWireV1;
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
}): ComparableMarketHistoryMetricV1[] {
  if (input.point.status !== 'quoted') return [];
  const snapshot = input.point.marketReality!;
  if (input.direction === 'sell') {
    if (input.point.returnedCashAtomic === null) return [];
    const exitCostBps = marketExitCostBpsV1(
      input.requestedCashAtomic,
      input.point.returnedCashAtomic,
    );
    return [
      { label: 'Cash back', value: groupedUsdV1(input.point.returnedCashAtomic), note: null },
      { label: 'Exit cost', value: percentFromBpsV1(exitCostBps), note: `${exitCostBps} bps` },
    ];
  }
  const rows: ComparableMarketHistoryMetricV1[] = [];
  if (snapshot.effectivePriceAtomic !== null && snapshot.effectivePriceDecimals !== null) {
    rows.push({
      label: 'Effective price',
      value: groupedUsdV1(snapshot.effectivePriceAtomic, snapshot.effectivePriceDecimals),
      note: null,
    });
  }
  rows.push(
    snapshot.basis.status === 'comparable' && snapshot.basis.premiumDiscountBps !== null
      ? {
          label: 'Reference basis',
          // Percent first, basis points as the note — the same shape as the
          // `Exit cost` row above, which a reader meets on the same card.
          value: signedPercentFromBpsV1(BigInt(snapshot.basis.premiumDiscountBps)),
          note: signedBpsV1(BigInt(snapshot.basis.premiumDiscountBps)),
        }
      : { label: 'Reference basis', value: '—', note: snapshot.basis.reason },
  );
  return rows;
}

function changesToNowV1(input: {
  point: MarketRealityHistoryPointWireV1;
  current: MarketRealityWireV1['representations'][number];
  direction: MarketRealityDirectionV1;
  requestedCashAtomic: string;
}): { rows: ComparableMarketHistoryMetricV1[]; note: string | null } {
  const currentOutcome = currentMarketOutcomeV1(input.current);
  if (currentOutcome === null) {
    return {
      rows: [],
      note: 'No fresh comparable Now observation. Measure now before calculating a change.',
    };
  }
  if (input.point.status !== currentOutcome) {
    return {
      rows: [
        {
          label: 'Outcome',
          value: `${input.point.status === 'quoted' ? 'Route priced' : 'No reviewed route'} → ${currentOutcome === 'quoted' ? 'Route priced' : 'No reviewed route'}`,
          note: null,
        },
      ],
      note: null,
    };
  }
  if (currentOutcome === 'no_route') {
    return {
      rows: [{ label: 'Outcome', value: 'No reviewed route → No reviewed route', note: null }],
      note: null,
    };
  }
  const currentSource = currentQuotedSourceV1(input.current);
  if (currentSource === null || currentSource !== input.point.source) {
    return {
      rows: [],
      note:
        currentSource === null
          ? 'The current winning reviewed route source was not established.'
          : `The reviewed route source changed (${input.point.source} → ${currentSource}); numeric change is withheld.`,
    };
  }
  if (input.direction === 'sell') {
    if (input.point.returnedCashAtomic === null || input.current.returnedCashAtomic === null) {
      return { rows: [], note: 'The exact cash-back pair was not established.' };
    }
    const beforeBps = BigInt(
      marketExitCostBpsV1(input.requestedCashAtomic, input.point.returnedCashAtomic),
    );
    const nowBps = BigInt(
      marketExitCostBpsV1(input.requestedCashAtomic, input.current.returnedCashAtomic),
    );
    return {
      rows: [
        {
          label: 'Cash back',
          value: `${groupedUsdV1(input.point.returnedCashAtomic)} → ${groupedUsdV1(input.current.returnedCashAtomic)}`,
          note: signedUsdDeltaV1(
            BigInt(input.current.returnedCashAtomic) - BigInt(input.point.returnedCashAtomic),
          ),
        },
        {
          label: 'Exit cost',
          value: `${percentFromBpsV1(beforeBps.toString())} → ${percentFromBpsV1(nowBps.toString())}`,
          note: signedBpsV1(nowBps - beforeBps),
        },
      ],
      note: null,
    };
  }
  const before = input.point.marketReality!;
  const rows: ComparableMarketHistoryMetricV1[] = [];
  if (
    before.effectivePriceAtomic !== null &&
    before.effectivePriceDecimals !== null &&
    input.current.effectivePriceAtomic !== null &&
    input.current.effectivePriceDecimals !== null &&
    before.effectivePriceDecimals === input.current.effectivePriceDecimals
  ) {
    rows.push({
      label: 'Effective price',
      value: `${groupedUsdV1(before.effectivePriceAtomic, before.effectivePriceDecimals)} → ${groupedUsdV1(input.current.effectivePriceAtomic, input.current.effectivePriceDecimals)}`,
      note: signedUsdDeltaV1(
        BigInt(input.current.effectivePriceAtomic) - BigInt(before.effectivePriceAtomic),
        before.effectivePriceDecimals,
      ),
    });
  }
  if (
    before.basis.status === 'comparable' &&
    before.basis.premiumDiscountBps !== null &&
    input.current.basis.status === 'comparable' &&
    input.current.basis.premiumDiscountBps !== null
  ) {
    const oldBasis = BigInt(before.basis.premiumDiscountBps);
    const nowBasis = BigInt(input.current.basis.premiumDiscountBps);
    rows.push({
      label: 'Reference basis',
      value: `${signedPercentFromBpsV1(oldBasis)} → ${signedPercentFromBpsV1(nowBasis)}`,
      note: signedBpsV1(nowBasis - oldBasis),
    });
  }
  return {
    rows,
    note: rows.length === 0 ? 'The numeric evidence pair was not comparable.' : null,
  };
}

function emptyRepresentationV1(input: {
  tokenAddress: string;
  issuerId: IssuerIdV1;
  representationKind: RepresentationKindV1;
  period: MarketRealityPastPeriodV1;
  reason: string;
}): ComparableMarketHistoryRepresentationV1 {
  return {
    tokenAddress: input.tokenAddress,
    issuerName: ISSUER_NAME_V1[input.issuerId],
    structureLabel: STRUCTURE_LABEL_V1[input.representationKind],
    state: 'no_comparable_observation',
    stateLabel: 'No comparable observation',
    observedAge: null,
    observedAt: null,
    source: null,
    summary: input.reason,
    metrics: [],
    changesToNow: [],
    changeNote: null,
  };
}

export function comparableMarketHistoryViewV1(input: {
  wire: MarketRealityWireV1 | null;
  history: MarketRealityHistoryWireV1 | null;
  period: MarketRealityPastPeriodV1;
  now: string;
}): ComparableMarketHistoryViewV1 | null {
  const { wire, history } = input;
  if (!wire || !history) return null;
  const questionMatches =
    history.underlyingKey === wire.question.underlyingKey &&
    history.direction === wire.question.direction &&
    history.requestedCashAtomic === wire.question.requestedCashAtomic &&
    history.destination === wire.question.destination &&
    history.interpolated === false;
  const historyByAddress = new Map(
    history.representations.map((series) => [series.tokenAddress.toLowerCase(), series]),
  );
  const nowMs = Date.parse(input.now);
  const representations = wire.representations.map((current) => {
    const base = {
      tokenAddress: current.tokenAddress,
      issuerId: current.issuerId,
      representationKind: current.representationKind,
      period: input.period,
    };
    if (!questionMatches || !Number.isFinite(nowMs)) {
      return emptyRepresentationV1({
        ...base,
        reason: 'The history response does not match this exact market question.',
      });
    }
    if (current.routePolicyKey === null) {
      return emptyRepresentationV1({
        ...base,
        reason:
          'The current reviewed route policy is not established, so past points cannot be compared.',
      });
    }
    const series = historyByAddress.get(current.tokenAddress.toLowerCase());
    if (!series) {
      return emptyRepresentationV1({
        ...base,
        reason: `No successful comparable observation was captured near ${PERIOD_TARGET_LABEL_V1[input.period]} for this exact address and question.`,
      });
    }
    const point = nearestPointV1({
      series,
      nowMs,
      period: input.period,
      direction: wire.question.direction,
      requestedCashAtomic: wire.question.requestedCashAtomic,
      destination: wire.question.destination,
      routePolicyKey: current.routePolicyKey,
    });
    if (!point) {
      return emptyRepresentationV1({
        ...base,
        reason: `No successful comparable observation was captured near ${PERIOD_TARGET_LABEL_V1[input.period]} for this exact address, size, direction, destination and route policy.`,
      });
    }
    const changes = changesToNowV1({
      point,
      current,
      direction: wire.question.direction,
      requestedCashAtomic: wire.question.requestedCashAtomic,
    });
    const observedAt = point.marketReality!.marketObservedAt;
    return {
      tokenAddress: current.tokenAddress,
      issuerName: ISSUER_NAME_V1[current.issuerId],
      structureLabel: STRUCTURE_LABEL_V1[current.representationKind],
      state: point.status as 'quoted' | 'no_route',
      stateLabel: point.status === 'quoted' ? 'Observed' : 'No reviewed route',
      observedAge: quoteAgeLabelV1(observedAt, input.now),
      observedAt,
      source: point.source,
      summary:
        point.status === 'quoted'
          ? 'A reviewed router answered this exact market question at the captured time.'
          : 'A successful measurement proved that no approved route answered this exact question under the reviewed policy.',
      metrics: pointMetricsV1({
        point,
        direction: wire.question.direction,
        requestedCashAtomic: wire.question.requestedCashAtomic,
      }),
      changesToNow: changes.rows,
      changeNote: changes.note,
    };
  });
  return {
    period: input.period,
    targetLabel: PERIOD_TARGET_LABEL_V1[input.period],
    exactQuestion: exactQuestionV1(wire),
    interpolated: false,
    representations,
    comparableCount: representations.filter((row) => row.state !== 'no_comparable_observation')
      .length,
    scope:
      'Exact captured observations only. Same Base address, size, direction, destination, reviewed route policy and router-market evidence class; numeric change also requires the same winning route source. No interpolation. Provider and RPC failures remain gaps, never asset changes.',
  };
}
