import {
  AddressV1Schema,
  AtomicAmountV1Schema,
  ExecutionCallV1Schema,
  HashV1Schema,
  ProviderRefV1Schema,
  RequiredApprovalV1Schema,
  SafetyKernelResultV1Schema,
  SimulationStateV1Schema,
  TimestampV1Schema,
  TokenAmountV1Schema,
  stableHashV1,
  type HashV1,
} from '@mioagent/route-domain';
import { z } from 'zod';

// T56: read-only projection of a prepared ExecutionBlueprintV1 for the
// "Unsigned transaction review" panel. Follows the RoutePlanProjectionV1
// idiom (contracts.ts): readOnly literal, projectionHash excludes itself,
// superRefine cross-checks. Built only for the `prepared` transaction
// preparation outcome — never for blocked/unsupported/refresh_required,
// which do not carry a full call-by-call review.

export const ContractSecurityVerdictV1Schema = z
  .object({
    address: AddressV1Schema,
    provider: z.string().min(1).max(60),
    status: z.enum(['ok', 'warning', 'high-risk', 'unknown', 'failed']),
    summary: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type ContractSecurityVerdictV1 = z.infer<typeof ContractSecurityVerdictV1Schema>;

export const ContractSecuritySummaryV1Schema = z
  .object({
    provider: z.string().min(1).max(60),
    required: z.boolean(),
    status: z.enum(['passed', 'warning', 'blocked', 'skipped']),
    verdicts: z.array(ContractSecurityVerdictV1Schema),
  })
  .strict();
export type ContractSecuritySummaryV1 = z.infer<typeof ContractSecuritySummaryV1Schema>;

const TransactionReviewProjectionV1ObjectSchema = z
  .object({
    schemaVersion: z.literal('transaction-review-projection/v1'),
    projectionHash: HashV1Schema,
    readOnly: z.literal(true),
    routeRunId: z.string().min(1).max(200),
    intentHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    blueprintHash: HashV1Schema,
    callsHash: HashV1Schema,
    blueprintStatus: z.enum(['draft', 'ready_for_review', 'approved', 'expired', 'invalid']),
    provider: ProviderRefV1Schema,
    input: TokenAmountV1Schema,
    expectedOutput: TokenAmountV1Schema,
    minimumOutput: TokenAmountV1Schema,
    cardExpectedOutput: TokenAmountV1Schema,
    cardMinimumOutput: TokenAmountV1Schema,
    quoteExpiry: TimestampV1Schema,
    calls: z.array(ExecutionCallV1Schema).min(1).max(100),
    requiredApprovals: z.array(RequiredApprovalV1Schema),
    attachedNativeValueWei: AtomicAmountV1Schema,
    safety: SafetyKernelResultV1Schema,
    contractSecurity: ContractSecuritySummaryV1Schema,
    simulationState: SimulationStateV1Schema,
    simulationWarning: z.string().min(1).max(500).nullable(),
  })
  .strict();

export type TransactionReviewProjectionV1 = z.infer<typeof TransactionReviewProjectionV1ObjectSchema>;

export function hashTransactionReviewProjectionV1(value: TransactionReviewProjectionV1): HashV1 {
  const { projectionHash: _projectionHash, ...content } = value;
  return stableHashV1('transaction-review-projection/v1', content);
}

export const TransactionReviewProjectionV1Schema = TransactionReviewProjectionV1ObjectSchema.superRefine(
  (value, ctx) => {
    if (value.projectionHash !== hashTransactionReviewProjectionV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectionHash'],
        message: 'projectionHash does not match the canonical transaction-review-projection/v1 payload',
      });
    }
    if (value.expectedOutput.asset.assetId !== value.minimumOutput.asset.assetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimumOutput', 'asset'],
        message: 'minimumOutput asset must match expectedOutput asset',
      });
    }
    if (BigInt(value.minimumOutput.amountAtomic) > BigInt(value.expectedOutput.amountAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimumOutput', 'amountAtomic'],
        message: 'minimumOutput must not exceed expectedOutput',
      });
    }
    if (value.cardExpectedOutput.asset.assetId !== value.cardMinimumOutput.asset.assetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardMinimumOutput', 'asset'],
        message: 'cardMinimumOutput asset must match cardExpectedOutput asset',
      });
    }
    if (BigInt(value.cardMinimumOutput.amountAtomic) > BigInt(value.cardExpectedOutput.amountAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardMinimumOutput', 'amountAtomic'],
        message: 'cardMinimumOutput must not exceed cardExpectedOutput',
      });
    }
    value.calls.forEach((call, index) => {
      if (call.index !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['calls', index, 'index'],
          message: 'Review call indexes must be contiguous and ordered',
        });
      }
    });
    const attached = value.calls.reduce((sum, call) => sum + BigInt(call.valueWei), BigInt(0));
    if (attached.toString() !== value.attachedNativeValueWei) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachedNativeValueWei'],
        message: 'attachedNativeValueWei must equal the sum of call valueWei',
      });
    }
    if (value.safety.verdict === 'blocked') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['safety'],
        message: 'A reviewable transaction projection cannot carry a blocked Safety Kernel result',
      });
    }
  },
);
