import type {
  EarnCandidateV1,
  EarnOptimizationModeV1,
  EarnProtocolV1,
  EarnScoreV1,
} from '@mioagent/route-domain';
import { earnDimensionV1 } from './scoring.js';

export interface EarnRankedEntryV1 {
  candidate: EarnCandidateV1;
  score: EarnScoreV1;
}

export interface EarnRankingResultV1 {
  /** All candidate hashes, ranked ones first then ineligible ones (stable). */
  orderedCandidateHashes: string[];
  recommendedCandidateHash: string | null;
  recommendationReason: string | null;
  degradedReason: string | null;
}

function cmpBigIntDesc(a: string, b: string): number {
  const av = BigInt(a);
  const bv = BigInt(b);
  return av > bv ? -1 : av < bv ? 1 : 0;
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}

/**
 * Deterministic ranking per optimization mode.
 * - lowest_risk ALWAYS degrades (transaction safety is never scored in T61 —
 *   spec §2/§5: no recommendation without sufficient risk evidence).
 * - best_net_yield / highest_liquidity only rank candidates whose relevant
 *   dimension is scored (stale APY / missing liquidity are excluded, §4).
 * - simplest_route always has an eligible field.
 * Ties break by the stable base order (protocol asc, then candidate hash asc).
 */
export function rankEarnCandidatesV1(
  entries: EarnRankedEntryV1[],
  mode: EarnOptimizationModeV1,
): EarnRankingResultV1 {
  const base = [...entries].sort((a, b) => {
    if (a.candidate.protocol !== b.candidate.protocol) {
      return a.candidate.protocol < b.candidate.protocol ? -1 : 1;
    }
    return a.candidate.candidateHash < b.candidate.candidateHash
      ? -1
      : a.candidate.candidateHash > b.candidate.candidateHash
        ? 1
        : 0;
  });

  if (mode === 'lowest_risk') {
    return {
      orderedCandidateHashes: base.map((entry) => entry.candidate.candidateHash),
      recommendedCandidateHash: null,
      recommendationReason: null,
      degradedReason:
        'Lowest-risk needs contract-risk evidence, which is not available — transaction safety is Not scored. Candidates are shown for comparison only.',
    };
  }

  let eligible: EarnRankedEntryV1[];
  let compare: (a: EarnRankedEntryV1, b: EarnRankedEntryV1) => number;
  let reasonFor: (top: EarnRankedEntryV1) => string;
  let noneReason: string;

  if (mode === 'best_net_yield') {
    eligible = base.filter(
      (entry) => earnDimensionV1(entry.score, 'net_yield').status === 'scored' && entry.candidate.netApyBps !== null,
    );
    compare = (a, b) => cmpBigIntDesc(String(a.candidate.netApyBps ?? 0), String(b.candidate.netApyBps ?? 0));
    reasonFor = (top) =>
      `Best net yield: ${top.candidate.venue.identifier} at ${bpsToPercent(top.candidate.netApyBps ?? 0)}% net APY.`;
    noneReason = 'No candidate has a fresh net-yield reading to rank. Candidates are shown for comparison only.';
  } else if (mode === 'highest_liquidity') {
    eligible = base.filter(
      (entry) =>
        earnDimensionV1(entry.score, 'liquidity').status === 'scored' && entry.candidate.availableLiquidityAtomic !== null,
    );
    compare = (a, b) =>
      cmpBigIntDesc(a.candidate.availableLiquidityAtomic ?? '0', b.candidate.availableLiquidityAtomic ?? '0');
    reasonFor = (top) => `Highest available withdrawal liquidity: ${top.candidate.venue.identifier}.`;
    noneReason = 'No candidate has withdrawal-liquidity data to rank. Candidates are shown for comparison only.';
  } else {
    eligible = base;
    compare = (a, b) =>
      (earnDimensionV1(b.score, 'route_simplicity').score ?? 0) - (earnDimensionV1(a.score, 'route_simplicity').score ?? 0);
    reasonFor = (top) =>
      `Simplest route: ${top.candidate.venue.identifier} (${top.candidate.approvalCount} approval + ${
        top.candidate.callCount - top.candidate.approvalCount
      } action, ${top.candidate.withdrawalModel === 'direct' ? 'direct withdrawal' : 'vault redeem'}).`;
    noneReason = 'No candidate is eligible to rank. Candidates are shown for comparison only.';
  }

  const ranked = [...eligible].sort((a, b) => {
    const primary = compare(a, b);
    if (primary !== 0) return primary;
    return base.indexOf(a) - base.indexOf(b);
  });
  const ineligible = base.filter((entry) => !eligible.includes(entry));
  const orderedCandidateHashes = [
    ...ranked.map((entry) => entry.candidate.candidateHash),
    ...ineligible.map((entry) => entry.candidate.candidateHash),
  ];

  if (ranked.length === 0) {
    return { orderedCandidateHashes, recommendedCandidateHash: null, recommendationReason: null, degradedReason: noneReason };
  }
  const top = ranked[0];
  return {
    orderedCandidateHashes,
    recommendedCandidateHash: top.candidate.candidateHash,
    recommendationReason: reasonFor(top),
    degradedReason: null,
  };
}

const EARN_PROTOCOL_LABELS_V1: Record<EarnProtocolV1, string> = {
  moonwell: 'Moonwell',
  morpho: 'Morpho',
  yo: 'YO',
};

function protocolList(protocols: readonly EarnProtocolV1[]): string {
  const labels = [...new Set(protocols)].sort().map((protocol) => EARN_PROTOCOL_LABELS_V1[protocol] ?? protocol);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * T63A §4 — a provider that did not answer must never produce a confident
 * "best route". When some of the requested venues are missing from the
 * comparison, whatever remains is an incomplete field: it is still SHOWN, but
 * the recommendation is withdrawn and the reason names the missing provider.
 * (An intentionally narrowed comparison — "use Moonwell only" — has no failure
 * and is not degraded by this rule.)
 */
export function degradeEarnRankingForUnavailableProvidersV1(
  ranking: EarnRankingResultV1,
  unavailableProtocols: readonly EarnProtocolV1[],
  comparedProtocols: readonly EarnProtocolV1[],
): EarnRankingResultV1 {
  if (unavailableProtocols.length === 0) return ranking;
  const missing = protocolList(unavailableProtocols);
  const compared = protocolList(comparedProtocols);
  const detail = compared
    ? `${missing} returned no usable live data, so only ${compared} could be compared.`
    : `${missing} returned no usable live data.`;
  return {
    orderedCandidateHashes: ranking.orderedCandidateHashes,
    recommendedCandidateHash: null,
    recommendationReason: null,
    degradedReason: `${detail} A partial comparison cannot establish a best route — the reading below is shown for reference only.`,
  };
}
