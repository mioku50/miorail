import {
  hashApprovedCallsV1,
  stableHashV1,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type IntelligenceChargeV1,
  type MoneyV1,
  type PathScoreV1,
  type ProviderRefV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import { scoreRoutesV1 } from '@mioagent/route-engine';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import {
  buildDuplicateSettlementChargeV1,
  chargeWithEvidencePersistFailedV1,
  chargeWithEvidencePersistedV1,
  chargeWithInvalidResponseV1,
  chargeWithPaymentFailedV1,
  chargeWithPaymentSettledV1,
  chargeWithServiceFailedAfterPaymentV1,
} from './charges.js';
import { buildSimulationEvidenceRecordV1, buildUpdatedEvidenceSetV1 } from './evidence.js';
import { SimulationProviderResponseV1Schema, type SimulationProviderResponseV1 } from './schemas.js';
import type { SimulationProvider } from './provider.js';

/** Structurally-compatible subset of @mioagent/x402-gateway's
 * X402SettlementRecord — paid-intelligence deliberately does NOT depend on
 * x402-gateway (that would pull in express/@x402/*), so the API layer's real
 * X402SettlementRecord is simply passed in wherever this shape is expected. */
export interface PaidSimulationSettlementV1 {
  txHash: string | null;
  payer?: string;
  network: string;
  amount: string;
  status: 'settled' | 'pending' | 'failed';
}

const EVIDENCE_TTL_MS = 10 * 60_000;

export class PaidSimulationBindingError extends Error {
  readonly code:
    | 'blueprint_not_found'
    | 'candidate_not_found'
    | 'evidence_set_not_found'
    | 'changed_calls'
    | 'payment_missing'
    | 'payment_replayed';
  constructor(code: PaidSimulationBindingError['code'], message: string) {
    super(message);
    this.name = 'PaidSimulationBindingError';
    this.code = code;
  }
}

export interface RunPaidSimulationDependenciesV1 {
  repository: RouteStorageRepository;
  provider: SimulationProvider;
  now: () => Date;
  /** Resolved once per request from env (decision 4); USDC on Base. */
  price: MoneyV1;
  /** ProviderRefV1 recorded on the charge AND the resulting evidence. */
  chargeProvider: ProviderRefV1;
}

export interface RunPaidSimulationInputV1 {
  tenantId: string;
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  /** Present only when the request just went through the x402 gate this
   * call; null on a "settled, service retry" replay (decision 3, step 2's
   * second branch) where payment already settled on a PRIOR attempt. */
  settlement: PaidSimulationSettlementV1 | null;
  /** MUST already exist — created by the idempotency short-circuit step
   * before the x402 challenge (decision 5). */
  existingCharge: IntelligenceChargeV1;
}

export type RunPaidSimulationResultV1 =
  | {
      outcome: 'simulated';
      charge: IntelligenceChargeV1;
      simulation: SimulationStateV1;
      evidence: EvidenceRecordV1;
      evidenceSet: EvidenceSetV1;
      pathScore: PathScoreV1 | null;
      /** T63B — the VALIDATED provider response the evidence's responseHash was
       * computed over. Returned (not persisted) so the route can report gas,
       * per-call results and proven asset changes without re-deriving them; the
       * hash in the durable evidence is what binds them. */
      response: SimulationProviderResponseV1;
    }
  | {
      outcome: 'invalid_response';
      charge: IntelligenceChargeV1;
      simulation: SimulationStateV1;
      reason: string;
    }
  | {
      outcome: 'paid_service_failed';
      charge: IntelligenceChargeV1;
      simulation: SimulationStateV1;
      reason: string;
    };

/** MoneyV1 from an actual settled atomic USDC amount (6 decimals), keeping
 * the asset/chain of the quoted price (rework N1). */
function moneyFromAtomicUsdcV1(template: MoneyV1, amountAtomic: string): MoneyV1 {
  const value = BigInt(amountAtomic);
  const units = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const amountDecimal = fraction ? `${units}.${fraction}` : units.toString();
  return {
    asset: template.asset,
    amountAtomic,
    amountDecimal,
    usdValue: amountDecimal,
  };
}

function unavailableSimulationState(requestHash: string, now: string, errorCode: string): SimulationStateV1 {
  return {
    status: 'unavailable',
    observedAt: now,
    blockNumber: null,
    requestHash: requestHash as SimulationStateV1['requestHash'],
    responseHash: null,
    errorCode,
  };
}

/**
 * T59 decision 7 — the orchestrator invoked by the paid handler AFTER the
 * x402 middleware has already run (or, on a settled-but-undelivered retry,
 * after the idempotency short-circuit decided to skip payment entirely).
 * Every persist step goes through repository.updateIntelligenceCharge so a
 * crash mid-flow always leaves a durable, honest charge state — never a
 * silent loss of "the user paid" information.
 */
export async function runPaidSimulationV1(
  deps: RunPaidSimulationDependenciesV1,
  input: RunPaidSimulationInputV1,
): Promise<RunPaidSimulationResultV1> {
  const now = deps.now();
  const nowIso = now.toISOString();

  const blueprints = await deps.repository.listBlueprints(input.routeRunId, input.tenantId);
  const stored = blueprints.find((entry) => entry.blueprint.id === input.blueprintId);
  if (!stored) {
    throw new PaidSimulationBindingError('blueprint_not_found', 'Blueprint does not exist for this Route Run and tenant');
  }
  const blueprint = stored.blueprint;

  // Defense-in-depth self-consistency check (decision 7): the calls used to
  // build the provider request are EXACTLY the calls the persisted
  // blueprintHash was computed over.
  if (hashApprovedCallsV1(blueprint.calls) !== blueprint.callsHash) {
    throw new PaidSimulationBindingError('changed_calls', 'Blueprint calls no longer match their stored hash');
  }

  let charge = input.existingCharge;

  // Computed early — the settlement failure paths below need it for their
  // honest SimulationStateV1 too, not just the provider call.
  const requestHash = stableHashV1('paid-intelligence-simulation-request/v1', {
    chainId: 8453,
    walletAddress: input.walletAddress.toLowerCase(),
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
  });

  /** Actual cost carried to the terminal chargedCost — derived from the
   * REAL settlement amount when one is present (rework N1); a payment-free
   * service retry keeps the already-settled quoted amount. */
  let chargedCost: MoneyV1 = charge.quotedCost;

  // --- Settlement -----------------------------------------------------------
  if (input.settlement) {
    if (input.settlement.status !== 'settled' || !input.settlement.txHash) {
      const failed = chargeWithPaymentFailedV1(charge, nowIso);
      await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, failed);
      throw new PaidSimulationBindingError('payment_missing', 'x402 settlement did not report success');
    }
    const x402ReceiptHash = stableHashV1('paid-intelligence-x402-receipt/v1', {
      txHash: input.settlement.txHash,
      payer: input.settlement.payer ?? null,
      network: input.settlement.network,
      amount: input.settlement.amount,
    });

    // Rework M2: replay protection is tenant-WIDE (any Route Run of this
    // user), not merely run-scoped — a receipt already bound to a DIFFERENT
    // charge anywhere is a replayed settlement.
    const replay = await deps.repository.findIntelligenceChargeByReceiptHash(input.tenantId, x402ReceiptHash);
    if (replay && replay.charge.id !== charge.id) {
      throw new PaidSimulationBindingError(
        'payment_replayed',
        'x402 settlement receipt is already bound to a different charge',
      );
    }

    // Rework M1: re-read the STORED charge — a concurrent request (second
    // tab) may have settled first, and its receipt must NEVER be
    // overwritten. The loser's settlement is preserved as a brand-new
    // reconciliation_required ledger row instead.
    const storedCharges = await deps.repository.listIntelligenceCharges(input.routeRunId, input.tenantId);
    const storedCharge = storedCharges.find((entry) => entry.charge.id === charge.id)?.charge ?? charge;
    if (storedCharge.x402ReceiptHash !== null && storedCharge.x402ReceiptHash !== x402ReceiptHash) {
      const duplicate = buildDuplicateSettlementChargeV1(storedCharge, { x402ReceiptHash, now: nowIso });
      await deps.repository.insertIntelligenceCharge(input.routeRunId, duplicate);
      return {
        outcome: 'paid_service_failed',
        charge: duplicate,
        simulation: unavailableSimulationState(requestHash, nowIso, 'duplicate_settlement'),
        reason: 'duplicate_settlement',
      };
    }
    charge = storedCharge;

    // Rework N1: verify the settled amount against the quoted price. A
    // mismatch is a fail-closed reconciliation case — money moved, so the
    // receipt hash IS recorded, but no service runs on an unexpected amount.
    const settledAmount = input.settlement.amount?.trim();
    if (settledAmount && settledAmount !== charge.quotedCost.amountAtomic) {
      const mismatched = chargeWithServiceFailedAfterPaymentV1(
        chargeWithPaymentSettledV1(charge, { x402ReceiptHash, now: nowIso }),
        nowIso,
      );
      await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, mismatched);
      return {
        outcome: 'paid_service_failed',
        charge: mismatched,
        simulation: unavailableSimulationState(requestHash, nowIso, 'settlement_amount_mismatch'),
        reason: 'settlement_amount_mismatch',
      };
    }
    if (settledAmount) {
      chargedCost = moneyFromAtomicUsdcV1(charge.quotedCost, settledAmount);
    }

    charge = chargeWithPaymentSettledV1(charge, { x402ReceiptHash, now: nowIso });
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, charge);
  } else if (charge.paymentState !== 'settled') {
    throw new PaidSimulationBindingError('payment_missing', 'No x402 settlement is recorded for this charge');
  }

  const transport = await deps.provider.simulate({
    chainId: 8453,
    walletAddress: input.walletAddress,
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
    calls: blueprint.calls,
  });

  if (!transport.ok) {
    const failedCharge = chargeWithServiceFailedAfterPaymentV1(charge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, failedCharge);
    return {
      outcome: 'paid_service_failed',
      charge: failedCharge,
      simulation: unavailableSimulationState(requestHash, nowIso, transport.errorCode),
      reason: transport.errorCode,
    };
  }

  const parsed = SimulationProviderResponseV1Schema.safeParse(transport.body);
  if (!parsed.success) {
    const invalidCharge = chargeWithInvalidResponseV1(charge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, invalidCharge);
    return {
      outcome: 'invalid_response',
      charge: invalidCharge,
      simulation: unavailableSimulationState(requestHash, nowIso, 'invalid_response'),
      reason: 'malformed_provider_response',
    };
  }
  const response = parsed.data;
  if (!(response.blockNumber > 0)) {
    const invalidCharge = chargeWithInvalidResponseV1(charge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, invalidCharge);
    return {
      outcome: 'invalid_response',
      charge: invalidCharge,
      simulation: unavailableSimulationState(requestHash, nowIso, 'invalid_response'),
      reason: 'invalid_block_number',
    };
  }
  const responseHash = stableHashV1('paid-intelligence-simulation-response/v1', response);
  const blockNumberAtomic = String(response.blockNumber);

  const simulation: SimulationStateV1 =
    response.status === 'success'
      ? {
          status: 'passed',
          observedAt: nowIso,
          blockNumber: blockNumberAtomic,
          requestHash: requestHash as SimulationStateV1['requestHash'],
          responseHash: responseHash as SimulationStateV1['responseHash'],
          errorCode: null,
        }
      : {
          status: 'failed',
          observedAt: nowIso,
          blockNumber: blockNumberAtomic,
          requestHash: requestHash as SimulationStateV1['requestHash'],
          responseHash: responseHash as SimulationStateV1['responseHash'],
          errorCode: 'reverted',
        };

  // --- Evidence + Evidence Set + Path Score ------------------------------------
  try {
    const candidates = await deps.repository.listCandidates(input.routeRunId, input.tenantId);
    const candidate = candidates.find((entry) => entry.candidateHash === blueprint.selectedCandidateHash);
    if (!candidate) {
      throw new PaidSimulationBindingError('candidate_not_found', 'Blueprint selected candidate is not stored');
    }

    const evidenceSets = await deps.repository.listEvidenceSets(input.routeRunId, input.tenantId);
    const currentSet = evidenceSets.find((set) => set.evidenceSetHash === blueprint.evidenceSetHash);
    if (!currentSet) {
      throw new PaidSimulationBindingError('evidence_set_not_found', 'Blueprint Evidence Set is not stored');
    }

    const evidenceRecord = buildSimulationEvidenceRecordV1({
      tenantId: input.tenantId,
      walletAddress: input.walletAddress,
      intentHash: blueprint.intentHash,
      candidateHash: blueprint.selectedCandidateHash,
      provider: deps.chargeProvider,
      observedAt: nowIso,
      expiresAt: new Date(now.getTime() + EVIDENCE_TTL_MS).toISOString(),
      blockNumber: blockNumberAtomic,
      requestHash,
      responseHash,
      cost: chargedCost,
      intelligenceChargeId: charge.id,
      validationStatus: 'valid',
      // Informational only (the evidence record itself is fully valid either
      // way) — lets a later 'cached' replay (route layer, decision 3 step 2)
      // honestly reconstruct SimulationStateV1.status without re-calling the
      // provider, since EvidenceRecordV1 has no dedicated pass/revert field.
      validationErrors: simulation.status === 'failed' ? ['simulation_reverted'] : [],
    });
    await deps.repository.insertEvidence(input.routeRunId, candidate.id, evidenceRecord);

    const nextSet = buildUpdatedEvidenceSetV1({ previous: currentSet, newRecord: evidenceRecord, now: nowIso });
    await deps.repository.insertEvidenceSet(input.routeRunId, candidate.id, nextSet);

    const settledCharge = chargeWithEvidencePersistedV1(charge, {
      chargedCost,
      evidenceHash: evidenceRecord.evidenceHash,
      evidenceSetHash: nextSet.evidenceSetHash,
      serviceResponseHash: responseHash,
      now: nowIso,
    });
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, settledCharge, {
      evidenceId: evidenceRecord.id,
    });

    // Path Score snapshot refresh (decision 7): best-effort — the simulation
    // evidence above is already durably persisted before this runs, so a
    // scoring failure never rolls back (or hides) the paid evidence.
    let pathScore: PathScoreV1 | null = null;
    try {
      const run = await deps.repository.getRouteRun(input.routeRunId, input.tenantId);
      if (run) {
        const scored = scoreRoutesV1({ intent: run.intent, candidates: [candidate], evidenceSets: [nextSet], now });
        pathScore = scored[0]?.pathScore ?? null;
        if (pathScore) {
          await deps.repository.insertScoreSnapshot(input.routeRunId, candidate.id, pathScore);
        }
      }
    } catch {
      pathScore = null;
    }

    return {
      outcome: 'simulated',
      charge: settledCharge,
      simulation,
      evidence: evidenceRecord,
      evidenceSet: nextSet,
      pathScore,
      response,
    };
  } catch {
    const failedCharge = chargeWithEvidencePersistFailedV1(charge, nowIso);
    await deps.repository.updateIntelligenceCharge(input.routeRunId, charge.id, input.tenantId, failedCharge);
    return {
      outcome: 'paid_service_failed',
      charge: failedCharge,
      simulation,
      reason: 'evidence_persist_failed',
    };
  }
}
