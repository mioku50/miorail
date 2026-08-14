import { z } from 'zod';
import {
  GasEstimateV1Schema,
  HashV1Schema,
  TimestampV1Schema,
  TransactionReceiptV1Schema,
  type RouteProofV1,
} from '@mioagent/route-domain';

// T58: user-safe read projection of a RouteProofV1 — deliberately excludes
// tenantId, the full approvedCalls array, and raw event payloads. This is
// what GET /route-proofs/:proofId and the reconcile response return to the
// client.

export const RouteProofProjectionV1Schema = z
  .object({
    proofId: z.string().min(1).max(200),
    blueprintId: z.string().min(1).max(200),
    blueprintHash: HashV1Schema,
    approvedCallsHash: HashV1Schema,
    intentHash: HashV1Schema,
    /** Not stored on RouteProofV1 itself; the API route may enrich this from
     * the matching candidate's provider. Null when not resolved. */
    provider: z.string().min(1).max(120).nullable(),
    expectedOutput: z
      .object({
        amountAtomic: z.string(),
        asset: z
          .object({
            symbol: z.string(),
            decimals: z.number().int(),
            address: z.string().nullable(),
            kind: z.enum(['native', 'erc20']),
          })
          .strict(),
      })
      .strict(),
    minimumOutput: z.string().nullable(),
    actualOutput: z.string().nullable(),
    /**
     * Why `actualOutput` is null, when the chain has already answered.
     *
     * Reconstruction reads ERC-20 Transfer logs and approved-router canonical
     * WETH9 wrap/unwrap events. A native route with no such bound event still
     * goes to `reconciliation_required` rather than guessing from a balance.
     *
     * DERIVED here, not stored: the proof already carries everything needed
     * (a null actual output, the final status, and the output asset's kind),
     * so no schema or proof hash changes.
     */
    actualOutputUnavailableReason: z.enum(['native_output_unverifiable', 'not_reconciled']).nullable(),
    outputDeviationBps: z.number().int().nullable(),
    minimumSatisfied: z.boolean().nullable(),
    estimatedGas: GasEstimateV1Schema,
    actualGas: GasEstimateV1Schema.nullable(),
    transactionHashes: z.array(HashV1Schema),
    receipts: z.array(TransactionReceiptV1Schema),
    finalStatus: z.enum(['pending', 'completed', 'partial_failure', 'failed', 'cancelled', 'reconciliation_required']),
    reconciliationState: z.enum(['pending', 'matched', 'deviated', 'partial', 'failed', 'manual_review']),
    createdAt: TimestampV1Schema,
    updatedAt: TimestampV1Schema,
  })
  .strict();
export type RouteProofProjectionV1 = z.infer<typeof RouteProofProjectionV1Schema>;

export function toRouteProofProjectionV1(
  proof: RouteProofV1,
  options: { blueprintId: string; provider?: string | null },
): RouteProofProjectionV1 {
  const outputChange = proof.expectedResult.assetChanges.find((change) => change.direction === 'credit') ?? null;
  const outputAsset = proof.expectedResult.outputAsset ?? outputChange?.asset ?? null;
  const value: RouteProofProjectionV1 = {
    proofId: proof.id,
    blueprintId: options.blueprintId,
    blueprintHash: proof.blueprintHash,
    approvedCallsHash: proof.approvedCallsHash,
    intentHash: proof.intentHash,
    provider: options.provider ?? null,
    expectedOutput: {
      amountAtomic: proof.expectedResult.outputAmountAtomic ?? '0',
      asset: outputAsset
        ? {
            symbol: outputAsset.symbol,
            decimals: outputAsset.decimals,
            address: outputAsset.address,
            kind: outputAsset.kind,
          }
        : { symbol: '', decimals: 0, address: null, kind: 'native' },
    },
    minimumOutput: outputChange?.minimumAmountAtomic ?? null,
    actualOutput: proof.actualResult?.outputAmountAtomic ?? null,
    actualOutputUnavailableReason:
      proof.actualResult?.outputAmountAtomic
        ? null
        : outputAsset?.kind === 'native'
          ? 'native_output_unverifiable'
          : 'not_reconciled',
    outputDeviationBps: proof.deviation.outputBps,
    minimumSatisfied: proof.deviation.withinTolerance,
    estimatedGas: proof.estimatedGas,
    actualGas: proof.actualGas,
    transactionHashes: proof.transactionHashes,
    receipts: proof.receipts,
    finalStatus: proof.finalStatus,
    reconciliationState: proof.reconciliationState,
    createdAt: proof.createdAt,
    updatedAt: proof.updatedAt,
  };
  return RouteProofProjectionV1Schema.parse(value);
}

export const RouteProofEventSummaryV1Schema = z
  .object({
    eventIndex: z.number().int().nonnegative(),
    eventType: z.string().min(1).max(60),
    createdAt: TimestampV1Schema,
  })
  .strict();
export type RouteProofEventSummaryV1 = z.infer<typeof RouteProofEventSummaryV1Schema>;

/** User-safe event history summary: no payloads, no hashes — just enough to
 * show a timeline. */
export function summarizeRouteProofEventsV1(
  events: readonly { eventIndex: number; eventType: string; createdAt: string }[],
): RouteProofEventSummaryV1[] {
  return events
    .map((event) => ({ eventIndex: event.eventIndex, eventType: event.eventType, createdAt: event.createdAt }))
    .map((event) => RouteProofEventSummaryV1Schema.parse(event));
}

export const RouteProofReconciliationResultV1Schema = z
  .object({
    outcome: z.enum(['pending', 'completed', 'partial_failure', 'failed', 'reconciliation_required', 'already_finalized']),
    proof: RouteProofProjectionV1Schema,
    lifecycle: z.enum([
      'draft',
      'ready_for_review',
      'expired',
      'invalid',
      'approved',
      'submitted',
      'submitted_unknown',
      'confirmed',
      'failed',
      'cancelled',
      'completed',
      'partial_failure',
      'reconciliation_required',
    ]),
  })
  .strict();
export type RouteProofReconciliationResultV1 = z.infer<typeof RouteProofReconciliationResultV1Schema>;
