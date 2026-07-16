import { z } from 'zod';
import { canonicalJsonValueV1, financialContentV1, stableHashV1, type HashV1 } from './hashing.js';
import {
  AddressV1Schema,
  AssetRefV1Schema,
  AtomicAmountV1Schema,
  GasEstimateV1Schema,
  HashV1Schema,
  HexDataV1Schema,
  JsonObjectV1Schema,
  MoneyV1Schema,
  ProviderRefV1Schema,
  SignedDecimalV1Schema,
  TimestampV1Schema,
  financialEntityFieldsV1,
  validateFinancialChronologyV1,
} from './primitives.js';
import { EvidenceTypeV1Schema } from './route-contracts.js';

function addHashIssue(ctx: z.RefinementCtx, path: string, label: string): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message: `${label} does not match the canonical V1 financial payload`,
  });
}

export const ExecutionCallV1Schema = z
  .object({
    index: z.number().int().nonnegative(),
    callType: z.enum(['approval', 'swap', 'deposit', 'withdraw', 'transfer', 'other']),
    to: AddressV1Schema,
    valueWei: AtomicAmountV1Schema,
    data: HexDataV1Schema,
    asset: AssetRefV1Schema.nullable(),
    amountAtomic: AtomicAmountV1Schema.nullable(),
    recipient: AddressV1Schema.nullable(),
    spender: AddressV1Schema.nullable(),
  })
  .strict();
export type ExecutionCallV1 = z.infer<typeof ExecutionCallV1Schema>;

export function hashApprovedCallsV1(calls: readonly ExecutionCallV1[]): HashV1 {
  return stableHashV1('approved-calls/v1', calls);
}

export const ExpectedAssetChangeV1Schema = z
  .object({
    asset: AssetRefV1Schema,
    direction: z.enum(['debit', 'credit']),
    amountAtomic: AtomicAmountV1Schema,
    minimumAmountAtomic: AtomicAmountV1Schema.nullable(),
    maximumAmountAtomic: AtomicAmountV1Schema.nullable(),
  })
  .strict();
export type ExpectedAssetChangeV1 = z.infer<typeof ExpectedAssetChangeV1Schema>;

export const RequiredApprovalV1Schema = z
  .object({
    asset: AssetRefV1Schema,
    spender: AddressV1Schema,
    amountAtomic: AtomicAmountV1Schema,
    approvalKind: z.enum(['exact', 'permit', 'existing_allowance']),
    state: z.enum(['required', 'satisfied', 'not_required']),
  })
  .strict();
export type RequiredApprovalV1 = z.infer<typeof RequiredApprovalV1Schema>;

export const SimulationStateV1Schema = z
  .object({
    status: z.enum(['not_requested', 'pending', 'passed', 'failed', 'unavailable']),
    observedAt: TimestampV1Schema.nullable(),
    blockNumber: AtomicAmountV1Schema.nullable(),
    requestHash: HashV1Schema.nullable(),
    responseHash: HashV1Schema.nullable(),
    errorCode: z.string().min(1).max(120).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === 'passed' &&
      (!value.observedAt || !value.blockNumber || !value.requestHash || !value.responseHash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Passed simulation requires timestamp, block, request hash, and response hash',
      });
    }
  });
export type SimulationStateV1 = z.infer<typeof SimulationStateV1Schema>;

const ExecutionBlueprintV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'execution-blueprint/v1',
      z.enum(['draft', 'ready_for_review', 'approved', 'expired', 'invalid']),
    ),
    intentHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    blueprintHash: HashV1Schema,
    callsHash: HashV1Schema,
    approvedCallsHash: HashV1Schema.nullable(),
    quoteExpiry: TimestampV1Schema,
    calls: z.array(ExecutionCallV1Schema).min(1).max(100),
    expectedAssetChanges: z.array(ExpectedAssetChangeV1Schema).min(1),
    requiredApprovals: z.array(RequiredApprovalV1Schema),
    simulationState: SimulationStateV1Schema,
    atomicRequired: z.boolean(),
  })
  .strict();

export type ExecutionBlueprintV1 = z.infer<typeof ExecutionBlueprintV1ObjectSchema>;

export function hashExecutionBlueprintV1(value: ExecutionBlueprintV1): HashV1 {
  return stableHashV1(
    'execution-blueprint/v1',
    financialContentV1(value, ['blueprintHash', 'approvedCallsHash', 'calls']),
  );
}

export const ExecutionBlueprintV1Schema = ExecutionBlueprintV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.blueprintHash !== hashExecutionBlueprintV1(value)) {
      addHashIssue(ctx, 'blueprintHash', 'blueprintHash');
    }
    const expectedCallsHash = hashApprovedCallsV1(value.calls);
    if (value.callsHash !== expectedCallsHash) addHashIssue(ctx, 'callsHash', 'callsHash');
    if (value.approvedCallsHash !== null && value.approvedCallsHash !== expectedCallsHash) {
      addHashIssue(ctx, 'approvedCallsHash', 'approvedCallsHash');
    }
    if (value.status === 'approved' && value.approvedCallsHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedCallsHash'],
        message: 'Approved Blueprint requires approvedCallsHash',
      });
    }
    value.calls.forEach((call, index) => {
      if (call.index !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['calls', index, 'index'],
          message: 'Execution call indexes must be contiguous and ordered',
        });
      }
      if (call.asset && call.asset.chainId !== value.chainId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['calls', index, 'asset', 'chainId'],
          message: 'Execution call asset must match Blueprint chain',
        });
      }
    });
    value.expectedAssetChanges.forEach((change, index) => {
      if (change.asset.chainId !== value.chainId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedAssetChanges', index, 'asset', 'chainId'],
          message: 'Expected asset change must match Blueprint chain',
        });
      }
    });
    if (Date.parse(value.quoteExpiry) <= Date.parse(value.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quoteExpiry'],
        message: 'Blueprint quote expiry must be later than its creation time',
      });
    }
  },
);

export const SafetyKernelCheckV1Schema = z
  .object({
    id: z.string().min(1).max(120),
    description: z.string().min(1).max(300),
    status: z.enum(['passed', 'failed', 'skipped']),
    detail: z.string().min(1).max(500).nullable(),
  })
  .strict();
export type SafetyKernelCheckV1 = z.infer<typeof SafetyKernelCheckV1Schema>;

export const SafetyKernelResultV1Schema = z
  .object({
    schemaVersion: z.literal('safety-kernel-result/v1'),
    verdict: z.enum(['allowed', 'blocked']),
    checks: z.array(SafetyKernelCheckV1Schema).min(1),
    blockedReason: z.string().min(1).max(500).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === 'blocked' && value.blockedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedReason'],
        message: 'A blocked Safety Kernel result requires blockedReason',
      });
    }
    if (value.verdict === 'allowed' && value.blockedReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockedReason'],
        message: 'An allowed Safety Kernel result must not carry a blockedReason',
      });
    }
    if (value.verdict === 'allowed' && value.checks.some((check) => check.status === 'failed')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict'],
        message: 'An allowed Safety Kernel result cannot contain a failed check',
      });
    }
  });
export type SafetyKernelResultV1 = z.infer<typeof SafetyKernelResultV1Schema>;

export const ExecutionResultV1Schema = z
  .object({
    assetChanges: z.array(ExpectedAssetChangeV1Schema),
    outputAmountAtomic: AtomicAmountV1Schema.nullable(),
    outputAsset: AssetRefV1Schema.nullable(),
  })
  .strict();

export const RouteProofDeviationV1Schema = z
  .object({
    outputBps: z.number().int().nullable(),
    gasCostUsd: SignedDecimalV1Schema.nullable(),
    withinTolerance: z.boolean().nullable(),
  })
  .strict();

export const TransactionReceiptV1Schema = z
  .object({
    transactionHash: HashV1Schema,
    status: z.enum(['success', 'reverted', 'unknown']),
    blockNumber: AtomicAmountV1Schema.nullable(),
    gasUsed: AtomicAmountV1Schema.nullable(),
  })
  .strict();

const ROUTE_PROOF_FINAL_STATUSES_V1 = [
  'pending',
  'completed',
  'partial_failure',
  'failed',
  'cancelled',
  'reconciliation_required',
] as const;

const RouteProofV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('route-proof/v1', z.enum(ROUTE_PROOF_FINAL_STATUSES_V1)),
    intentHash: HashV1Schema,
    selectedCandidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    proofHash: HashV1Schema,
    approvedCalls: z.array(ExecutionCallV1Schema).min(1),
    expectedResult: ExecutionResultV1Schema,
    actualResult: ExecutionResultV1Schema.nullable(),
    estimatedGas: GasEstimateV1Schema,
    actualGas: GasEstimateV1Schema.nullable(),
    deviation: RouteProofDeviationV1Schema,
    transactionHashes: z.array(HashV1Schema),
    receipts: z.array(TransactionReceiptV1Schema),
    finalStatus: z.enum(ROUTE_PROOF_FINAL_STATUSES_V1),
    reconciliationState: z.enum([
      'pending',
      'matched',
      'deviated',
      'partial',
      'failed',
      'manual_review',
    ]),
  })
  .strict();

export type RouteProofV1 = z.infer<typeof RouteProofV1ObjectSchema>;

export function hashRouteProofV1(value: RouteProofV1): HashV1 {
  return stableHashV1('route-proof/v1', financialContentV1(value, ['proofHash', 'approvedCalls']));
}

export const RouteProofV1Schema = RouteProofV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.proofHash !== hashRouteProofV1(value)) addHashIssue(ctx, 'proofHash', 'proofHash');
  if (value.approvedCallsHash !== hashApprovedCallsV1(value.approvedCalls)) {
    addHashIssue(ctx, 'approvedCallsHash', 'approvedCallsHash');
  }
  if (value.status !== value.finalStatus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['finalStatus'],
      message: 'finalStatus must equal Route Proof status',
    });
  }
  if (
    (value.finalStatus === 'completed' || value.finalStatus === 'partial_failure') &&
    (!value.actualResult || value.transactionHashes.length === 0 || value.receipts.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actualResult'],
      message: 'Settled Route Proof requires actual result, transaction hash, and receipt',
    });
  }
  const receiptHashes = new Set(value.receipts.map((receipt) => receipt.transactionHash));
  if (receiptHashes.size !== value.receipts.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receipts'],
      message: 'Route Proof receipts must have unique transaction hashes',
    });
  }
  for (const [index, transactionHash] of value.transactionHashes.entries()) {
    if (!receiptHashes.has(transactionHash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transactionHashes', index],
        message: 'Every transaction hash must have a receipt',
      });
    }
  }
  if (
    value.finalStatus === 'completed' &&
    value.receipts.some((receipt) => receipt.status !== 'success')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receipts'],
      message: 'Completed Route Proof requires successful receipts',
    });
  }
  if (value.finalStatus === 'partial_failure') {
    const hasSuccess = value.receipts.some((receipt) => receipt.status === 'success');
    const hasFailure = value.receipts.some((receipt) => receipt.status !== 'success');
    if (!hasSuccess || !hasFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receipts'],
        message: 'Partial-failure Route Proof requires both successful and unsuccessful receipts',
      });
    }
  }
});

const RouteProofEventV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1('route-proof-event/v1', z.literal('recorded')),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema,
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    routeProofId: z.string().min(1).max(200),
    eventIndex: z.number().int().nonnegative(),
    eventType: z.enum([
      'blueprint_created',
      'calls_approved',
      'submitted',
      'receipt_observed',
      'completed',
      'partial_failure',
      'reconciliation_updated',
    ]),
    previousEventHash: HashV1Schema.nullable(),
    payload: JsonObjectV1Schema,
    payloadHash: HashV1Schema,
    eventHash: HashV1Schema,
  })
  .strict();

export type RouteProofEventV1 = z.infer<typeof RouteProofEventV1ObjectSchema>;

export function hashRouteProofEventPayloadV1(value: RouteProofEventV1['payload']): HashV1 {
  return stableHashV1('route-proof-event-payload/v1', canonicalJsonValueV1(value));
}

export function hashRouteProofEventV1(value: RouteProofEventV1): HashV1 {
  return stableHashV1('route-proof-event/v1', financialContentV1(value, ['eventHash', 'payload']));
}

export const RouteProofEventV1Schema = RouteProofEventV1ObjectSchema.superRefine((value, ctx) => {
  validateFinancialChronologyV1(value, ctx);
  if (value.payloadHash !== hashRouteProofEventPayloadV1(value.payload)) {
    addHashIssue(ctx, 'payloadHash', 'payloadHash');
  }
  if (value.eventHash !== hashRouteProofEventV1(value)) addHashIssue(ctx, 'eventHash', 'eventHash');
  if (value.eventIndex === 0 && value.previousEventHash !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousEventHash'],
      message: 'First Route Proof event must not have previousEventHash',
    });
  }
  if (value.eventIndex > 0 && value.previousEventHash === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousEventHash'],
      message: 'Append-only Route Proof event requires previousEventHash',
    });
  }
});

export const IntelligenceCategoryV1Schema = z.enum([
  'route_quote',
  'liquidity',
  'risk',
  'simulation',
  'inference',
]);

const IntelligenceChargeV1ObjectSchema = z
  .object({
    ...financialEntityFieldsV1(
      'intelligence-charge/v1',
      z.enum([
        'quoted',
        'reserved',
        'payment_pending',
        'settled',
        'failed',
        'reconciliation_required',
        'released',
      ]),
    ),
    intentHash: HashV1Schema,
    candidateHash: HashV1Schema,
    evidenceSetHash: HashV1Schema.nullable(),
    evidenceHash: HashV1Schema.nullable(),
    chargeHash: HashV1Schema,
    provider: ProviderRefV1Schema,
    service: z.string().min(1).max(200),
    category: IntelligenceCategoryV1Schema,
    evidenceType: EvidenceTypeV1Schema,
    fundingMode: z.enum(['one_time', 'spend_permission']),
    spendPermissionId: z.string().min(1).max(300).nullable(),
    intelligenceBudgetId: z.string().min(1).max(200).nullable(),
    reservationId: z.string().min(1).max(200).nullable(),
    quotedCost: MoneyV1Schema,
    maxAuthorizedCost: MoneyV1Schema,
    chargedCost: MoneyV1Schema.nullable(),
    paymentState: z.enum(['not_started', 'reserved', 'pending', 'settled', 'failed']),
    serviceState: z.enum(['not_started', 'pending', 'delivered', 'invalid', 'failed']),
    x402ReceiptHash: HashV1Schema.nullable(),
    serviceResponseHash: HashV1Schema.nullable(),
    idempotencyKey: z.string().min(1).max(300),
  })
  .strict();

export type IntelligenceChargeV1 = z.infer<typeof IntelligenceChargeV1ObjectSchema>;

export function hashIntelligenceChargeV1(value: IntelligenceChargeV1): HashV1 {
  return stableHashV1('intelligence-charge/v1', financialContentV1(value, ['chargeHash']));
}

export const IntelligenceChargeV1Schema = IntelligenceChargeV1ObjectSchema.superRefine(
  (value, ctx) => {
    validateFinancialChronologyV1(value, ctx);
    if (value.chargeHash !== hashIntelligenceChargeV1(value))
      addHashIssue(ctx, 'chargeHash', 'chargeHash');
    const costs = [value.quotedCost, value.maxAuthorizedCost, value.chargedCost].filter(
      (cost): cost is NonNullable<typeof cost> => cost !== null,
    );
    costs.forEach((cost, index) => {
      if (
        cost.asset.chainId !== value.chainId ||
        cost.asset.assetId !== value.quotedCost.asset.assetId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['chargedCost', index],
          message: 'All charge costs must use the same asset and chain',
        });
      }
    });
    if (BigInt(value.quotedCost.amountAtomic) > BigInt(value.maxAuthorizedCost.amountAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quotedCost'],
        message: 'Quoted cost must not exceed maximum authorized cost',
      });
    }
    if (
      value.chargedCost &&
      BigInt(value.chargedCost.amountAtomic) > BigInt(value.maxAuthorizedCost.amountAtomic)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chargedCost'],
        message: 'Charged cost must not exceed maximum authorized cost',
      });
    }
    if (
      value.fundingMode === 'spend_permission' &&
      (!value.spendPermissionId || !value.intelligenceBudgetId || !value.reservationId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spendPermissionId'],
        message: 'Spend Permission funding requires permission, budget, and reservation IDs',
      });
    }
    if (
      value.status === 'settled' &&
      (!value.chargedCost ||
        value.paymentState !== 'settled' ||
        value.serviceState !== 'delivered' ||
        !value.x402ReceiptHash ||
        !value.serviceResponseHash ||
        !value.evidenceHash)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message:
          'Settled intelligence charge requires payment proof and delivered service evidence',
      });
    }
  },
);
