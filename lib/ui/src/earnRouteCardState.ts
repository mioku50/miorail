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
  venue: { identifier: string };
  withdrawalModel: string;
  estimatedGas: { estimatedCostUsd: string | null; gasUnits: string };
  callCount: number;
  approvalCount: number;
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
}

export interface EarnRouteCardViewV1 {
  status: 'recommendation' | 'degraded';
  optimizationLabel: string;
  amountLabel: string;
  recommendation: { candidateHash: string; protocolLabel: string; reason: string } | null;
  degradedReason: string | null;
  rows: EarnCandidateRowViewV1[];
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
  };
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
