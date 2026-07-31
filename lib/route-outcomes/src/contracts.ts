import { z } from 'zod';
import {
  AddressV1Schema,
  AtomicAmountV1Schema,
  EntityIdV1Schema,
  HashV1Schema,
  TenantIdV1Schema,
  TimestampV1Schema,
  ZERO_HASH_V1,
  financialContentV1,
  stableHashV1,
  type HashV1,
} from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T67C.1 — the contracts that close the loop from a finalized Route Proof back
// into the next route ranking.
//
// The whole point is that a provider which systematically delivers less than it
// quoted should lose ground automatically. That is only defensible if the
// statistics are reproducible by someone who does not trust us, so every value
// here is an integer, every hash covers exactly the content it claims to, and
// nothing is derived from a clock at read time.
//
// What is deliberately absent, everywhere in this file: any composite score.
// There is no Reliability /100. A success rate, a median shortfall and a p90
// confirmation time are different questions with different units, and blending
// them into one number destroys the only information a user could act on.
// ---------------------------------------------------------------------------

/** Base mainnet only. Reliability history from one chain cannot be read as
 * evidence about another, and V1 has no story for merging them. */
export const OUTCOME_CHAIN_ID_V1 = 8453 as const;

export const ROUTE_OUTCOME_DERIVATION_VERSION_V1 = 'route-provider-outcome/v1' as const;

/** The swap providers V1 keeps history for. Earn, NFT, Commerce and Private AI
 * are out of scope: their outcomes are not comparable to a swap's quoted-versus-
 * delivered output, and pretending otherwise would pollute the statistic. */
export const OUTCOME_PROVIDER_IDS_V1: readonly string[] = ['uniswap', 'kyberswap', 'aerodrome'];

export const OutcomeProviderIdV1Schema = z.enum(['uniswap', 'kyberswap', 'aerodrome']);
export type OutcomeProviderIdV1 = z.infer<typeof OutcomeProviderIdV1Schema>;

/**
 * The proof states that count as an execution outcome.
 *
 * `cancelled` is absent on purpose: a user who changed their mind said nothing
 * about the provider, and counting it as a failure would punish a provider for
 * a human decision. `pending`, `submitted_unknown` and `reconciliation_required`
 * are absent because they are not yet answers — an unknown receipt recorded as
 * anything at all is a guess, and this table exists to hold facts.
 */
export const OUTCOME_ELIGIBLE_PROOF_STATUSES_V1 = [
  'completed',
  'partial_failure',
  'failed',
] as const;

export const OutcomeProofFinalStatusV1Schema = z.enum(OUTCOME_ELIGIBLE_PROOF_STATUSES_V1);
export type OutcomeProofFinalStatusV1 = z.infer<typeof OutcomeProofFinalStatusV1Schema>;

/** What the reconciler actually verified against the chain. Recorded separately
 * from the proof status so a reader can tell "we saw every receipt succeed"
 * from "the proof says completed". */
export const ReceiptVerificationV1Schema = z.enum([
  'verified_success',
  'verified_reverted',
  'verified_mixed',
]);
export type ReceiptVerificationV1 = z.infer<typeof ReceiptVerificationV1Schema>;

const RouteProviderOutcomeV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('route-provider-outcome/v1'),
    id: EntityIdV1Schema,
    tenantId: TenantIdV1Schema,
    walletAddress: AddressV1Schema,
    chainId: z.literal(OUTCOME_CHAIN_ID_V1),
    status: z.literal('derived'),
    outcomeHash: HashV1Schema,

    /** Exactly one outcome per proof, enforced again by a unique index. Both the
     * id and the hash are pinned: a re-derivation that produced a different
     * proof hash for the same proof id would mean the proof changed after it
     * was final, which must fail closed rather than overwrite history. */
    proofId: EntityIdV1Schema,
    proofHash: HashV1Schema,

    providerId: OutcomeProviderIdV1Schema,
    /** CAIP-style asset ids, not symbols. Two tokens can share a symbol; the
     * statistic must be about one pair. */
    fromAsset: z.string().min(1).max(200),
    toAsset: z.string().min(1).max(200),

    expectedOutputAtomic: AtomicAmountV1Schema,
    minimumOutputAtomic: AtomicAmountV1Schema,
    actualOutputAtomic: AtomicAmountV1Schema.nullable(),
    estimatedGasAtomic: AtomicAmountV1Schema.nullable(),
    actualGasAtomic: AtomicAmountV1Schema.nullable(),

    /** Signed: positive means the provider delivered MORE than it quoted. */
    quoteDeviationBps: z.number().int().nullable(),
    /** Never negative. Overdelivery is not a credit against a future shortfall —
     * see `adverseShortfallBpsV1`. */
    adverseShortfallBps: z.number().int().nonnegative().nullable(),
    floorBreached: z.boolean().nullable(),
    confirmationMs: z.number().int().nonnegative().nullable(),

    proofFinalStatus: OutcomeProofFinalStatusV1Schema,
    receiptVerification: ReceiptVerificationV1Schema,

    occurredAt: TimestampV1Schema,
    /** When this row was written. Excluded from the hash on purpose: a backfill
     * must produce the byte-identical outcome the projector would have. */
    derivedAt: TimestampV1Schema,
    derivationVersion: z.string().min(1).max(120),
  })
  .strict();

export type RouteProviderOutcomeV1 = z.infer<typeof RouteProviderOutcomeV1ObjectSchema>;

export function hashRouteProviderOutcomeV1(value: RouteProviderOutcomeV1): HashV1 {
  return stableHashV1(
    'route-provider-outcome/v1',
    financialContentV1(value, ['outcomeHash', 'derivedAt']),
  );
}

export const RouteProviderOutcomeV1Schema = RouteProviderOutcomeV1ObjectSchema.superRefine(
  (value, ctx) => {
    if (value.outcomeHash !== hashRouteProviderOutcomeV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeHash'],
        message: 'outcomeHash does not match the canonical outcome content',
      });
    }
    if (value.fromAsset === value.toAsset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toAsset'],
        message: 'A swap outcome must have distinct input and output assets',
      });
    }
    if (BigInt(value.minimumOutputAtomic) > BigInt(value.expectedOutputAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimumOutputAtomic'],
        message: 'minimumOutputAtomic must not exceed expectedOutputAtomic',
      });
    }
    if (BigInt(value.expectedOutputAtomic) === 0n) {
      // Every derived ratio divides by it.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedOutputAtomic'],
        message: 'expectedOutputAtomic must be positive',
      });
    }

    const delivered = value.actualOutputAtomic !== null;
    if (value.proofFinalStatus === 'failed') {
      // Nothing arrived, so there is no shortfall to measure. Recording a 100%
      // shortfall would double-count the failure: it is already a failure in
      // the success rate, and letting it also drag the median shortfall down
      // would mean one revert moves two independent statistics.
      if (delivered || value.adverseShortfallBps !== null || value.floorBreached !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actualOutputAtomic'],
          message: 'A failed outcome carries no delivered amount, shortfall or floor verdict',
        });
      }
      if (value.receiptVerification !== 'verified_reverted') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['receiptVerification'],
          message: 'A failed outcome requires verified_reverted receipts',
        });
      }
    } else {
      if (!delivered || value.adverseShortfallBps === null || value.floorBreached === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actualOutputAtomic'],
          message: 'A settled outcome requires a delivered amount, shortfall and floor verdict',
        });
      }
      const expectedVerification =
        value.proofFinalStatus === 'completed' ? 'verified_success' : 'verified_mixed';
      if (value.receiptVerification !== expectedVerification) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['receiptVerification'],
          message: `A ${value.proofFinalStatus} outcome requires ${expectedVerification} receipts`,
        });
      }
    }

    if (delivered && value.actualOutputAtomic !== null) {
      const expected = BigInt(value.expectedOutputAtomic);
      const actual = BigInt(value.actualOutputAtomic);
      if (value.quoteDeviationBps !== quoteDeviationBpsV1(expected, actual)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quoteDeviationBps'],
          message: 'quoteDeviationBps must be derived from the recorded amounts',
        });
      }
      if (value.adverseShortfallBps !== adverseShortfallBpsV1(expected, actual)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['adverseShortfallBps'],
          message: 'adverseShortfallBps must be derived from the recorded amounts',
        });
      }
      if (value.floorBreached !== (actual < BigInt(value.minimumOutputAtomic))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['floorBreached'],
          message: 'floorBreached must be derived from the recorded amounts',
        });
      }
    }
  },
);

/**
 * `(actual - expected) × 10000 / expected`, truncated toward zero.
 *
 * Signed, so a provider that overdelivers is visible as such. Nothing consumes
 * the positive side to soften a later shortfall — see below.
 */
export function quoteDeviationBpsV1(expected: bigint, actual: bigint): number {
  if (expected <= 0n) throw new RangeError('expected output must be positive');
  return Number(((actual - expected) * 10_000n) / expected);
}

/**
 * `max(0, (expected - actual) × 10000 / expected)`.
 *
 * Clamped at zero, and that clamp is the point. If overdelivery reduced the
 * measured shortfall, a provider could earn a calibration bonus by quoting
 * conservatively — which is a different behaviour from executing well, and
 * would let the number be gamed by whoever understood it best.
 */
export function adverseShortfallBpsV1(expected: bigint, actual: bigint): number {
  if (expected <= 0n) throw new RangeError('expected output must be positive');
  if (actual >= expected) return 0;
  return Number(((expected - actual) * 10_000n) / expected);
}

// --- reliability snapshots -------------------------------------------------

export const RELIABILITY_SCOPES_V1 = ['personal', 'network'] as const;
export const ReliabilityScopeV1Schema = z.enum(RELIABILITY_SCOPES_V1);
export type ReliabilityScopeV1 = z.infer<typeof ReliabilityScopeV1Schema>;

const ProviderReliabilitySnapshotV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('provider-reliability-snapshot/v1'),
    id: EntityIdV1Schema,
    status: z.literal('sealed'),
    createdAt: TimestampV1Schema,

    scope: ReliabilityScopeV1Schema,
    /** Personal only. A network snapshot belongs to no tenant, which is what
     * makes it shareable without leaking whose routes produced it. */
    tenantId: TenantIdV1Schema.nullable(),
    walletAddress: AddressV1Schema.nullable(),

    providerId: OutcomeProviderIdV1Schema,
    chainId: z.literal(OUTCOME_CHAIN_ID_V1),
    fromAsset: z.string().min(1).max(200),
    toAsset: z.string().min(1).max(200),

    windowDays: z.number().int().positive(),
    /** Outcomes are included only up to here. A snapshot is a statement about
     * the past as of a moment; letting a later outcome in would let the result
     * of a trade influence the ranking that chose it. */
    cutoffAt: TimestampV1Schema,

    sampleSize: z.number().int().nonnegative(),
    uniqueWalletCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    partialFailureCount: z.number().int().nonnegative(),

    successRateBps: z.number().int().min(0).max(10_000),
    medianAdverseShortfallBps: z.number().int().nonnegative(),
    p90AdverseShortfallBps: z.number().int().nonnegative(),
    floorBreachRateBps: z.number().int().min(0).max(10_000),
    medianGasErrorBps: z.number().int().nullable(),
    p90ConfirmationMs: z.number().int().nonnegative().nullable(),

    /** Hash of the ordered outcome hashes that went in. Changing one outcome
     * changes this, and therefore the snapshot hash. */
    outcomeSetHash: HashV1Schema,
    snapshotHash: HashV1Schema,
    aggregationVersion: z.string().min(1).max(120),
  })
  .strict();

export type ProviderReliabilitySnapshotV1 = z.infer<
  typeof ProviderReliabilitySnapshotV1ObjectSchema
>;

export function hashProviderReliabilitySnapshotV1(value: ProviderReliabilitySnapshotV1): HashV1 {
  return stableHashV1(
    'provider-reliability-snapshot/v1',
    financialContentV1(value, ['snapshotHash']),
  );
}

/** The set hash the snapshot must carry, given its members in order. */
export function hashOutcomeSetV1(outcomeHashes: readonly HashV1[]): HashV1 {
  return stableHashV1('provider-reliability-outcome-set/v1', { outcomeHashes });
}

export const ProviderReliabilitySnapshotV1Schema =
  ProviderReliabilitySnapshotV1ObjectSchema.superRefine((value, ctx) => {
    if (value.snapshotHash !== hashProviderReliabilitySnapshotV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'snapshotHash does not match the canonical snapshot content',
      });
    }
    const personal = value.scope === 'personal';
    if (personal !== (value.tenantId !== null) || personal !== (value.walletAddress !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'A personal snapshot is bound to a tenant and wallet; a network snapshot to neither',
      });
    }
    const counted = value.completedCount + value.failedCount + value.partialFailureCount;
    if (counted !== value.sampleSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sampleSize'],
        message: 'sampleSize must equal completed + failed + partial_failure',
      });
    }
    if (value.uniqueWalletCount > value.sampleSize) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uniqueWalletCount'],
        message: 'uniqueWalletCount cannot exceed sampleSize',
      });
    }
    if (personal && value.uniqueWalletCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uniqueWalletCount'],
        message: 'A personal snapshot covers exactly one wallet',
      });
    }
    if (value.p90AdverseShortfallBps < value.medianAdverseShortfallBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['p90AdverseShortfallBps'],
        message: 'p90 cannot be below the median',
      });
    }
    if (value.sampleSize === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sampleSize'],
        message: 'A snapshot over no outcomes states nothing and must not be sealed',
      });
    }
  });

// --- the per-candidate decision -------------------------------------------

export const RELIABILITY_NOT_SCORED_REASONS_V1 = [
  'feature_disabled',
  'no_verified_history',
  'insufficient_history',
  'unsupported_provider',
] as const;

export const ProviderReliabilityAssessmentV1Schema = z
  .object({
    schemaVersion: z.literal('provider-reliability-assessment/v1'),
    providerId: z.string().min(1).max(100),
    fromAsset: z.string().min(1).max(200),
    toAsset: z.string().min(1).max(200),
    status: z.enum(['eligible', 'not_scored']),
    scope: ReliabilityScopeV1Schema.nullable(),
    snapshot: ProviderReliabilitySnapshotV1Schema.nullable(),
    notScoredReason: z.enum(RELIABILITY_NOT_SCORED_REASONS_V1).nullable(),
    /** Both surfaced so the UI can say "8 verified routes · 10 required"
     * instead of an unexplained absence. */
    observedSamples: z.number().int().nonnegative(),
    requiredSamples: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const eligible = value.status === 'eligible';
    if (eligible !== (value.snapshot !== null) || eligible !== (value.scope !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot'],
        message: 'An eligible assessment carries a snapshot and scope; Not scored carries neither',
      });
    }
    if (eligible === (value.notScoredReason !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notScoredReason'],
        message: 'Not scored requires a reason; eligible must not carry one',
      });
    }
    if (value.snapshot && value.snapshot.scope !== value.scope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'assessment scope must match the snapshot it carries',
      });
    }
  });

export type ProviderReliabilityAssessmentV1 = z.infer<
  typeof ProviderReliabilityAssessmentV1Schema
>;

// --- calibrated net result -------------------------------------------------

export const SWAP_CALIBRATION_VERSION_V1 = 'swap-path-score/v2' as const;

export const CalibratedNetResultV1Schema = z
  .object({
    schemaVersion: z.literal('calibrated-net-result/v1'),
    candidateHash: HashV1Schema,
    /** True only when an eligible snapshot was applied. False means every
     * calibrated field below equals its raw counterpart, and the UI must say
     * the comparison was uncalibrated rather than imply history backed it. */
    calibrated: z.boolean(),
    scope: ReliabilityScopeV1Schema.nullable(),
    snapshotHash: HashV1Schema.nullable(),
    cutoffAt: TimestampV1Schema.nullable(),
    appliedShortfallBps: z.number().int().nonnegative(),
    rawExpectedOutputAtomic: AtomicAmountV1Schema,
    calibratedExpectedOutputAtomic: AtomicAmountV1Schema,
    rawNetOutputAtomic: AtomicAmountV1Schema.nullable(),
    calibratedNetOutputAtomic: AtomicAmountV1Schema.nullable(),
    calibrationVersion: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    const calibrated = value.calibrated;
    if (calibrated !== (value.snapshotHash !== null) || calibrated !== (value.scope !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'A calibrated result names its snapshot and scope; an uncalibrated one names neither',
      });
    }
    if (calibrated !== (value.cutoffAt !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cutoffAt'],
        message: 'A calibrated result records the cutoff it was calibrated against',
      });
    }
    if (!calibrated && value.appliedShortfallBps !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appliedShortfallBps'],
        message: 'An uncalibrated result applies no shortfall',
      });
    }
    if (BigInt(value.calibratedExpectedOutputAtomic) > BigInt(value.rawExpectedOutputAtomic)) {
      // Calibration only ever discounts. A history that made a quote look
      // BETTER than the provider offered would be a promise Miorail cannot keep.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calibratedExpectedOutputAtomic'],
        message: 'Calibration must never raise the expected output above the quote',
      });
    }
  });

export type CalibratedNetResultV1 = z.infer<typeof CalibratedNetResultV1Schema>;

export { ZERO_HASH_V1 };
