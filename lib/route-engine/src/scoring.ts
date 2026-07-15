import {
  EvidenceSetV1Schema,
  PathScoreDimensionV1Schema,
  PathScoreV1Schema,
  ZERO_HASH_V1,
  hashPathScoreDimensionV1,
  hashPathScoreV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type EvidenceTypeV1,
  type PathScoreDimensionNameV1,
  type PathScoreDimensionV1,
  type PathScoreV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type { NetResultMetricV1 } from './contracts.js';
import {
  REQUIRED_EVIDENCE_V1,
  SCORE_CONFIDENCE_V1,
  SWAP_PATH_SCORE_VERSION_V1,
  UNCERTAIN_EXECUTION_RISK_FLAGS_V1,
} from './policy.js';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

function isUsdc(asset: RouteCandidateV1['expectedOutput']['asset']): boolean {
  return (
    asset.kind === 'erc20' &&
    asset.decimals === 6 &&
    (asset.address === BASE_USDC || asset.address === BASE_SEPOLIA_USDC)
  );
}

function decimalToMicros(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  const padded = `${fraction}000000`;
  const micros = BigInt(whole!) * 1_000_000n + BigInt(padded.slice(0, 6));
  return micros + (padded.slice(6).replace(/0/g, '').length > 0 ? 1n : 0n);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function evidenceSource(record: EvidenceRecordV1) {
  return {
    evidenceId: record.id,
    evidenceHash: record.evidenceHash,
    providerId: record.provider.id,
  };
}

function freshQuote(set: EvidenceSetV1, nowMs: number): EvidenceRecordV1 | undefined {
  return set.records.find(
    (record) =>
      record.evidenceType === 'quote' &&
      record.status === 'observed' &&
      record.validationStatus === 'valid' &&
      Date.parse(record.observedAt) <= nowMs &&
      record.expiresAt !== null &&
      Date.parse(record.expiresAt) > nowMs,
  );
}

function freshGas(set: EvidenceSetV1, nowMs: number): EvidenceRecordV1 | undefined {
  return set.records.find(
    (record) =>
      record.evidenceType === 'gas' &&
      record.status === 'observed' &&
      record.validationStatus === 'valid' &&
      Date.parse(record.observedAt) <= nowMs &&
      (record.expiresAt === null || Date.parse(record.expiresAt) > nowMs),
  );
}

function scoreConfidence(set: EvidenceSetV1) {
  if (set.status !== 'complete') return SCORE_CONFIDENCE_V1.low;
  if (set.sourceIndependence !== 'independent') return SCORE_CONFIDENCE_V1.medium;
  return SCORE_CONFIDENCE_V1.high;
}

function metricForCandidate(
  intent: RouteIntentV1,
  candidate: RouteCandidateV1,
  set: EvidenceSetV1,
  nowMs: number,
): NetResultMetricV1 {
  const expected = BigInt(candidate.expectedOutput.amountAtomic);
  const quote = freshQuote(set, nowMs);
  const gas = freshGas(set, nowMs);
  const base = {
    candidateHash: candidate.candidateHash,
    expectedOutputAtomic: expected.toString(),
  } as const;
  if (!quote || set.status === 'stale') {
    return {
      ...base,
      status: 'not_scored',
      valuation: 'unsupported',
      gasCostUsdMicros: null,
      intelligenceCostUsdMicros: null,
      gasCostOutputAtomic: null,
      intelligenceCostOutputAtomic: null,
      netOutputAtomic: null,
      reason: 'stale_quote_evidence',
    };
  }
  if (!gas || candidate.estimatedGas.estimatedCostUsd === null) {
    return {
      ...base,
      status: 'not_scored',
      valuation: 'unsupported',
      gasCostUsdMicros: null,
      intelligenceCostUsdMicros: null,
      gasCostOutputAtomic: null,
      intelligenceCostOutputAtomic: null,
      netOutputAtomic: null,
      reason: 'gas_usd_valuation_unavailable',
    };
  }
  const paid = set.records.filter(
    (record) =>
      record.freeOrPaid === 'paid' &&
      record.validationStatus === 'valid' &&
      record.status === 'observed' &&
      Date.parse(record.observedAt) <= nowMs &&
      (record.expiresAt === null || Date.parse(record.expiresAt) > nowMs),
  );
  if (paid.some((record) => record.cost?.usdValue === null || !record.cost)) {
    return {
      ...base,
      status: 'not_scored',
      valuation: 'unsupported',
      gasCostUsdMicros: decimalToMicros(candidate.estimatedGas.estimatedCostUsd).toString(),
      intelligenceCostUsdMicros: null,
      gasCostOutputAtomic: null,
      intelligenceCostOutputAtomic: null,
      netOutputAtomic: null,
      reason: 'paid_intelligence_usd_valuation_unavailable',
    };
  }
  const gasUsd = decimalToMicros(candidate.estimatedGas.estimatedCostUsd);
  const intelligenceUsd = paid.reduce(
    (sum, record) => sum + decimalToMicros(record.cost!.usdValue!),
    0n,
  );
  let valuation: NetResultMetricV1['valuation'];
  let gasOutput: bigint;
  let intelligenceOutput: bigint;
  if (isUsdc(candidate.expectedOutput.asset)) {
    valuation = 'output_usdc';
    gasOutput = gasUsd;
    intelligenceOutput = intelligenceUsd;
  } else if (
    intent.fromAsset &&
    isUsdc(intent.fromAsset) &&
    ['ETH', 'WETH'].includes(candidate.expectedOutput.asset.symbol.toUpperCase())
  ) {
    valuation = 'input_usdc_quote_anchor';
    const inputAtomic = BigInt(candidate.inputAmount.amountAtomic);
    gasOutput = ceilDiv(gasUsd * expected, inputAtomic);
    intelligenceOutput = ceilDiv(intelligenceUsd * expected, inputAtomic);
  } else {
    return {
      ...base,
      status: 'not_scored',
      valuation: 'unsupported',
      gasCostUsdMicros: gasUsd.toString(),
      intelligenceCostUsdMicros: intelligenceUsd.toString(),
      gasCostOutputAtomic: null,
      intelligenceCostOutputAtomic: null,
      netOutputAtomic: null,
      reason: 'output_asset_valuation_unavailable',
    };
  }
  const net = expected - gasOutput - intelligenceOutput;
  return {
    ...base,
    status: net > 0n ? 'computed' : 'not_scored',
    valuation,
    gasCostUsdMicros: gasUsd.toString(),
    intelligenceCostUsdMicros: intelligenceUsd.toString(),
    gasCostOutputAtomic: gasOutput.toString(),
    intelligenceCostOutputAtomic: intelligenceOutput.toString(),
    netOutputAtomic: net > 0n ? net.toString() : null,
    reason: net > 0n ? null : 'non_positive_net_result',
  };
}

type NotScoredReason = NonNullable<PathScoreDimensionV1['notScoredReason']>;

function dimension(input: {
  intent: RouteIntentV1;
  candidate: RouteCandidateV1;
  set: EvidenceSetV1;
  now: Date;
  name: PathScoreDimensionNameV1;
  score: number | null;
  reason: NotScoredReason | null;
  sources: EvidenceRecordV1[];
  missingEvidence?: EvidenceTypeV1[];
}): PathScoreDimensionV1 {
  const scored = input.score !== null;
  const quote = freshQuote(input.set, input.now.getTime());
  const freshness =
    scored && quote
      ? {
          observedAt: quote.observedAt,
          expiresAt: quote.expiresAt,
          ageSeconds: Math.floor((input.now.getTime() - Date.parse(quote.observedAt)) / 1_000),
          state: 'fresh' as const,
        }
      : null;
  const draft: PathScoreDimensionV1 = {
    schemaVersion: 'path-score-dimension/v1',
    id: `score-dimension:${stableHashV1('swap-path-score-dimension-id/v1', {
      candidateHash: input.candidate.candidateHash,
      dimension: input.name,
      evidenceSetHash: input.set.evidenceSetHash,
    }).slice(2)}`,
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: input.intent.chainId,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    status: scored ? 'scored' : 'not_scored',
    intentHash: input.intent.intentHash,
    candidateHash: input.candidate.candidateHash,
    evidenceSetHash: input.set.evidenceSetHash,
    dimensionHash: ZERO_HASH_V1,
    dimension: input.name,
    score: input.score,
    notScoredReason: input.reason,
    confidence: scored ? scoreConfidence(input.set) : null,
    sources: scored ? input.sources.map(evidenceSource).sort((a, b) => a.evidenceHash.localeCompare(b.evidenceHash)) : [],
    freshness,
    scoringVersion: SWAP_PATH_SCORE_VERSION_V1,
    missingEvidence: scored ? [] : (input.missingEvidence ?? []),
  };
  return PathScoreDimensionV1Schema.parse({
    ...draft,
    dimensionHash: hashPathScoreDimensionV1(draft),
  });
}

function quoteFreshnessScore(quote: EvidenceRecordV1, nowMs: number): number {
  const observed = Date.parse(quote.observedAt);
  const expires = Date.parse(quote.expiresAt!);
  const total = BigInt(expires - observed);
  const remaining = BigInt(expires - nowMs);
  const raw = Number((100n * remaining) / total);
  return Math.max(0, Math.min(100, raw));
}

export interface ScoredRouteV1 {
  candidate: RouteCandidateV1;
  evidenceSet: EvidenceSetV1;
  pathScore: PathScoreV1;
  netMetric: NetResultMetricV1;
}

export function scoreRoutesV1(input: {
  intent: RouteIntentV1;
  candidates: readonly RouteCandidateV1[];
  evidenceSets: readonly EvidenceSetV1[];
  now: Date;
}): ScoredRouteV1[] {
  const sets = new Map(input.evidenceSets.map((set) => [set.candidateHash, EvidenceSetV1Schema.parse(set)]));
  const metrics = new Map<string, NetResultMetricV1>();
  for (const candidate of input.candidates) {
    const set = sets.get(candidate.candidateHash)!;
    metrics.set(candidate.candidateHash, metricForCandidate(input.intent, candidate, set, input.now.getTime()));
  }
  const computed = [...metrics.values()].filter(
    (metric): metric is NetResultMetricV1 & { netOutputAtomic: string } =>
      metric.status === 'computed' && metric.netOutputAtomic !== null,
  );
  const bestNet = computed.reduce<bigint | null>(
    (best, metric) => best === null || BigInt(metric.netOutputAtomic) > best ? BigInt(metric.netOutputAtomic) : best,
    null,
  );

  return [...input.candidates]
    .sort((a, b) => a.candidateHash.localeCompare(b.candidateHash))
    .map((candidate) => {
      const set = sets.get(candidate.candidateHash)!;
      const metric = metrics.get(candidate.candidateHash)!;
      const quote = freshQuote(set, input.now.getTime());
      const gas = freshGas(set, input.now.getTime());
      const stale = set.status === 'stale' || !quote;
      let netScore: number | null = null;
      if (metric.status === 'computed' && metric.netOutputAtomic && bestNet !== null) {
        const net = BigInt(metric.netOutputAtomic);
        const lossBps = ((bestNet - net) * 10_000n) / bestNet;
        const penalty = Number(ceilDiv(lossBps, 10n));
        netScore = Math.max(0, 100 - penalty);
      }
      const netMissing: EvidenceTypeV1[] = !quote ? ['quote'] : !gas ? ['gas'] : ['gas'];
      const net = dimension({
        intent: input.intent,
        candidate,
        set,
        now: input.now,
        name: 'net_result',
        score: netScore,
        reason: netScore !== null ? null : stale ? 'stale_evidence' : metric.reason === 'non_positive_net_result' ? 'scoring_error' : 'insufficient_evidence',
        sources: quote && gas
          ? [
              quote,
              gas,
              ...set.records.filter(
                (record) =>
                  record.freeOrPaid === 'paid' &&
                  record.status === 'observed' &&
                  record.validationStatus === 'valid' &&
                  Date.parse(record.observedAt) <= input.now.getTime() &&
                  (record.expiresAt === null || Date.parse(record.expiresAt) > input.now.getTime()),
              ),
            ]
          : [],
        missingEvidence: netScore === null && !stale && metric.reason !== 'non_positive_net_result' ? netMissing : [],
      });
      const freshness = dimension({
        intent: input.intent,
        candidate,
        set,
        now: input.now,
        name: 'quote_freshness',
        score: quote ? quoteFreshnessScore(quote, input.now.getTime()) : null,
        reason: quote ? null : 'stale_evidence',
        sources: quote ? [quote] : [],
      });
      const uncertain = candidate.trustMetadata.riskFlags.some((flag) =>
        UNCERTAIN_EXECUTION_RISK_FLAGS_V1.has(flag.toLowerCase()),
      );
      const simplicityScore =
        quote && !uncertain
          ? Math.max(0, 100 - 15 * Math.max(0, candidate.callCount - 1) - 20 * candidate.approvalCount)
          : null;
      const simplicity = dimension({
        intent: input.intent,
        candidate,
        set,
        now: input.now,
        name: 'route_simplicity',
        score: simplicityScore,
        reason: simplicityScore !== null ? null : quote ? 'insufficient_evidence' : 'stale_evidence',
        sources: quote ? [quote] : [],
        missingEvidence: uncertain ? ['quote'] : [],
      });
      const safetyMissing = [...REQUIRED_EVIDENCE_V1[input.intent.verificationDepth]].filter(
        (type) => !['quote', 'gas'].includes(type),
      );
      const safety = dimension({
        intent: input.intent,
        candidate,
        set,
        now: input.now,
        name: 'transaction_safety',
        score: null,
        reason: input.intent.verificationDepth === 'standard' ? 'not_requested' : 'insufficient_evidence',
        sources: [],
        missingEvidence: input.intent.verificationDepth === 'standard' ? [] : safetyMissing,
      });
      const dimensions = [net, freshness, simplicity, safety];
      const scoredCount = dimensions.filter((item) => item.status === 'scored').length;
      const scoreDraft: PathScoreV1 = {
        schemaVersion: 'path-score/v1',
        id: `path-score:${stableHashV1('swap-path-score-id/v1', {
          candidateHash: candidate.candidateHash,
          evidenceSetHash: set.evidenceSetHash,
          scoringVersion: SWAP_PATH_SCORE_VERSION_V1,
        }).slice(2)}`,
        tenantId: input.intent.tenantId,
        walletAddress: input.intent.walletAddress,
        chainId: input.intent.chainId,
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
        status: scoredCount === 4 ? 'scored' : scoredCount === 0 ? 'not_scored' : 'partially_scored',
        intentHash: input.intent.intentHash,
        candidateHash: candidate.candidateHash,
        evidenceSetHash: set.evidenceSetHash,
        pathScoreHash: ZERO_HASH_V1,
        scoringVersion: SWAP_PATH_SCORE_VERSION_V1,
        dimensions,
      };
      return {
        candidate,
        evidenceSet: set,
        netMetric: metric,
        pathScore: PathScoreV1Schema.parse({
          ...scoreDraft,
          pathScoreHash: hashPathScoreV1(scoreDraft),
        }),
      };
    });
}
