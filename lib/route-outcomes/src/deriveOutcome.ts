import {
  ZERO_HASH_V1,
  stableHashV1,
  type RouteCandidateV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import {
  OUTCOME_CHAIN_ID_V1,
  OUTCOME_ELIGIBLE_PROOF_STATUSES_V1,
  OutcomeProviderIdV1Schema,
  ROUTE_OUTCOME_DERIVATION_VERSION_V1,
  RouteProviderOutcomeV1Schema,
  adverseShortfallBpsV1,
  hashRouteProviderOutcomeV1,
  quoteDeviationBpsV1,
  type OutcomeProofFinalStatusV1,
  type ReceiptVerificationV1,
  type RouteProviderOutcomeV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67C.1 §3 — one finalized Route Proof in, at most one provider outcome out.
//
// Pure: no repository, no clock, no chain reader. Everything it needs is
// already a verified fact recorded by the reconciler, which is the only reason
// a backfill can reproduce a projector's row byte for byte.
//
// The interesting decisions here are all about REFUSING to derive. A statistic
// that quietly absorbs states it does not understand is worse than no statistic,
// because it looks like evidence.
// ---------------------------------------------------------------------------

export const OUTCOME_SKIP_REASONS_V1 = [
  'proof_not_terminal',
  'cancelled_by_user',
  'receipts_not_verified',
  'unsupported_provider',
  'candidate_mismatch',
  'not_a_swap',
  'unsupported_chain',
  'missing_delivered_amount',
  'non_positive_expected_output',
] as const;

export type OutcomeSkipReasonV1 = (typeof OUTCOME_SKIP_REASONS_V1)[number];

export type DeriveOutcomeResultV1 =
  | { derived: true; outcome: RouteProviderOutcomeV1 }
  | { derived: false; reason: OutcomeSkipReasonV1 };

export interface DeriveOutcomeInputV1 {
  proof: RouteProofV1;
  /** The PERSISTED candidate the proof was built from. The provider is read
   * from here rather than from anything the client sent — a client that could
   * name the provider could choose which provider its outcome landed on. */
  candidate: RouteCandidateV1;
  events: readonly RouteProofEventV1[];
  derivedAt: Date;
}

/** Stable across projector and backfill: the same proof always yields this id. */
export function routeProviderOutcomeIdV1(proofId: string): string {
  return `route-provider-outcome:${stableHashV1('route-provider-outcome-id/v1', { proofId }).slice(2)}`;
}

/**
 * Milliseconds from the first `submitted` event to the terminal event.
 *
 * Null when either end is missing. A confirmation time measured from an
 * assumed start would be a number nobody observed, and it feeds a p90 that
 * ranks routes.
 */
export function confirmationMsV1(
  events: readonly RouteProofEventV1[],
  finalStatus: OutcomeProofFinalStatusV1,
): number | null {
  const submitted = events.find((event) => event.eventType === 'submitted');
  const terminal = [...events].reverse().find((event) => event.eventType === finalStatus);
  if (!submitted || !terminal) return null;
  const elapsed = Date.parse(terminal.createdAt) - Date.parse(submitted.createdAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/**
 * What the receipts actually showed.
 *
 * Returns null when they show something this contract has no honest word for —
 * an `unknown` receipt, or a "completed" proof whose receipts do not all say
 * success. Rather than picking the nearest label, the outcome is skipped: the
 * reconciler is the only component allowed to decide what a receipt means, and
 * disagreeing with it here would create a second, quieter source of truth.
 */
export function receiptVerificationV1(
  proof: RouteProofV1,
  finalStatus: OutcomeProofFinalStatusV1,
): ReceiptVerificationV1 | null {
  if (proof.receipts.length === 0) return null;
  if (proof.receipts.some((receipt) => receipt.status === 'unknown')) return null;
  const successes = proof.receipts.filter((receipt) => receipt.status === 'success').length;
  const allSuccess = successes === proof.receipts.length;
  const noneSuccess = successes === 0;
  if (finalStatus === 'completed') return allSuccess ? 'verified_success' : null;
  if (finalStatus === 'failed') return noneSuccess ? 'verified_reverted' : null;
  return !allSuccess && !noneSuccess ? 'verified_mixed' : null;
}

export function deriveRouteProviderOutcomeV1(input: DeriveOutcomeInputV1): DeriveOutcomeResultV1 {
  const { proof, candidate, events } = input;

  // `cancelled` is named separately from the other non-terminal states so the
  // caller can log it as "nothing to record" rather than "could not record".
  // A user who changed their mind reported nothing about the provider.
  if (proof.finalStatus === 'cancelled') return { derived: false, reason: 'cancelled_by_user' };
  if (!(OUTCOME_ELIGIBLE_PROOF_STATUSES_V1 as readonly string[]).includes(proof.finalStatus)) {
    return { derived: false, reason: 'proof_not_terminal' };
  }
  const finalStatus = proof.finalStatus as OutcomeProofFinalStatusV1;

  if (proof.chainId !== OUTCOME_CHAIN_ID_V1 || candidate.chainId !== OUTCOME_CHAIN_ID_V1) {
    return { derived: false, reason: 'unsupported_chain' };
  }
  if (candidate.routeType !== 'swap') return { derived: false, reason: 'not_a_swap' };
  if (
    candidate.candidateHash !== proof.selectedCandidateHash ||
    candidate.tenantId !== proof.tenantId ||
    candidate.walletAddress !== proof.walletAddress
  ) {
    return { derived: false, reason: 'candidate_mismatch' };
  }

  // An aggregator executing through someone else's pool is ONE outcome, under
  // the aggregator's own id. The venue is provenance, not a second execution:
  // a Kyber route that filled on a Uniswap pool tells us how Kyber routes, and
  // crediting Uniswap for it would count one trade twice and attribute a result
  // to a provider that was never asked.
  const provider = OutcomeProviderIdV1Schema.safeParse(candidate.provider.id.toLowerCase());
  if (!provider.success) return { derived: false, reason: 'unsupported_provider' };

  const expected = BigInt(candidate.expectedOutput.amountAtomic);
  if (expected <= 0n) return { derived: false, reason: 'non_positive_expected_output' };

  const verification = receiptVerificationV1(proof, finalStatus);
  if (!verification) return { derived: false, reason: 'receipts_not_verified' };

  const actualRaw = finalStatus === 'failed' ? null : (proof.actualResult?.outputAmountAtomic ?? null);
  if (finalStatus !== 'failed' && actualRaw === null) {
    // The proof says value moved but the reconciler could not reconstruct how
    // much. There is no number to record and no defensible way to invent one.
    return { derived: false, reason: 'missing_delivered_amount' };
  }
  const actual = actualRaw === null ? null : BigInt(actualRaw);

  const draft: RouteProviderOutcomeV1 = {
    schemaVersion: 'route-provider-outcome/v1',
    id: routeProviderOutcomeIdV1(proof.id),
    tenantId: proof.tenantId,
    walletAddress: proof.walletAddress,
    chainId: OUTCOME_CHAIN_ID_V1,
    status: 'derived',
    outcomeHash: ZERO_HASH_V1,
    proofId: proof.id,
    proofHash: proof.proofHash,
    providerId: provider.data,
    fromAsset: candidate.inputAmount.asset.assetId,
    toAsset: candidate.expectedOutput.asset.assetId,
    expectedOutputAtomic: expected.toString(),
    minimumOutputAtomic: candidate.minimumOutput.amountAtomic,
    actualOutputAtomic: actual === null ? null : actual.toString(),
    estimatedGasAtomic: proof.estimatedGas.gasUnits,
    actualGasAtomic: proof.actualGas?.gasUnits ?? null,
    quoteDeviationBps: actual === null ? null : quoteDeviationBpsV1(expected, actual),
    adverseShortfallBps: actual === null ? null : adverseShortfallBpsV1(expected, actual),
    floorBreached: actual === null ? null : actual < BigInt(candidate.minimumOutput.amountAtomic),
    confirmationMs: confirmationMsV1(events, finalStatus),
    proofFinalStatus: finalStatus,
    receiptVerification: verification,
    // The proof's own last update is when the outcome HAPPENED. `derivedAt` is
    // when this row was written, and the two differ by however long a backfill
    // took to notice — which is exactly why only one of them is in the hash.
    occurredAt: proof.updatedAt,
    derivedAt: input.derivedAt.toISOString(),
    derivationVersion: ROUTE_OUTCOME_DERIVATION_VERSION_V1,
  };

  return {
    derived: true,
    outcome: RouteProviderOutcomeV1Schema.parse({
      ...draft,
      outcomeHash: hashRouteProviderOutcomeV1(draft),
    }),
  };
}
