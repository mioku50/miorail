import type { HashV1, IntelligenceChargeV1 } from '@mioagent/route-domain';

export interface ResolvePaidSimulationIdempotencyInputV1 {
  /** Every stored charge for this Route Run (already tenant-scoped by the
   * caller's repository.listIntelligenceCharges call). */
  existingCharges: readonly IntelligenceChargeV1[];
  /** blueprint.selectedCandidateHash — the closest available linkage from a
   * charge back to "this blueprint" (IntelligenceChargeV1 has no
   * blueprintId field, and none may be added without a DB migration). */
  candidateHash: HashV1;
  idempotencyKey: string;
}

export type PaidSimulationIdempotencyDecisionV1 =
  /** serviceState 'delivered' AND a non-null evidenceHash — the paid result
   * is durably persisted: return it cached, no x402 challenge, no second
   * provider call, no second charge. */
  | { kind: 'cached'; charge: IntelligenceChargeV1 }
  /** paymentState already 'settled' but the paid result is NOT durably
   * persisted — serviceState pending/failed/invalid, OR 'delivered' with a
   * null evidenceHash (the evidence_persist_failed state, T59 rework B1:
   * before this fix that state was misclassified as 'cached' and the
   * deterministic client idempotencyKey turned it into a permanent 500).
   * Skip the x402 challenge and re-run the paid service — honest, because
   * the payment already settled; the user is never charged twice. */
  | { kind: 'retry_service'; charge: IntelligenceChargeV1 }
  /** No charge (or a payment_failed one) is bound to this idempotencyKey —
   * proceed through the x402 challenge. `existingFailedCharge` is non-null
   * only when a same-key charge already exists and must be UPDATEd back to
   * payment_pending rather than re-inserted. */
  | { kind: 'pay'; existingFailedCharge: IntelligenceChargeV1 | null }
  /** A DIFFERENT idempotencyKey already has an active charge
   * (payment_pending, or settled-but-not-durably-delivered) bound to the
   * same blueprint — reject rather than risk a second concurrent payment. */
  | { kind: 'conflict' };

/** "Durably delivered" = the ONLY state that may serve a cached replay. */
function isDurablyDelivered(charge: IntelligenceChargeV1): boolean {
  return charge.serviceState === 'delivered' && charge.evidenceHash !== null;
}

function isActiveCharge(charge: IntelligenceChargeV1): boolean {
  return (
    charge.status === 'payment_pending' ||
    (charge.paymentState === 'settled' && !isDurablyDelivered(charge))
  );
}

/**
 * T59 decision 3 (step 2) / decision 6 — pure decision function run BEFORE
 * the x402 middleware in the Express chain, so it never has side effects of
 * its own; the caller (api-server route) is responsible for actually
 * inserting/updating the charge and for skipping/running the payment
 * middleware based on `kind`.
 */
export function resolvePaidSimulationIdempotencyV1(
  input: ResolvePaidSimulationIdempotencyInputV1,
): PaidSimulationIdempotencyDecisionV1 {
  // M1 can legitimately produce SEVERAL rows sharing one idempotencyKey (the
  // winner's charge + duplicate-settlement ledger rows), so resolution works
  // over the full same-key set with an explicit preference order: a durably
  // delivered result always wins (serves the cache), then any settled row
  // (service retry without a new payment), then the failed/pending row.
  const sameKeyMatches = input.existingCharges.filter(
    (charge) => charge.idempotencyKey === input.idempotencyKey && charge.candidateHash === input.candidateHash,
  );
  if (sameKeyMatches.length > 0) {
    const delivered = sameKeyMatches.find(isDurablyDelivered);
    if (delivered) return { kind: 'cached', charge: delivered };
    const settled = sameKeyMatches.find((charge) => charge.paymentState === 'settled');
    if (settled) return { kind: 'retry_service', charge: settled };
    return { kind: 'pay', existingFailedCharge: sameKeyMatches[0]! };
  }

  const conflicting = input.existingCharges.find(
    (charge) =>
      charge.candidateHash === input.candidateHash &&
      charge.idempotencyKey !== input.idempotencyKey &&
      isActiveCharge(charge),
  );
  if (conflicting) return { kind: 'conflict' };

  return { kind: 'pay', existingFailedCharge: null };
}
