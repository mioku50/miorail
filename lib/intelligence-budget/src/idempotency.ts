import type { IntelligenceChargeV1 } from '@mioagent/route-domain';

export interface ResolveBudgetSimulationIdempotencyInputV1 {
  /** Every stored charge for this Route Run (already tenant-scoped by the
   * caller's repository.listIntelligenceCharges call). */
  existingCharges: readonly IntelligenceChargeV1[];
  /** blueprint.selectedCandidateHash — the closest available linkage from a
   * charge back to "this blueprint" (mirrors T59's own idempotency.ts). */
  candidateHash: string;
  idempotencyKey: string;
}

export type BudgetSimulationIdempotencyDecisionV1 =
  /** No charge is bound to this idempotencyKey yet — proceed through
   * expireStaleIntelligenceReservations + reserveIntelligenceBudget (a brand
   * new reservation + a brand new 'reserved' charge). */
  | { kind: 'fresh' }
  /** status 'settled' AND a non-null evidenceHash — the ONLY state that is
   * "durably delivered": the service ran, evidence was persisted, and the
   * Spend Permission charge settled. Return it cached — no second provider
   * call, no second reservation, no second charge. */
  | { kind: 'cached'; charge: IntelligenceChargeV1 }
  /** status 'reserved' or 'payment_pending' — a charge was durably inserted
   * (so its reservation is guaranteed to still be 'reserved': nothing but
   * settle/release ever moves it, and neither has run yet) but the flow
   * crashed or was interrupted before reaching 'settled'. Re-drive steps
   * (6)-(8) against the SAME reservation — never allocate a new one (T59's
   * stuck-500 lesson: a deterministic client idempotencyKey must never trap
   * the caller in a dead end just because a prior attempt didn't finish). */
  | { kind: 'retry'; charge: IntelligenceChargeV1 }
  /** Either (a) the same idempotencyKey is bound to a DIFFERENT
   * candidateHash (a hash collision or a corrupted retry — fail closed
   * rather than ever reusing another candidate's reservation), or (b) the
   * matching charge is in a failed-permanent state — 'released' (provider
   * failure or evidence-persist failure already released the reservation;
   * a genuine new attempt needs a brand new idempotencyKey, not a replay of
   * this one) or 'reconciliation_required' (the charge failed AFTER
   * delivery — decision 5.8 forbids ever automatically re-attempting it).
   * Any other/unrecognized status is treated the same way: fail closed. */
  | { kind: 'conflict' };

/** The ONLY state a cached replay may be served from. */
function isDurablyDeliveredV1(charge: IntelligenceChargeV1): boolean {
  return charge.status === 'settled' && charge.evidenceHash !== null;
}

/** A charge whose reservation is guaranteed to still be 'reserved' (nothing
 * downstream of the initial insert has run yet) — safe to re-drive without
 * allocating a second reservation. */
function isRetryableV1(charge: IntelligenceChargeV1): boolean {
  return charge.status === 'reserved' || charge.status === 'payment_pending';
}

/**
 * T60 decision 8 — pure decision function the coordinator runs BEFORE
 * touching the reservation table or calling the provider/charger, so it
 * never has side effects of its own; `runBudgetSimulationV1` is responsible
 * for actually reserving/charging based on `kind`. Mirrors
 * `@mioagent/paid-intelligence`'s `resolvePaidSimulationIdempotencyV1`
 * (same T59 stuck-500 lesson: never misclassify a non-durably-delivered
 * charge as cached), adapted to the Budget flow's own state machine — where
 * (unlike T59's x402 challenge) a 'retry' never re-triggers a payment
 * challenge, it just re-drives the already-reserved simulation.
 */
export function resolveBudgetSimulationIdempotencyV1(
  input: ResolveBudgetSimulationIdempotencyInputV1,
): BudgetSimulationIdempotencyDecisionV1 {
  const match = input.existingCharges.find((charge) => charge.idempotencyKey === input.idempotencyKey);
  if (!match) return { kind: 'fresh' };

  if (match.candidateHash !== input.candidateHash) return { kind: 'conflict' };
  if (isDurablyDeliveredV1(match)) return { kind: 'cached', charge: match };
  if (isRetryableV1(match)) return { kind: 'retry', charge: match };
  return { kind: 'conflict' };
}
