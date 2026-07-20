import {
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashIntelligenceChargeV1,
  stableHashV1,
  IntelligenceChargeV1Schema,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type IntelligenceChargeV1,
  type MoneyV1,
  type ProviderRefV1,
} from '@mioagent/route-domain';
import {
  buildSimulationEvidenceRecordV1,
  buildUpdatedEvidenceSetV1,
  SimulationProviderResponseV1Schema,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';
import type {
  IntelligenceBudgetRecord,
  IntelligenceBudgetReservationRecord,
  RouteStorageRepository,
} from '@mioagent/route-storage';
import { intelligenceBudgetV1FromRecord, hashIntelligenceBudgetV1, type IntelligenceBudgetV1 } from './budget-contracts.js';
import { checkSpendPermissionBindingV1, checkSpendPermissionV1, validateBudgetForSimulationV1 } from './validation.js';
import { resolveBudgetSimulationIdempotencyV1 } from './idempotency.js';
import type { SpendPermissionCharger, SpendPermissionSourceV1 } from './spendPermissionCharger.js';

/** Decision 4's env-configurable TTL (`MIORAIL_BUDGET_RESERVATION_TTL_SECONDS`,
 * default 900s) — this package never reads `process.env` itself; the caller
 * (api-server) resolves it and may override `deps.reservationTtlMs`. */
export const DEFAULT_INTELLIGENCE_BUDGET_RESERVATION_TTL_MS = 900_000;
const EVIDENCE_TTL_MS = 10 * 60_000;

export class BudgetSimulationBindingError extends Error {
  readonly code:
    | 'blueprint_not_found'
    | 'blueprint_not_reviewable'
    | 'blueprint_hash_mismatch'
    | 'blueprint_expired'
    | 'changed_calls';
  constructor(code: BudgetSimulationBindingError['code'], message: string) {
    super(message);
    this.name = 'BudgetSimulationBindingError';
    this.code = code;
  }
}

export interface RunBudgetSimulationDependenciesV1 {
  repository: RouteStorageRepository;
  provider: SimulationProvider;
  charger: SpendPermissionCharger;
  spendPermissionRepository: SpendPermissionSourceV1;
  now: () => Date;
  /** Resolved once per request from env — fixed USDC price for this
   * intelligence service (decision 4's SAME price the one-time T59 flow
   * uses). Never client-supplied. */
  price: MoneyV1;
  /** ProviderRefV1.id recorded on the charge and the resulting evidence. */
  providerId: string;
  /** Optional override of the default 900s reservation TTL (decision 4). */
  reservationTtlMs?: number;
}

export interface RunBudgetSimulationInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
  category: 'route_quote' | 'liquidity' | 'risk' | 'simulation' | 'inference';
  requestId: string;
}

export type RunBudgetSimulationResultV1 =
  | {
      outcome: 'charged';
      charge: IntelligenceChargeV1;
      evidence: EvidenceRecordV1;
      evidenceSet: EvidenceSetV1;
      budget: IntelligenceBudgetRecord;
      reservation: IntelligenceBudgetReservationRecord;
    }
  | {
      outcome: 'reconciliation_required';
      charge: IntelligenceChargeV1;
      budget: IntelligenceBudgetRecord;
      reason: string;
    }
  | { outcome: 'provider_failed'; charge: IntelligenceChargeV1; reason: string }
  | { outcome: 'limit_exceeded'; reason: string }
  | { outcome: 'blocked'; reason: string };

function simulationProviderRefV1(providerId: string): ProviderRefV1 {
  return { id: providerId, displayName: providerId, kind: 'simulation', operator: 'external' };
}

/** Mirrors paid-intelligence charges.ts's private `recomputeChargeHash` —
 * chargeHash covers every mutable state-machine field, so it is always
 * recomputed on every transition. */
function recomputeChargeHash(draft: Omit<IntelligenceChargeV1, 'chargeHash'>): IntelligenceChargeV1 {
  const withPlaceholder = { ...draft, chargeHash: ZERO_HASH_V1 } as IntelligenceChargeV1;
  return IntelligenceChargeV1Schema.parse({
    ...withPlaceholder,
    chargeHash: hashIntelligenceChargeV1(withPlaceholder),
  });
}

function budgetChargeIdV1(input: { routeRunId: string; blueprintId: string; idempotencyKey: string }): string {
  return `intelligence-budget-charge:${stableHashV1('intelligence-budget-charge-id/v1', input).slice(2)}`;
}

/** Step 5 (decision 5.5) — the pending charge inserted BEFORE the provider is
 * ever called: fundingMode 'spend_permission' with all three linkage IDs
 * filled (satisfies IntelligenceChargeV1Schema's own superRefine). */
function buildReservedIntelligenceChargeV1(input: {
  routeRunId: string;
  blueprintId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  intentHash: IntelligenceChargeV1['intentHash'];
  candidateHash: IntelligenceChargeV1['candidateHash'];
  spendPermissionId: string;
  intelligenceBudgetId: string;
  reservationId: string;
  idempotencyKey: string;
  price: MoneyV1;
  provider: ProviderRefV1;
  now: string;
}): IntelligenceChargeV1 {
  return recomputeChargeHash({
    schemaVersion: 'intelligence-charge/v1',
    id: budgetChargeIdV1(input),
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'reserved',
    intentHash: input.intentHash,
    candidateHash: input.candidateHash,
    evidenceSetHash: null,
    evidenceHash: null,
    provider: input.provider,
    service: 'transaction-simulation',
    category: 'simulation',
    evidenceType: 'simulation',
    fundingMode: 'spend_permission',
    spendPermissionId: input.spendPermissionId,
    intelligenceBudgetId: input.intelligenceBudgetId,
    reservationId: input.reservationId,
    quotedCost: input.price,
    maxAuthorizedCost: input.price,
    chargedCost: null,
    paymentState: 'reserved',
    serviceState: 'not_started',
    x402ReceiptHash: null,
    serviceResponseHash: null,
    idempotencyKey: input.idempotencyKey,
  });
}

/** Provider transport failure / invalid schema response (decision 5.6): the
 * reservation is ALREADY released by the caller before this is built — the
 * user was never charged. */
function chargeReleasedAfterProviderFailureV1(
  charge: IntelligenceChargeV1,
  input: { serviceState: 'failed' | 'invalid'; now: string },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({ ...rest, status: 'released', serviceState: input.serviceState, updatedAt: input.now });
}

/** Evidence persisted but could not be durably stored (decision 5.7): the
 * reservation is released — service ran, but Miorail cannot honestly hand
 * the client evidence it never durably recorded. */
function chargeReleasedAfterEvidencePersistFailureV1(charge: IntelligenceChargeV1, now: string): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({ ...rest, status: 'released', serviceState: 'delivered', evidenceHash: null, updatedAt: now });
}

/** Evidence durably persisted (decision 5.7 success path) — status advances
 * to 'payment_pending' (mirrors T59's OWN interim status, here meaning "the
 * service half is done, the Spend Permission charge is now pending"). */
function chargeEvidenceDeliveredV1(
  charge: IntelligenceChargeV1,
  input: { evidenceHash: string; evidenceSetHash: string; serviceResponseHash: string; now: string },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'payment_pending',
    paymentState: 'pending',
    serviceState: 'delivered',
    evidenceHash: input.evidenceHash as IntelligenceChargeV1['evidenceHash'],
    evidenceSetHash: input.evidenceSetHash as IntelligenceChargeV1['evidenceSetHash'],
    serviceResponseHash: input.serviceResponseHash as IntelligenceChargeV1['serviceResponseHash'],
    updatedAt: input.now,
  });
}

/** Decision 5.8 success — the ONLY transition that reaches 'settled'.
 * `x402ReceiptHash` carries a hash of the Spend Permission charge proof
 * (the field predates T60 but is generic "settlement proof hash" content —
 * IntelligenceChargeV1Schema's own superRefine requires it non-null for
 * status 'settled' regardless of fundingMode). */
function chargeSettledV1(
  charge: IntelligenceChargeV1,
  input: { chargedCost: MoneyV1; proofHash: string; now: string },
): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({
    ...rest,
    status: 'settled',
    paymentState: 'settled',
    serviceState: 'delivered',
    chargedCost: input.chargedCost,
    x402ReceiptHash: input.proofHash as IntelligenceChargeV1['x402ReceiptHash'],
    updatedAt: input.now,
  });
}

/** Decision 5.8 failure-after-delivery — the reservation deliberately stays
 * 'reserved' (the obligation is real; remaining headroom stays reduced)
 * until this is manually resolved. Never retried automatically. */
function chargeReconciliationRequiredV1(charge: IntelligenceChargeV1, now: string): IntelligenceChargeV1 {
  const { chargeHash: _chargeHash, ...rest } = charge;
  return recomputeChargeHash({ ...rest, status: 'reconciliation_required', paymentState: 'failed', updatedAt: now });
}

function recomputedBudgetHash(budget: IntelligenceBudgetV1, overrides: Partial<IntelligenceBudgetV1>): string {
  const draft: IntelligenceBudgetV1 = { ...budget, ...overrides, budgetHash: ZERO_HASH_V1 };
  return hashIntelligenceBudgetV1(draft);
}

async function reconstructCachedResultV1(
  deps: RunBudgetSimulationDependenciesV1,
  input: RunBudgetSimulationInputV1,
  charge: IntelligenceChargeV1,
): Promise<RunBudgetSimulationResultV1> {
  const evidenceRecords = await deps.repository.listEvidence(input.routeRunId, input.tenantId);
  const evidence = charge.evidenceHash
    ? evidenceRecords.find((record) => record.evidenceHash === charge.evidenceHash)
    : undefined;
  const evidenceSets = charge.evidenceSetHash
    ? await deps.repository.listEvidenceSets(input.routeRunId, input.tenantId)
    : [];
  const evidenceSet = evidenceSets.find((set) => set.evidenceSetHash === charge.evidenceSetHash);
  const budget = charge.intelligenceBudgetId
    ? await deps.repository.getIntelligenceBudgetById(charge.intelligenceBudgetId, input.tenantId)
    : null;
  const reservations = budget ? await deps.repository.listIntelligenceBudgetReservations(budget.id, input.tenantId) : [];
  const reservation = reservations.find((entry) => entry.id === charge.reservationId);

  if (!evidence || !evidenceSet || !budget || !reservation) {
    // Defense-in-depth (matches T59's B1 rework): a deterministic
    // idempotencyKey must never trap the caller in a dead end just because
    // some durable linkage went missing — report an honest, non-fabricated
    // failure instead of a 500.
    return { outcome: 'provider_failed', charge, reason: 'evidence_missing' };
  }

  return { outcome: 'charged', charge, evidence, evidenceSet, budget, reservation };
}

/**
 * T60 decision 5 — the auto-flow behind [Use Intelligence Budget]:
 * reserve -> Miorail pays the simulation provider -> evidence -> charge the
 * user via their existing Spend Permission -> settle. Every mutation is
 * durable before the next step runs (crash-safe, like T59's coordinator).
 * Provider failure never charges the user; a charge failure AFTER evidence
 * was delivered never charges twice and never silently drops the
 * obligation (reconciliation_required, budget paused).
 */
export async function runBudgetSimulationV1(
  deps: RunBudgetSimulationDependenciesV1,
  input: RunBudgetSimulationInputV1,
): Promise<RunBudgetSimulationResultV1> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const ttlMs = deps.reservationTtlMs ?? DEFAULT_INTELLIGENCE_BUDGET_RESERVATION_TTL_MS;

  // --- (1) Blueprint binding — fail-closed exceptions, mirrors T59 exactly ---
  const blueprints = await deps.repository.listBlueprints(input.routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored) {
    throw new BudgetSimulationBindingError('blueprint_not_found', 'Blueprint does not exist for this Route Run and tenant');
  }
  const blueprint = stored.blueprint;
  if (blueprint.status !== 'ready_for_review' && blueprint.status !== 'approved') {
    throw new BudgetSimulationBindingError('blueprint_not_reviewable', `Blueprint status ${blueprint.status} cannot be simulated`);
  }
  if (blueprint.blueprintHash !== input.blueprintHash) {
    throw new BudgetSimulationBindingError('blueprint_hash_mismatch', 'Blueprint hash does not match the stored Blueprint');
  }
  if (Date.parse(blueprint.quoteExpiry) <= now.getTime()) {
    throw new BudgetSimulationBindingError('blueprint_expired', 'Blueprint quote has expired');
  }
  if (hashApprovedCallsV1(blueprint.calls) !== blueprint.callsHash) {
    throw new BudgetSimulationBindingError('changed_calls', 'Blueprint calls no longer match their stored hash');
  }

  // --- (2) Budget load + guard (decision 5.2) --------------------------------
  const budgetRecord = await deps.repository.getActiveIntelligenceBudget(input.tenantId, input.walletAddress, 8453);
  if (!budgetRecord) return { outcome: 'blocked', reason: 'budget_not_found' };
  const budgetDomain = intelligenceBudgetV1FromRecord(budgetRecord, deps.price.asset);
  const budgetCheck = validateBudgetForSimulationV1({
    budget: budgetDomain,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    category: input.category,
    costAtomic: deps.price.amountAtomic,
    now,
  });
  if (!budgetCheck.ok) return { outcome: budgetCheck.outcome, reason: budgetCheck.reason };

  // --- (3) Spend Permission preflight (decision 5.3) — ANY mismatch blocks --
  const permission = await deps.spendPermissionRepository.getById(budgetRecord.spendPermissionId);
  const permissionCheck = checkSpendPermissionV1({
    permission,
    tenantId: input.tenantId,
    now,
    expectedAssetAddress: deps.price.asset.address ?? '',
  });
  if (!permissionCheck.ok) return { outcome: 'blocked', reason: permissionCheck.reason };
  const bindingCheck = checkSpendPermissionBindingV1({ permission: permission!, budget: budgetDomain });
  if (!bindingCheck.ok) return { outcome: 'blocked', reason: bindingCheck.reason };
  const chargerPreflight = await deps.charger.preflight({
    permissionId: budgetRecord.spendPermissionId,
    amountAtomic: deps.price.amountAtomic,
  });
  if (!chargerPreflight.ok) {
    return { outcome: 'blocked', reason: chargerPreflight.reason ?? 'spend_permission_preflight_failed' };
  }

  // --- (4) Idempotency + reservation (decisions 5.4 / 8) ---------------------
  const idempotencyKey = stableHashV1('intelligence-budget-request/v1', {
    tenantId: input.tenantId,
    walletAddress: input.walletAddress.toLowerCase(),
    blueprintHash: input.blueprintHash,
    category: input.category,
    requestId: input.requestId,
  });
  const existingCharges = (await deps.repository.listIntelligenceCharges(input.routeRunId, input.tenantId)).map(
    (entry) => entry.charge,
  );
  const decision = resolveBudgetSimulationIdempotencyV1({
    existingCharges,
    candidateHash: blueprint.selectedCandidateHash,
    idempotencyKey,
  });
  if (decision.kind === 'conflict') return { outcome: 'blocked', reason: 'charge_conflict' };
  if (decision.kind === 'cached') return reconstructCachedResultV1(deps, input, decision.charge);

  let charge: IntelligenceChargeV1;
  let reservation: IntelligenceBudgetReservationRecord;

  if (decision.kind === 'retry') {
    charge = decision.charge;
    const reservations = await deps.repository.listIntelligenceBudgetReservations(budgetRecord.id, input.tenantId);
    const found = reservations.find((entry) => entry.id === charge.reservationId);
    if (!found) {
      // Integrity failure, not a soft outcome — a retry charge must always
      // reference a real reservation.
      throw new BudgetSimulationBindingError('blueprint_not_found', 'Retry charge references a missing reservation');
    }
    reservation = found;
  } else {
    await deps.repository.expireStaleIntelligenceReservations(budgetRecord.id, nowIso);
    const reservationId = `intelligence-budget-reservation:${stableHashV1('intelligence-budget-reservation-id/v1', {
      budgetId: budgetRecord.id,
      idempotencyKey,
    }).slice(2)}`;
    const reserveResult = await deps.repository.reserveIntelligenceBudget({
      budgetId: budgetRecord.id,
      userId: input.tenantId,
      reservationId,
      amountAtomic: deps.price.amountAtomic,
      idempotencyKey,
      now: nowIso,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    if (reserveResult.outcome === 'insufficient') return { outcome: 'limit_exceeded', reason: 'monthly_limit_exceeded' };
    if (reserveResult.outcome === 'inactive') return { outcome: 'blocked', reason: 'budget_inactive' };
    reservation = reserveResult.reservation;
    charge = buildReservedIntelligenceChargeV1({
      routeRunId: input.routeRunId,
      blueprintId: blueprint.id,
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      intentHash: blueprint.intentHash,
      candidateHash: blueprint.selectedCandidateHash,
      spendPermissionId: budgetRecord.spendPermissionId,
      intelligenceBudgetId: budgetRecord.id,
      reservationId: reservation.id,
      idempotencyKey,
      price: deps.price,
      provider: simulationProviderRefV1(deps.providerId),
      now: nowIso,
    });
    await deps.repository.insertIntelligenceCharge(input.routeRunId, charge);
  }

  // --- (6) Miorail pays the provider — NEVER the user's own asset movement --
  const requestHash = stableHashV1('intelligence-budget-simulation-request/v1', {
    chainId: 8453,
    walletAddress: input.walletAddress.toLowerCase(),
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
  });
  const transport = await deps.provider.simulate({
    chainId: 8453,
    walletAddress: input.walletAddress,
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
    calls: blueprint.calls,
  });
  if (!transport.ok) {
    await deps.repository.releaseIntelligenceReservation(reservation.id, input.tenantId, nowIso, transport.errorCode);
    const failedCharge = chargeReleasedAfterProviderFailureV1(charge, { serviceState: 'failed', now: nowIso });
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, failedCharge);
    return { outcome: 'provider_failed', charge: failedCharge, reason: transport.errorCode };
  }
  const parsed = SimulationProviderResponseV1Schema.safeParse(transport.body);
  if (!parsed.success || !(parsed.data.blockNumber > 0)) {
    await deps.repository.releaseIntelligenceReservation(reservation.id, input.tenantId, nowIso, 'invalid_response');
    const invalidCharge = chargeReleasedAfterProviderFailureV1(charge, { serviceState: 'invalid', now: nowIso });
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, invalidCharge);
    return { outcome: 'provider_failed', charge: invalidCharge, reason: 'invalid_response' };
  }
  const response = parsed.data;
  const responseHash = stableHashV1('intelligence-budget-simulation-response/v1', response);
  const blockNumberAtomic = String(response.blockNumber);

  // --- (7) Evidence — bare catch mirrors T59's own evidence_persist_failed --
  let evidenceRecord: EvidenceRecordV1;
  let nextSet: EvidenceSetV1;
  let deliveredCharge: IntelligenceChargeV1;
  try {
    const candidates = await deps.repository.listCandidates(input.routeRunId, input.tenantId);
    const candidate = candidates.find((entry) => entry.candidateHash === blueprint.selectedCandidateHash);
    if (!candidate) throw new Error('candidate_not_found');
    const evidenceSets = await deps.repository.listEvidenceSets(input.routeRunId, input.tenantId);
    const currentSet = evidenceSets.find((set) => set.evidenceSetHash === blueprint.evidenceSetHash);
    if (!currentSet) throw new Error('evidence_set_not_found');

    evidenceRecord = buildSimulationEvidenceRecordV1({
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      intentHash: blueprint.intentHash,
      candidateHash: blueprint.selectedCandidateHash,
      provider: simulationProviderRefV1(deps.providerId),
      observedAt: nowIso,
      expiresAt: new Date(now.getTime() + EVIDENCE_TTL_MS).toISOString(),
      blockNumber: blockNumberAtomic,
      requestHash,
      responseHash,
      cost: deps.price,
      intelligenceChargeId: charge.id,
      validationStatus: 'valid',
      validationErrors: response.status === 'reverted' ? ['simulation_reverted'] : [],
    });
    await deps.repository.insertEvidence(input.routeRunId, candidate.id, evidenceRecord);
    nextSet = buildUpdatedEvidenceSetV1({ previous: currentSet, newRecord: evidenceRecord, now: nowIso });
    await deps.repository.insertEvidenceSet(input.routeRunId, candidate.id, nextSet);

    deliveredCharge = chargeEvidenceDeliveredV1(charge, {
      evidenceHash: evidenceRecord.evidenceHash,
      evidenceSetHash: nextSet.evidenceSetHash,
      serviceResponseHash: responseHash,
      now: nowIso,
    });
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, deliveredCharge, {
      evidenceId: evidenceRecord.id,
    });
  } catch {
    await deps.repository.releaseIntelligenceReservation(reservation.id, input.tenantId, nowIso, 'evidence_persist_failed');
    const failedCharge = chargeReleasedAfterEvidencePersistFailureV1(charge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, failedCharge);
    return { outcome: 'provider_failed', charge: failedCharge, reason: 'evidence_persist_failed' };
  }

  // --- (8) Charge the user via their EXISTING Spend Permission --------------
  const chargeResult = await deps.charger.charge({
    permissionId: budgetRecord.spendPermissionId,
    amountAtomic: deps.price.amountAtomic,
    idempotencyKey,
  });
  if (!chargeResult.ok) {
    const reconciling = chargeReconciliationRequiredV1(deliveredCharge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, reconciling);
    const pausedHash = recomputedBudgetHash(budgetDomain, { status: 'paused' });
    const pausedBudget = await deps.repository.updateIntelligenceBudget(budgetRecord.id, input.tenantId, {
      status: 'paused',
      budgetHash: pausedHash,
      now: nowIso,
    });
    // Reservation is deliberately left 'reserved' (decision 5.8) — never
    // released, never re-attempted automatically.
    return { outcome: 'reconciliation_required', charge: reconciling, budget: pausedBudget, reason: chargeResult.reason };
  }

  const proof = chargeResult.proof;
  await deps.spendPermissionRepository.incrementSpent(budgetRecord.spendPermissionId, Number(deps.price.amountDecimal), proof);
  const settleResult = await deps.repository.settleIntelligenceReservation(reservation.id, input.tenantId, nowIso);
  const proofHash = stableHashV1('intelligence-budget-charge-proof/v1', proof);
  const settledCharge = chargeSettledV1(deliveredCharge, { chargedCost: deps.price, proofHash, now: nowIso });
  await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, settledCharge);

  return {
    outcome: 'charged',
    charge: settledCharge,
    evidence: evidenceRecord,
    evidenceSet: nextSet,
    budget: settleResult.budget ?? budgetRecord,
    reservation: settleResult.reservation ?? reservation,
  };
}
