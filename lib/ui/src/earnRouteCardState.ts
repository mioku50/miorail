// ---------------------------------------------------------------------------
// T61 §6 — Earn Route Card view model. Pure, presentational, and dependency-
// free: lib/ui never imports api-zod/api-spec/route-domain, so the source is
// typed STRUCTURALLY (the real EarnRouteCardV1 is assignable to it). The card
// shows APY composition, liquidity, withdrawal mechanics, evidence freshness,
// missing evidence, and gas — and either an honest recommendation OR a degraded
// state. It NEVER manufactures a "lowest risk" claim: transaction_safety is
// always surfaced as Not scored, and a lowest_risk request that the engine
// could not back with risk evidence arrives here as a degraded card.
// ---------------------------------------------------------------------------

export interface EarnScoreDimensionSourceV1 {
  dimension: string;
  status: string;
  score: number | null;
  notScoredReason: string | null;
  missingEvidence: readonly string[];
}

export interface EarnCandidateSourceV1 {
  candidateHash: string;
  protocol: string;
  venue: { identifier: string; address: string };
  withdrawalModel: string;
  estimatedGas: { estimatedCostUsd: string | null; gasUnits: string };
  callCount: number;
  approvalCount: number;
  /** T63A: the live provider the reading came from, when it was observed, and
   * the exact withdrawable liquidity in atomic units (null = no datum). */
  provider: { displayName: string };
  observedAt: string;
  availableLiquidityAtomic: string | null;
  amount: { asset: { symbol: string; decimals: number } };
}

export interface EarnComparisonSourceV1 {
  candidate: EarnCandidateSourceV1;
  apyComposition: { baseApyBps: number | null; rewardApyBps: number | null; netApyBps: number | null };
  liquidityState: 'high' | 'medium' | 'low' | 'not_scored';
  freshnessState: 'fresh' | 'stale' | 'unknown';
  missingEvidence: readonly string[];
  score: { dimensions: readonly EarnScoreDimensionSourceV1[] };
}

export interface EarnRouteCardSourceV1 {
  optimizationMode: string;
  amount: { amountDecimal: string; asset: { symbol: string } };
  recommendedCandidateHash: string | null;
  recommendationReason: string | null;
  degradedReason: string | null;
  comparisons: readonly EarnComparisonSourceV1[];
}

export interface EarnScoreDimensionViewV1 {
  key: string;
  label: string;
  scored: boolean;
  scoreLabel: string;
  note: string | null;
}

export interface EarnCandidateRowViewV1 {
  candidateHash: string;
  protocolLabel: string;
  venueLabel: string;
  netApyLabel: string;
  baseApyLabel: string;
  rewardApyLabel: string;
  liquidityLabel: string;
  withdrawalLabel: string;
  freshnessLabel: string;
  callsLabel: string;
  gasLabel: string;
  missingEvidenceLabels: string[];
  dimensions: EarnScoreDimensionViewV1[];
  isRecommended: boolean;
  /** T63A live-data provenance. */
  sourceLabel: string;
  observedAtLabel: string;
  liquidityAmountLabel: string;
  contractLabel: string;
  isStale: boolean;
  /** Set only when this row's reading cannot be trusted for ranking. */
  dataWarning: string | null;
}

export interface EarnRouteCardViewV1 {
  status: 'recommendation' | 'degraded';
  optimizationLabel: string;
  amountLabel: string;
  recommendation: { candidateHash: string; protocolLabel: string; reason: string } | null;
  degradedReason: string | null;
  rows: EarnCandidateRowViewV1[];
  /** T63A: which live providers the comparison is built on, the newest
   * observation time across them, and a card-level warning when any reading is
   * no longer fresh. */
  dataSourceLabel: string;
  lastUpdatedLabel: string;
  staleWarning: string | null;
}

const OPTIMIZATION_LABELS: Record<string, string> = {
  best_net_yield: 'Best net yield',
  highest_liquidity: 'Highest liquidity',
  simplest_route: 'Simplest route',
  lowest_risk: 'Lowest risk',
};

const PROTOCOL_LABELS: Record<string, string> = { moonwell: 'Moonwell', morpho: 'Morpho' };

const WITHDRAWAL_LABELS: Record<string, string> = { direct: 'Direct', vault_redeem: 'Vault redeem' };

const LIQUIDITY_LABELS: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  not_scored: 'Not scored',
};

const FRESHNESS_LABELS: Record<string, string> = { fresh: 'Fresh', stale: 'Stale', unknown: 'Unknown' };

export const EARN_SCORE_DIMENSION_LABELS: Record<string, string> = {
  net_yield: 'Net yield',
  liquidity: 'Liquidity',
  route_simplicity: 'Route simplicity',
  transaction_safety: 'Transaction safety',
};

const EVIDENCE_LABELS: Record<string, string> = {
  yield_rate: 'Yield rate',
  liquidity: 'Liquidity',
  fees: 'Fees',
  withdrawal_terms: 'Withdrawal terms',
  market_identity: 'Market identity',
  contract_risk: 'Contract risk',
};

export function humanizeEarnTokenV1(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** APY basis points → a fixed "x.xx%" label. Integer bps only (no float on the
 * wire); null (unknown/stale) renders as an em dash, never a fabricated 0%. */
export function formatApyBpsV1(bps: number | null): string {
  if (bps === null) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

function formatRewardApyBpsV1(bps: number | null): string {
  if (bps === null) return '—';
  if (bps === 0) return 'none';
  return `+${(bps / 100).toFixed(2)}%`;
}

function evidenceLabel(kind: string): string {
  return EVIDENCE_LABELS[kind] ?? humanizeEarnTokenV1(kind);
}

/** Atomic base units → a compact human amount, using BigInt only: a liquidity
 * figure must never round through a float. `null` (no datum) renders as an em
 * dash, never as 0. */
export function formatEarnLiquidityAmountV1(
  atomic: string | null,
  decimals: number,
  symbol: string,
): string {
  if (atomic === null) return '—';
  let value: bigint;
  try {
    value = BigInt(atomic);
  } catch {
    return '—';
  }
  // BigInt(...) rather than BigInt literals: lib/ui is consumed by app targets
  // below ES2020 (see EarnDepositFlow's amount formatter).
  const ten = BigInt(10);
  const hundred = BigInt(100);
  const base = ten ** BigInt(Math.max(0, Math.min(36, decimals)));
  const whole = value / base;
  const magnitudes: [bigint, string][] = [
    [ten ** BigInt(12), 'T'],
    [ten ** BigInt(9), 'B'],
    [ten ** BigInt(6), 'M'],
    [ten ** BigInt(3), 'K'],
  ];
  for (const [threshold, suffix] of magnitudes) {
    if (whole >= threshold) {
      const scaled = (whole * hundred) / threshold;
      return `${scaled / hundred}.${String(scaled % hundred).padStart(2, '0')}${suffix} ${symbol}`;
    }
  }
  const fraction = ((value % base) * hundred) / base;
  return `${whole}.${String(fraction).padStart(2, '0')} ${symbol}`;
}

/** ISO instant → a stable "YYYY-MM-DD HH:MM UTC" label. Absolute and
 * clock-free on purpose: a relative "2 min ago" would need a `now` the view
 * model does not have, and would drift between render and reality. */
export function formatEarnObservedAtV1(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  const iso = new Date(parsed).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function shortContractV1(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const STALE_ROW_WARNING_V1 =
  'Stale reading — shown for reference only and excluded from ranking until the provider refreshes.';
const UNKNOWN_FRESHNESS_WARNING_V1 =
  'Freshness could not be established for this reading, so it is not ranked.';

function callsLabelForProtocolV1(protocol: string): string {
  // Moonwell supplies into the mToken market; Morpho deposits into the ERC-4626
  // vault. Both are exactly one approval + one action.
  return protocol === 'moonwell' ? 'Approve + Supply' : 'Approve + Deposit';
}

function dimensionView(dimension: EarnScoreDimensionSourceV1): EarnScoreDimensionViewV1 {
  const label = EARN_SCORE_DIMENSION_LABELS[dimension.dimension] ?? humanizeEarnTokenV1(dimension.dimension);
  if (dimension.status === 'scored' && dimension.score !== null) {
    return { key: dimension.dimension, label, scored: true, scoreLabel: `${dimension.score}/100`, note: null };
  }
  const note =
    dimension.missingEvidence.length > 0
      ? `${dimension.missingEvidence.map(evidenceLabel).join(' and ')} evidence unavailable.`
      : dimension.notScoredReason
        ? humanizeEarnTokenV1(dimension.notScoredReason)
        : 'No data — no score.';
  return { key: dimension.dimension, label, scored: false, scoreLabel: 'Not scored', note };
}

function rowView(comparison: EarnComparisonSourceV1, recommendedHash: string | null): EarnCandidateRowViewV1 {
  const { candidate } = comparison;
  const isStale = comparison.freshnessState === 'stale';
  return {
    candidateHash: candidate.candidateHash,
    protocolLabel: PROTOCOL_LABELS[candidate.protocol] ?? humanizeEarnTokenV1(candidate.protocol),
    venueLabel: candidate.venue.identifier,
    netApyLabel: formatApyBpsV1(comparison.apyComposition.netApyBps),
    baseApyLabel: formatApyBpsV1(comparison.apyComposition.baseApyBps),
    rewardApyLabel: formatRewardApyBpsV1(comparison.apyComposition.rewardApyBps),
    liquidityLabel: LIQUIDITY_LABELS[comparison.liquidityState] ?? 'Not scored',
    withdrawalLabel: WITHDRAWAL_LABELS[candidate.withdrawalModel] ?? humanizeEarnTokenV1(candidate.withdrawalModel),
    freshnessLabel: FRESHNESS_LABELS[comparison.freshnessState] ?? 'Unknown',
    callsLabel: callsLabelForProtocolV1(candidate.protocol),
    gasLabel: candidate.estimatedGas.estimatedCostUsd ? `$${candidate.estimatedGas.estimatedCostUsd}` : 'USD unavailable',
    missingEvidenceLabels: comparison.missingEvidence.map(evidenceLabel),
    dimensions: comparison.score.dimensions.map(dimensionView),
    isRecommended: candidate.candidateHash === recommendedHash,
    sourceLabel: candidate.provider.displayName,
    observedAtLabel: formatEarnObservedAtV1(candidate.observedAt),
    liquidityAmountLabel: formatEarnLiquidityAmountV1(
      candidate.availableLiquidityAtomic,
      candidate.amount.asset.decimals,
      candidate.amount.asset.symbol,
    ),
    contractLabel: shortContractV1(candidate.venue.address),
    isStale,
    dataWarning: isStale
      ? STALE_ROW_WARNING_V1
      : comparison.freshnessState === 'unknown'
        ? UNKNOWN_FRESHNESS_WARNING_V1
        : null,
  };
}

/**
 * Derives the presentational Earn Route Card view from the server card. A card
 * with no recommendedCandidateHash is an HONEST degraded state — no route is
 * surfaced as recommended, and the server's degradedReason is shown verbatim.
 */
export function deriveEarnRouteCardViewV1(source: EarnRouteCardSourceV1): EarnRouteCardViewV1 {
  const rows = source.comparisons.map((comparison) => rowView(comparison, source.recommendedCandidateHash));
  const recommendedRow = source.recommendedCandidateHash
    ? rows.find((row) => row.candidateHash === source.recommendedCandidateHash) ?? null
    : null;

  const sources = [...new Set(source.comparisons.map((comparison) => comparison.candidate.provider.displayName))];
  const observedTimes = source.comparisons
    .map((comparison) => Date.parse(comparison.candidate.observedAt))
    .filter((value) => Number.isFinite(value));
  // The card is only as current as its OLDEST leg: quoting the newest reading
  // would overstate how fresh the comparison as a whole is.
  const oldestObservedAt = observedTimes.length > 0 ? Math.min(...observedTimes) : null;
  const staleRows = rows.filter((row) => row.isStale);

  return {
    status: recommendedRow ? 'recommendation' : 'degraded',
    optimizationLabel: OPTIMIZATION_LABELS[source.optimizationMode] ?? humanizeEarnTokenV1(source.optimizationMode),
    amountLabel: `${source.amount.amountDecimal} ${source.amount.asset.symbol}`,
    recommendation: recommendedRow
      ? {
          candidateHash: recommendedRow.candidateHash,
          protocolLabel: recommendedRow.protocolLabel,
          reason: source.recommendationReason ?? '',
        }
      : null,
    degradedReason: recommendedRow ? null : source.degradedReason,
    rows,
    dataSourceLabel: sources.length > 0 ? sources.join(' · ') : 'Unknown source',
    lastUpdatedLabel: oldestObservedAt === null ? 'Unknown' : formatEarnObservedAtV1(new Date(oldestObservedAt).toISOString()),
    staleWarning:
      staleRows.length === 0
        ? null
        : `${staleRows.map((row) => row.protocolLabel).join(' and ')} ${
            staleRows.length === 1 ? 'data is' : 'data are'
          } past the freshness window — shown below, but excluded from ranking.`,
  };
}

const EARN_UNSUPPORTED_REASON_LABELS_V1: Record<string, string> = {
  all_providers_unavailable:
    'Neither Moonwell nor Morpho returned usable live data just now, so there is nothing to compare. No route is shown rather than a guessed one — try again in a moment.',
  no_candidates: 'No earn venue could be compared for this request.',
  no_protocols_selected: 'The protocol constraint in this request excludes every supported earn venue.',
  yo_route_adapter_not_released:
    'YO belongs in Routes, but its typed APY, liquidity, withdrawal and execution adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
  balancer_earn_adapter_not_released:
    'Balancer belongs in Routes, but its Earn/liquidity adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
  hydrex_earn_adapter_not_released:
    'Hydrex belongs in Routes, but its Earn/liquidity adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
};

/** Maps a server `unsupported` reason code to a sentence. Unknown codes are
 * humanized rather than hidden — the surface never invents an explanation, and
 * never shows a bare machine token where a sentence exists. */
export function earnUnsupportedReasonLabelV1(reason: string): string {
  return EARN_UNSUPPORTED_REASON_LABELS_V1[reason] ?? humanizeEarnTokenV1(reason);
}

/** Belt-and-suspenders honesty guard for tests/callers: a recommendation must
 * never assert a risk/safety claim while transaction_safety is Not scored. */
export function earnViewMakesUnevidencedRiskClaimV1(view: EarnRouteCardViewV1): boolean {
  if (!view.recommendation) return false;
  const recommendedRow = view.rows.find((row) => row.candidateHash === view.recommendation!.candidateHash);
  const safetyScored = recommendedRow?.dimensions.some((d) => d.key === 'transaction_safety' && d.scored) ?? false;
  if (safetyScored) return false;
  return /lowest[- ]?risk|safest|least[- ]?risk|risk[- ]?free/i.test(view.recommendation.reason);
}
