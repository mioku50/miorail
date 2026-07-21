import {
  EarnScoreV1Schema,
  hashEarnScoreDimensionV1,
  hashEarnScoreV1,
  stableHashV1,
  type EarnCandidateV1,
  type EarnEvidenceKindV1,
  type EarnEvidenceV1,
  type EarnScoreDimensionNameV1,
  type EarnScoreDimensionV1,
  type EarnLiquidityStateV1,
  type EarnScoreV1,
  type HashV1,
} from '@mioagent/route-domain';
import { earnEvidenceAgeSecondsV1, earnEvidenceSetHashV1, earnFreshnessStateV1 } from './evidence.js';

export const EARN_SCORING_VERSION_V1 = 'earn-scoring/v1';
const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;

type NotScoredReasonV1 = 'not_requested' | 'insufficient_evidence' | 'stale_evidence' | 'validation_failed' | 'scoring_error';

interface DimensionCommonV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  createdAt: string;
  updatedAt: string;
  intentHash: HashV1;
  candidateHash: HashV1;
  evidenceSetHash: HashV1;
}

function confidenceLabel(value: number): 'low' | 'medium' | 'high' {
  if (value >= 0.75) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

function dimensionId(common: DimensionCommonV1, dimension: EarnScoreDimensionNameV1): string {
  return `earn-score-dim:${stableHashV1('earn-score-dim', { candidateHash: common.candidateHash, dimension }).slice(2, 26)}`;
}

function scoredDimensionV1(
  common: DimensionCommonV1,
  dimension: EarnScoreDimensionNameV1,
  score: number,
  confidenceValue: number,
  evidence: EarnEvidenceV1,
  now: Date,
): EarnScoreDimensionV1 {
  const base = {
    schemaVersion: 'earn-score-dimension/v1' as const,
    id: dimensionId(common, dimension),
    tenantId: common.tenantId,
    walletAddress: common.walletAddress,
    chainId: common.chainId,
    createdAt: common.createdAt,
    updatedAt: common.updatedAt,
    status: 'scored' as const,
    intentHash: common.intentHash,
    candidateHash: common.candidateHash,
    evidenceSetHash: common.evidenceSetHash,
    dimensionHash: ZERO_HASH_V1,
    dimension,
    score: Math.max(0, Math.min(100, Math.round(score))),
    notScoredReason: null,
    confidence: { value: confidenceValue, label: confidenceLabel(confidenceValue) },
    sources: [{ evidenceId: evidence.id, evidenceHash: evidence.evidenceHash, providerId: evidence.provider.id }],
    freshness: {
      observedAt: evidence.observedAt,
      expiresAt: evidence.expiresAt,
      ageSeconds: earnEvidenceAgeSecondsV1(evidence, now),
      state: earnFreshnessStateV1(evidence, now),
    },
    scoringVersion: EARN_SCORING_VERSION_V1,
    missingEvidence: [] as EarnEvidenceKindV1[],
  };
  return { ...base, dimensionHash: hashEarnScoreDimensionV1(base as unknown as EarnScoreDimensionV1) };
}

function notScoredDimensionV1(
  common: DimensionCommonV1,
  dimension: EarnScoreDimensionNameV1,
  reason: NotScoredReasonV1,
  missingEvidence: EarnEvidenceKindV1[],
): EarnScoreDimensionV1 {
  const base = {
    schemaVersion: 'earn-score-dimension/v1' as const,
    id: dimensionId(common, dimension),
    tenantId: common.tenantId,
    walletAddress: common.walletAddress,
    chainId: common.chainId,
    createdAt: common.createdAt,
    updatedAt: common.updatedAt,
    status: 'not_scored' as const,
    intentHash: common.intentHash,
    candidateHash: common.candidateHash,
    evidenceSetHash: common.evidenceSetHash,
    dimensionHash: ZERO_HASH_V1,
    dimension,
    score: null,
    notScoredReason: reason,
    confidence: null,
    sources: [],
    freshness: null,
    scoringVersion: EARN_SCORING_VERSION_V1,
    missingEvidence,
  };
  return { ...base, dimensionHash: hashEarnScoreDimensionV1(base as unknown as EarnScoreDimensionV1) };
}

/** Liquidity coverage relative to the deposit size. null datum => not scored. */
export function earnLiquidityStateV1(
  availableLiquidityAtomic: string | null,
  amountAtomic: string,
): EarnLiquidityStateV1 {
  if (availableLiquidityAtomic === null) return 'not_scored';
  const amount = BigInt(amountAtomic);
  if (amount <= 0n) return 'not_scored';
  const liquidity = BigInt(availableLiquidityAtomic);
  if (liquidity >= amount * 100n) return 'high';
  if (liquidity >= amount * 10n) return 'medium';
  return 'low';
}

function liquidityScore(state: EarnLiquidityStateV1): number {
  switch (state) {
    case 'high':
      return 90;
    case 'medium':
      return 65;
    case 'low':
      return 40;
    default:
      return 0;
  }
}

function netYieldScore(netApyBps: number): number {
  // 20 bps per point; 2000 bps (20% net APY) saturates at 100.
  return netApyBps / 20;
}

function routeSimplicityScore(candidate: EarnCandidateV1): number {
  let score = 100;
  score -= candidate.approvalCount * 10;
  score -= Math.max(0, candidate.callCount - 2) * 10;
  if (candidate.withdrawalModel === 'vault_redeem') score -= 15;
  return score;
}

export interface EarnScoreInputV1 {
  candidate: EarnCandidateV1;
  evidence: EarnEvidenceV1;
  now: Date;
}

/**
 * Per-candidate Earn Score — four dimensions, NO overall score (spec §5).
 * - net_yield: scored only with a fresh, non-null net APY (stale => not scored).
 * - liquidity: scored only with available-withdrawal data.
 * - route_simplicity: always scored (derived from the pinned calldata shape).
 * - transaction_safety: ALWAYS Not scored in T61 — a protocol allowlist is not
 *   a numeric Safety Score, and no contract-risk evidence exists (spec §5).
 */
export function buildEarnScoreV1(input: EarnScoreInputV1): EarnScoreV1 {
  const { candidate, evidence, now } = input;
  const evidenceSetHash = earnEvidenceSetHashV1(evidence);
  const nowIso = now.toISOString();
  const common: DimensionCommonV1 = {
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash,
  };
  const freshness = earnFreshnessStateV1(evidence, now);

  // net_yield
  let netYield: EarnScoreDimensionV1;
  if (candidate.netApyBps === null) {
    netYield = notScoredDimensionV1(common, 'net_yield', 'insufficient_evidence', ['yield_rate']);
  } else if (freshness === 'stale') {
    netYield = notScoredDimensionV1(common, 'net_yield', 'stale_evidence', ['yield_rate']);
  } else {
    netYield = scoredDimensionV1(common, 'net_yield', netYieldScore(candidate.netApyBps), 0.6, evidence, now);
  }

  // liquidity
  let liquidity: EarnScoreDimensionV1;
  const liquidityState = earnLiquidityStateV1(candidate.availableLiquidityAtomic, candidate.amount.amountAtomic);
  if (liquidityState === 'not_scored') {
    liquidity = notScoredDimensionV1(common, 'liquidity', 'insufficient_evidence', ['liquidity']);
  } else {
    liquidity = scoredDimensionV1(common, 'liquidity', liquidityScore(liquidityState), 0.5, evidence, now);
  }

  // route_simplicity — always scored
  const routeSimplicity = scoredDimensionV1(common, 'route_simplicity', routeSimplicityScore(candidate), 0.8, evidence, now);

  // transaction_safety — always Not scored in T61
  const transactionSafety = notScoredDimensionV1(common, 'transaction_safety', 'insufficient_evidence', ['contract_risk']);

  const dimensions = [netYield, liquidity, routeSimplicity, transactionSafety];
  const scoredCount = dimensions.filter((dimension) => dimension.status === 'scored').length;
  const status = scoredCount === 4 ? 'scored' : scoredCount === 0 ? 'not_scored' : 'partially_scored';

  const scoreBase = {
    schemaVersion: 'earn-score/v1' as const,
    id: `earn-score:${stableHashV1('earn-score', { candidateHash: candidate.candidateHash }).slice(2, 26)}`,
    tenantId: candidate.tenantId,
    walletAddress: candidate.walletAddress,
    chainId: candidate.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status,
    intentHash: candidate.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceSetHash,
    earnScoreHash: ZERO_HASH_V1,
    scoringVersion: EARN_SCORING_VERSION_V1,
    dimensions,
  };
  return EarnScoreV1Schema.parse({ ...scoreBase, earnScoreHash: hashEarnScoreV1(scoreBase as unknown as EarnScoreV1) });
}

export function earnDimensionV1(score: EarnScoreV1, dimension: EarnScoreDimensionNameV1): EarnScoreDimensionV1 {
  const found = score.dimensions.find((entry) => entry.dimension === dimension);
  if (!found) throw new Error(`Earn score missing dimension ${dimension}`);
  return found;
}
