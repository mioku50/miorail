import {
  AddressV1Schema,
  HashV1Schema,
  OptimizationModeV1Schema,
  PathScoreV1Schema,
  RouteCandidateV1Schema,
  EvidenceSetV1Schema,
  stableHashV1,
  type HashV1,
} from '@mioagent/route-domain';
import { z } from 'zod';
import { SWAP_ROUTE_CONFIDENCE_VERSION_V1 } from './policy.js';

export const SwapAdapterFailureV1Schema = z
  .object({
    outcome: z.enum([
      'unsupported',
      'not_configured',
      'unavailable',
      'timeout',
      'rate_limited',
      'invalid_response',
      'rejected',
      // A provider that CAN route this and will not, on its own trading
      // policy. Kept apart from `unavailable` and `unsupported` all the way to
      // the wire: a surface that receives it must be able to say who declined,
      // and neither of those two words can.
      'policy_refused',
    ]),
    // T67B: Aerodrome quotes over Base RPC rather than a partner API, so it
    // reports failures through the same shape as the two HTTP adapters.
    provider: z.enum(['uniswap', 'kyberswap', 'aerodrome', 'balancer', 'hydrex', 'o1-exchange']),
    errorCode: z.string().min(1).max(200),
    retryable: z.boolean(),
  })
  .strict();
export type SwapAdapterFailureV1 = z.infer<typeof SwapAdapterFailureV1Schema>;

export const CrossCandidateOverlapV1Schema = z
  .object({
    sourceKey: z.string().min(1).max(300),
    candidateHashes: z.array(HashV1Schema).min(2),
    providerIds: z.array(z.string().min(1).max(100)).min(1),
  })
  .strict();
export type CrossCandidateOverlapV1 = z.infer<typeof CrossCandidateOverlapV1Schema>;

export const ComparisonConfidenceV1Schema = z
  .object({
    policyVersion: z.literal(SWAP_ROUTE_CONFIDENCE_VERSION_V1),
    label: z.enum(['low', 'medium', 'high']),
    value: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1).max(120)),
  })
  .strict();
export type ComparisonConfidenceV1 = z.infer<typeof ComparisonConfidenceV1Schema>;

export const NetResultMetricV1Schema = z
  .object({
    candidateHash: HashV1Schema,
    status: z.enum(['computed', 'not_scored']),
    valuation: z.enum(['output_usdc', 'input_usdc_quote_anchor', 'unsupported']),
    expectedOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    gasCostUsdMicros: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    intelligenceCostUsdMicros: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    gasCostOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    intelligenceCostOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    netOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
    reason: z.string().min(1).max(200).nullable(),
    // --- T67C.1 Part 2: history calibration ------------------------------
    // All optional and all ABSENT under swap-path-score/v1, so a v1 evaluation
    // canonicalises byte-for-byte as it did before this task. `netOutputAtomic`
    // keeps its v1 meaning — the RAW quoted net result — and the adjusted
    // figure lives beside it rather than replacing it, because a user comparing
    // routes is owed both the offer and the expectation.
    //
    // Provider fees are not a separate subtraction: a DEX or aggregator quote
    // is already net of its own fee, so `expectedOutput` includes it. Adding a
    // second fee term here would charge it twice.
    calibrationApplied: z.boolean().optional(),
    historyAdjustedNetOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    calibratedExpectedOutputAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable().optional(),
    appliedShortfallBps: z.number().int().nonnegative().nullable().optional(),
    reliabilityScope: z.enum(['personal', 'network']).nullable().optional(),
    reliabilitySnapshotHash: HashV1Schema.nullable().optional(),
    reliabilityCutoffAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type NetResultMetricV1 = z.infer<typeof NetResultMetricV1Schema>;

export const SwapRouteEvaluationReasonV1Schema = z.enum([
  'multiple_routes_compared',
  'user_protocol_constraint',
  'single_provider_available',
  'insufficient_rankable_candidates',
  'unsupported_optimization_evidence',
  'all_providers_failed',
  'all_quotes_expired',
  'invalid_evidence',
]);

const SwapRouteEvaluationV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('swap-route-evaluation/v1'),
    evaluationHash: HashV1Schema,
    intentHash: HashV1Schema,
    tenantId: z.string().min(1).max(200),
    walletAddress: AddressV1Schema,
    chainId: z.union([z.literal(8453), z.literal(84532)]),
    evaluatedAt: z.string().datetime({ offset: true }),
    outcome: z.enum(['ready', 'constrained', 'degraded', 'failed']),
    reason: SwapRouteEvaluationReasonV1Schema,
    candidates: z.array(RouteCandidateV1Schema),
    adapterFailures: z.array(SwapAdapterFailureV1Schema),
    evidenceSets: z.array(EvidenceSetV1Schema),
    pathScores: z.array(PathScoreV1Schema),
    netResultMetrics: z.array(NetResultMetricV1Schema),
    recommendedCandidateHash: HashV1Schema.nullable(),
    alternativeCandidateHashes: z.array(HashV1Schema),
    comparisonConfidence: ComparisonConfidenceV1Schema,
    crossCandidateOverlaps: z.array(CrossCandidateOverlapV1Schema),
    optimizationMode: OptimizationModeV1Schema,
  })
  .strict();

export type SwapRouteEvaluationV1 = z.infer<typeof SwapRouteEvaluationV1ObjectSchema>;

export function hashSwapRouteEvaluationV1(value: SwapRouteEvaluationV1): HashV1 {
  const content: Partial<SwapRouteEvaluationV1> = { ...value };
  delete content.evaluationHash;
  return stableHashV1('swap-route-evaluation/v1', content);
}

export const SwapRouteEvaluationV1Schema = SwapRouteEvaluationV1ObjectSchema.superRefine(
  (value, ctx) => {
    if (value.evaluationHash !== hashSwapRouteEvaluationV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluationHash'],
        message: 'evaluationHash does not match the canonical swap-route-evaluation/v1 payload',
      });
    }
    const candidateHashes = value.candidates.map((candidate) => candidate.candidateHash);
    const sortedCandidates = [...candidateHashes].sort();
    if (JSON.stringify(candidateHashes) !== JSON.stringify(sortedCandidates)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: 'Candidates must be sorted by candidateHash',
      });
    }
    if (new Set(candidateHashes).size !== candidateHashes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates'],
        message: 'Candidate hashes must be unique',
      });
    }
    const linkedHash = new Set(candidateHashes);
    for (const [path, hashes] of [
      ['evidenceSets', value.evidenceSets.map((set) => set.candidateHash)],
      ['pathScores', value.pathScores.map((score) => score.candidateHash)],
      ['netResultMetrics', value.netResultMetrics.map((metric) => metric.candidateHash)],
    ] as const) {
      if (hashes.some((hash) => !linkedHash.has(hash))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} must reference an evaluation candidate`,
        });
      }
      if (JSON.stringify(hashes) !== JSON.stringify([...hashes].sort())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} must be sorted by candidateHash`,
        });
      }
    }
    if (
      value.recommendedCandidateHash !== null &&
      !linkedHash.has(value.recommendedCandidateHash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedCandidateHash'],
        message: 'Recommended candidate must belong to the evaluation',
      });
    }
    if (value.outcome === 'degraded' && value.reason === 'single_provider_available' && value.recommendedCandidateHash !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedCandidateHash'],
        message: 'Provider degradation must not claim a comparative recommendation',
      });
    }
  },
);
