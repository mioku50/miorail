import {
  IntelligenceChargeV1Schema,
  ZERO_HASH_V1,
  hashIntelligenceChargeV1,
  stableHashV1,
  type HashV1,
  type IntelligenceChargeV1,
  type MoneyV1,
  type ProviderRefV1,
} from '@mioagent/route-domain';

// T59 decision 5 — the task's conceptual state-machine names map onto the
// EXISTING (unmigrated) intelligence_charges CHECK constraint as a
// (status, paymentState, serviceState) triple. `hashIntelligenceChargeV1`
// covers every mutable state-machine field (paymentState/serviceState/
// chargedCost/x402ReceiptHash/serviceResponseHash/evidenceHash are all part
// of its content hash — only id/createdAt/updatedAt/status/chargeHash itself
// are excluded), so chargeHash is intentionally RECOMPUTED at every
// transition below (see the route-storage `updateIntelligenceCharge`
// deviation note for why the persisted charge_hash column must track it).
//
// One correction to the literal spec text: decision 5 writes the
// "payment_settled" milestone as `(status:'settled', paymentState:'settled',
// serviceState:'pending')`. That combination is REJECTED by
// IntelligenceChargeV1Schema's own superRefine, which requires
// serviceState==='delivered' (plus non-null chargedCost/x402ReceiptHash/
// serviceResponseHash/evidenceHash) whenever status==='settled' — a rule
// this task is not allowed to touch. The spec's own error-state list confirms
// paymentState:'settled' legitimately coexists with a NON-'settled' status
// (e.g. service_failed_after_payment is ('reconciliation_required','settled',
// 'failed')), so `status` here stays 'payment_pending' through every
// intermediate step and only reaches the terminal 'settled' value at
// evidence_persisted — exactly as decision 5's own last clause states
// ("evidence_persisted = финальный статус 'settled'"). This is a fail-closed
// correction, not a reinterpretation of the resolved decision.

function recomputeChargeHash(draft: Omit<IntelligenceChargeV1, 'chargeHash'>): IntelligenceChargeV1 {
  const withPlaceholder = { ...draft, chargeHash: ZERO_HASH_V1 } as IntelligenceChargeV1;
  return IntelligenceChargeV1Schema.parse({
    ...withPlaceholder,
    chargeHash: hashIntelligenceChargeV1(withPlaceholder),
  });
}

export interface BuildPendingSimulationChargeInputV1 {
  routeRunId: string;
  blueprintId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  intentHash: HashV1;
  candidateHash: HashV1;
  idempotencyKey: string;
  price: MoneyV1;
  provider: ProviderRefV1;
  now: string;
}

/** Deterministic charge id: the SAME (routeRunId, blueprintId, idempotencyKey)
 * always produces the SAME id, so a retried request that reaches the
 * idempotency short-circuit before any charge exists yet still lands on the
 * same row on a subsequent racing attempt. */
export function paidSimulationChargeIdV1(input: {
  routeRunId: string;
  blueprintId: string;
  idempotencyKey: string;
}): string {
  return `intelligence-charge:${stableHashV1('paid-intelligence-charge-id/v1', {
    routeRunId: input.routeRunId,
    blueprintId: input.blueprintId,
    idempotencyKey: input.idempotencyKey,
  }).slice(2)}`;
}

/** Step (2) of the guard chain (decision 3/5): created BEFORE the x402
 * challenge so a payment_failed outcome is always attributable to a durable
 * row — no money can be lost to an untracked charge. */
export function buildPendingSimulationChargeV1(input: BuildPendingSimulationChargeInputV1): IntelligenceChargeV1 {
  const draft: Omit<IntelligenceChargeV1, 'chargeHash'> = {
    schemaVersion: 'intelligence-charge/v1',
    id: paidSimulationChargeIdV1(input),
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'payment_pending',
    intentHash: input.intentHash,
    candidateHash: input.candidateHash,
    evidenceSetHash: null,
    evidenceHash: null,
    provider: input.provider,
    service: 'transaction-simulation',
    category: 'simulation',
    evidenceType: 'simulation',
    fundingMode: 'one_time',
    spendPermissionId: null,
    intelligenceBudgetId: null,
    reservationId: null,
    quotedCost: input.price,
    maxAuthorizedCost: input.price,
    chargedCost: null,
    paymentState: 'pending',
    serviceState: 'not_started',
    x402ReceiptHash: null,
    serviceResponseHash: null,
    idempotencyKey: input.idempotencyKey,
  };
  return recomputeChargeHash(draft);
}

/** x402 settlement reported failure (or was never obtained) — the request
 * never reaches the paid provider. */
export function chargeWithPaymentFailedV1(charge: IntelligenceChargeV1, now: string): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'failed',
    paymentState: 'failed',
    serviceState: 'not_started',
    updatedAt: now,
  });
}

/** x402 settlement succeeded. `status` deliberately stays 'payment_pending'
 * (see file header) — only paymentState/x402ReceiptHash advance here. */
export function chargeWithPaymentSettledV1(
  charge: IntelligenceChargeV1,
  input: { x402ReceiptHash: HashV1; now: string },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    paymentState: 'settled',
    serviceState: 'pending',
    x402ReceiptHash: input.x402ReceiptHash,
    updatedAt: input.now,
  });
}

/** Provider was unreachable / timed out / returned a transport-level error
 * after payment already settled. */
export function chargeWithServiceFailedAfterPaymentV1(
  charge: IntelligenceChargeV1,
  now: string,
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'reconciliation_required',
    serviceState: 'failed',
    updatedAt: now,
  });
}

/** Provider responded but the payload failed SimulationProviderResponseV1Schema
 * (or otherwise semantically invalid, e.g. blockNumber<=0). */
export function chargeWithInvalidResponseV1(charge: IntelligenceChargeV1, now: string): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'reconciliation_required',
    serviceState: 'invalid',
    updatedAt: now,
  });
}

/** Provider responded validly but the Evidence/Evidence Set could not be
 * durably persisted. evidenceHash is explicitly nulled — no dangling link to
 * evidence that was never actually stored. */
export function chargeWithEvidencePersistFailedV1(charge: IntelligenceChargeV1, now: string): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'reconciliation_required',
    serviceState: 'delivered',
    evidenceHash: null,
    updatedAt: now,
  });
}

/**
 * T59 rework M1 — a concurrent duplicate x402 settlement (two tabs racing
 * through the multi-step 402 flow) cannot be fully prevented, but NO receipt
 * may ever be lost from the ledger. When the stored charge already carries a
 * DIFFERENT x402ReceiptHash (the race winner's), the loser's settlement is
 * recorded as a brand-NEW charge row: same idempotencyKey, status
 * 'reconciliation_required', paymentState 'settled', serviceState 'failed',
 * the SECOND settlement's receipt hash, costs copied from the original. Its
 * chargeHash necessarily differs (different receipt hash), so the unique
 * (routeRunId, chargeHash) index admits it — the winner's row is never
 * overwritten.
 */
export function buildDuplicateSettlementChargeV1(
  original: IntelligenceChargeV1,
  input: { x402ReceiptHash: HashV1; now: string },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = original;
  return recomputeChargeHash({
    ...rest,
    id: `intelligence-charge:${stableHashV1('paid-intelligence-duplicate-settlement-id/v1', {
      originalChargeId: original.id,
      x402ReceiptHash: input.x402ReceiptHash,
    }).slice(2)}`,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'reconciliation_required',
    paymentState: 'settled',
    serviceState: 'failed',
    x402ReceiptHash: input.x402ReceiptHash,
    evidenceHash: null,
    evidenceSetHash: null,
    serviceResponseHash: null,
  });
}

/** Terminal success: the ONLY transition that reaches status 'settled'. */
export function chargeWithEvidencePersistedV1(
  charge: IntelligenceChargeV1,
  input: {
    chargedCost: MoneyV1;
    evidenceHash: HashV1;
    evidenceSetHash: HashV1;
    serviceResponseHash: HashV1;
    now: string;
  },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'settled',
    paymentState: 'settled',
    serviceState: 'delivered',
    chargedCost: input.chargedCost,
    evidenceHash: input.evidenceHash,
    evidenceSetHash: input.evidenceSetHash,
    serviceResponseHash: input.serviceResponseHash,
    updatedAt: input.now,
  });
}
