import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hashApprovedCallsV1,
  stableHashV1,
  type IntelligenceChargeV1,
} from '@mioagent/route-domain';
import { validUniswapCandidateFixture } from '@mioagent/route-domain/fixtures';
import type { SimulationProvider, SimulationProviderResultV1 } from '../src/provider.js';
import {
  PaidSimulationBindingError,
  runPaidSimulationV1,
  type PaidSimulationSettlementV1,
} from '../src/coordinator.js';
import { resolvePaidSimulationIdempotencyV1 } from '../src/idempotency.js';
import { SimulationProviderResponseV1Schema } from '../src/schemas.js';
import { buildPendingSimulationChargeV1, chargeWithPaymentSettledV1 } from '../src/charges.js';
import {
  SIMULATION_PRICE,
  SIMULATION_PROVIDER_REF,
  T59_BLUEPRINT_FIXTURE,
  WALLET_ADDRESS,
  seedPaidSimulationFixture,
} from './fixtures.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

function mockProvider(
  result: SimulationProviderResultV1 | ((request: unknown) => SimulationProviderResultV1),
): SimulationProvider & { callCount: number; lastRequest: unknown } {
  const provider = {
    providerId: 'mock-sim-v1',
    callCount: 0,
    lastRequest: undefined as unknown,
    async simulate(request: unknown): Promise<SimulationProviderResultV1> {
      provider.callCount += 1;
      provider.lastRequest = request;
      return typeof result === 'function' ? result(request) : result;
    },
  };
  return provider;
}

function settledSettlement(txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'): PaidSimulationSettlementV1 {
  return { txHash, payer: WALLET_ADDRESS, network: 'eip155:8453', amount: '10000', status: 'settled' };
}

async function pendingChargeFor(routeRunId: string, blueprintId: string, idempotencyKey = 'idem-key-1') {
  return buildPendingSimulationChargeV1({
    routeRunId,
    blueprintId,
    tenantId: T59_BLUEPRINT_FIXTURE.tenantId,
    walletAddress: WALLET_ADDRESS,
    intentHash: T59_BLUEPRINT_FIXTURE.intentHash,
    candidateHash: T59_BLUEPRINT_FIXTURE.selectedCandidateHash,
    idempotencyKey,
    price: SIMULATION_PRICE,
    provider: SIMULATION_PROVIDER_REF,
    now: NOW.toISOString(),
  });
}

const SUCCESS_BODY = {
  status: 'success' as const,
  blockNumber: 33_555_111,
  gasUsed: '145000',
  stateChanges: [{ address: WALLET_ADDRESS, kind: 'balance' as const, summary: 'USDC balance decreases' }],
  revertReason: null,
};

const REVERT_BODY = {
  status: 'reverted' as const,
  blockNumber: 33_555_222,
  gasUsed: '21000',
  stateChanges: [],
  revertReason: 'ERC20: transfer amount exceeds balance',
};

describe('runPaidSimulationV1', () => {
  it('runs the full happy path: charge settles, evidence is paid + linked, missing loses simulation, pathScore stays not_scored', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'simulated');
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(result.simulation.status, 'passed');
    assert.ok(result.simulation.blockNumber);
    assert.ok(result.simulation.observedAt);
    assert.ok(result.simulation.requestHash);
    assert.ok(result.simulation.responseHash);

    // Charge: settled, paid, linked to the paid evidence + x402 receipt.
    assert.equal(result.charge.status, 'settled');
    assert.equal(result.charge.paymentState, 'settled');
    assert.equal(result.charge.serviceState, 'delivered');
    assert.ok(result.charge.x402ReceiptHash);
    assert.ok(result.charge.serviceResponseHash);
    assert.equal(result.charge.evidenceHash, result.evidence.evidenceHash);
    assert.equal(result.charge.evidenceSetHash, result.evidenceSet.evidenceSetHash);

    // Evidence: paid, cost set, intelligenceChargeId links back to the charge.
    assert.equal(result.evidence.freeOrPaid, 'paid');
    assert.ok(result.evidence.cost);
    assert.equal(result.evidence.intelligenceChargeId, result.charge.id);
    assert.equal(result.evidence.evidenceType, 'simulation');
    assert.equal(result.evidence.validationStatus, 'valid');

    // Evidence Set: NEW object, old one untouched, 'simulation' left missingEvidence.
    const allSets = await repository.listEvidenceSets(routeRunId, charge.tenantId);
    assert.equal(allSets.length, 2);
    const oldSet = allSets.find((set) => set.id !== result.evidenceSet.id);
    assert.ok(oldSet);
    assert.deepEqual(oldSet?.missingEvidence.sort(), ['contract_risk', 'simulation']);
    assert.deepEqual(result.evidenceSet.missingEvidence, ['contract_risk']);
    assert.equal(result.evidenceSet.status, 'partial');
    assert.ok(result.evidenceSet.records.some((record) => record.evidenceHash === result.evidence.evidenceHash));

    // Path Score snapshot: recomputed, transaction_safety stays not_scored.
    assert.ok(result.pathScore);
    const safetyDimension = result.pathScore?.dimensions.find((dim) => dim.dimension === 'transaction_safety');
    assert.equal(safetyDimension?.status, 'not_scored');
    assert.equal(safetyDimension?.score, null);
    const snapshots = await repository.listScoreSnapshots(routeRunId, charge.tenantId);
    assert.equal(snapshots.length, 1);

    // Provider only ever sees the whitelisted fields, chainId pinned to 8453.
    const request = provider.lastRequest as { chainId: number; walletAddress: string; calls: unknown[] };
    assert.equal(request.chainId, 8453);
    assert.equal(request.walletAddress, WALLET_ADDRESS);
    assert.equal(request.calls.length, T59_BLUEPRINT_FIXTURE.calls.length);
  });

  it('reports simulated revert as SimulationStateV1 failed (never passed), evidence carries the responseHash', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: REVERT_BODY });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'simulated');
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(result.simulation.status, 'failed');
    assert.equal(result.simulation.errorCode, 'reverted');
    assert.ok(result.simulation.responseHash);
    assert.equal(result.evidence.responseHash, result.simulation.responseHash);
    // Still charged, still evidenced — a revert is a legitimate, paid answer.
    assert.equal(result.charge.status, 'settled');
  });

  it('provider transport failure after payment settles -> paid_service_failed, charge reconciliation_required', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: false, errorCode: 'timeout', detail: 'timed out' });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'paid_service_failed');
    if (result.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(result.charge.status, 'reconciliation_required');
    assert.equal(result.charge.paymentState, 'settled');
    assert.equal(result.charge.serviceState, 'failed');
    assert.equal(result.simulation.status, 'unavailable');
  });

  it('malformed provider response schema -> invalid_response, never passed', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: { status: 'success', blockNumber: 'not-a-number' } });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'invalid_response');
    if (result.outcome !== 'invalid_response') throw new Error('unreachable');
    assert.equal(result.charge.status, 'reconciliation_required');
    assert.equal(result.charge.serviceState, 'invalid');
    assert.notEqual(result.simulation.status, 'passed');
  });

  it('blockNumber missing/zero makes passed impossible -> invalid_response', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: { ...SUCCESS_BODY, blockNumber: 0 } });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'invalid_response');
    if (result.outcome !== 'invalid_response') throw new Error('unreachable');
    assert.notEqual(result.simulation.status, 'passed');
  });

  it('fails closed when the blueprint calls no longer match their stored hash', async () => {
    // Note: ExecutionBlueprintV1Schema's own superRefine ALREADY enforces
    // callsHash === hashApprovedCallsV1(calls) on every read (parseExecutionBlueprint
    // runs on every repository.listBlueprints call), so a blueprint whose calls
    // and callsHash disagree can never successfully round-trip through the
    // repository in the first place — the coordinator's own
    // hashApprovedCallsV1(blueprint.calls) !== blueprint.callsHash re-check
    // (decision 7) is therefore unreachable defense-in-depth, not a
    // substitute for a dedicated repository-level test. What IS testable here
    // is that a tampered/corrupted blueprint payload fails closed (via the
    // repository's own schema re-validation) rather than silently simulating
    // stale calls.
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    repository.unsafeCorruptPayloadForTests('blueprint', blueprintId, {
      ...T59_BLUEPRINT_FIXTURE,
      calls: [],
      callsHash: hashApprovedCallsV1(T59_BLUEPRINT_FIXTURE.calls), // stale hash vs. now-empty calls
    });
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    await assert.rejects(
      runPaidSimulationV1(
        { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
        {
          tenantId: charge.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement: settledSettlement(),
          existingCharge: charge,
        },
      ),
    );
    assert.equal(provider.callCount, 0);
  });

  it('rejects a replayed x402 settlement receipt already bound to a different charge', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const chargeA = await pendingChargeFor(routeRunId, blueprintId, 'idem-key-a');
    await repository.insertIntelligenceCharge(routeRunId, chargeA);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const settlement = settledSettlement('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const first = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: chargeA.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement,
        existingCharge: chargeA,
      },
    );
    assert.equal(first.outcome, 'simulated');

    const chargeB = await pendingChargeFor(routeRunId, blueprintId, 'idem-key-b');
    await repository.insertIntelligenceCharge(routeRunId, chargeB);

    await assert.rejects(
      runPaidSimulationV1(
        { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
        {
          tenantId: chargeB.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement, // SAME txHash replayed onto a different charge
          existingCharge: chargeB,
        },
      ),
      (error: unknown) => error instanceof PaidSimulationBindingError && error.code === 'payment_replayed',
    );
  });

  it('fails closed to payment_missing when settlement did not report success', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    await assert.rejects(
      runPaidSimulationV1(
        { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
        {
          tenantId: charge.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement: { txHash: null, network: 'eip155:8453', amount: '10000', status: 'failed' },
          existingCharge: charge,
        },
      ),
      (error: unknown) => error instanceof PaidSimulationBindingError && error.code === 'payment_missing',
    );
    const stored = (await repository.listIntelligenceCharges(routeRunId, charge.tenantId)).find(
      (entry) => entry.charge.id === charge.id,
    );
    assert.equal(stored?.charge.status, 'failed');
    assert.equal(stored?.charge.paymentState, 'failed');
    assert.equal(provider.callCount, 0);
  });

  it('fails closed to payment_missing on a settled-service-retry with no recorded settlement', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    await assert.rejects(
      runPaidSimulationV1(
        { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
        {
          tenantId: charge.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement: null, // no fresh settlement AND paymentState !== 'settled' yet
          existingCharge: charge,
        },
      ),
      (error: unknown) => error instanceof PaidSimulationBindingError && error.code === 'payment_missing',
    );
  });

  it('retries the paid service without a new settlement once paymentState is already settled', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const flakyProvider = mockProvider({ ok: false, errorCode: 'timeout', detail: 'timed out' });

    const first = await runPaidSimulationV1(
      { repository, provider: flakyProvider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );
    assert.equal(first.outcome, 'paid_service_failed');
    if (first.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(first.charge.paymentState, 'settled');

    const workingProvider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const second = await runPaidSimulationV1(
      { repository, provider: workingProvider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: null, // no NEW payment — the retry skips the x402 challenge entirely
        existingCharge: first.charge,
      },
    );
    assert.equal(second.outcome, 'simulated');
    if (second.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(second.charge.x402ReceiptHash, first.charge.x402ReceiptHash);
  });

  it('evidence persist failure -> paid_service_failed with reconciliation_required and a nulled evidenceHash', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    // Corrupt the stored candidate so the coordinator's post-response evidence
    // step cannot find it — the ONLY failure mode this test wants to exercise.
    repository.unsafeCorruptPayloadForTests('candidate', validUniswapCandidateFixture.id, {});
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    await assert.rejects(
      repository.listCandidates(routeRunId, charge.tenantId),
    );

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );

    assert.equal(result.outcome, 'paid_service_failed');
    if (result.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(result.reason, 'evidence_persist_failed');
    assert.equal(result.charge.status, 'reconciliation_required');
    assert.equal(result.charge.serviceState, 'delivered');
    assert.equal(result.charge.evidenceHash, null);
    assert.equal(result.charge.paymentState, 'settled');
  });

  it('never sets Spend Permission fields (grep-level guard against T60 scope creep)', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    assert.equal(charge.fundingMode, 'one_time');
    assert.equal(charge.spendPermissionId, null);
    assert.equal(charge.intelligenceBudgetId, null);
    assert.equal(charge.reservationId, null);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    const finalCharge: IntelligenceChargeV1 = result.charge;
    assert.equal(finalCharge.fundingMode, 'one_time');
    assert.equal(finalCharge.spendPermissionId, null);
    assert.equal(finalCharge.intelligenceBudgetId, null);
    assert.equal(finalCharge.reservationId, null);
  });

  // --- T59 rework B1: full recovery cycle -----------------------------------

  it('B1: evidence_persist_failed -> retry_service (NOT cached) -> service re-runs without a new payment -> evidence_persisted', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);

    // Transient persist fault: insertEvidenceSet fails exactly once, then heals.
    let evidenceSetFailures = 1;
    const flakyRepository = new Proxy(repository, {
      get(target, prop) {
        if (prop === 'insertEvidenceSet') {
          return async (...args: unknown[]) => {
            if (evidenceSetFailures > 0) {
              evidenceSetFailures -= 1;
              throw new Error('transient storage fault');
            }
            return (target.insertEvidenceSet as (...a: unknown[]) => Promise<void>).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof repository;

    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const first = await runPaidSimulationV1(
      { repository: flakyRepository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );
    assert.equal(first.outcome, 'paid_service_failed');
    if (first.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(first.reason, 'evidence_persist_failed');
    assert.equal(first.charge.serviceState, 'delivered');
    assert.equal(first.charge.evidenceHash, null);

    // The deterministic client idempotencyKey resolves to retry_service, NOT
    // cached (the pre-rework bug turned this state into a permanent 500).
    const stored = await repository.listIntelligenceCharges(routeRunId, charge.tenantId);
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: stored.map((entry) => entry.charge),
      candidateHash: T59_BLUEPRINT_FIXTURE.selectedCandidateHash,
      idempotencyKey: charge.idempotencyKey,
    });
    assert.equal(decision.kind, 'retry_service');
    if (decision.kind !== 'retry_service') throw new Error('unreachable');

    // Recovery: no new settlement, provider re-runs, evidence persists.
    const second = await runPaidSimulationV1(
      { repository: flakyRepository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: null,
        existingCharge: decision.charge,
      },
    );
    assert.equal(second.outcome, 'simulated');
    if (second.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(second.charge.status, 'settled');
    assert.equal(second.charge.serviceState, 'delivered');
    assert.notEqual(second.charge.evidenceHash, null);
    assert.equal(second.charge.x402ReceiptHash, first.charge.x402ReceiptHash);
    assert.equal(provider.callCount, 2);
    // Still ONE charge row — the recovery updated it, never duplicated it.
    const finalCharges = await repository.listIntelligenceCharges(routeRunId, charge.tenantId);
    assert.equal(finalCharges.length, 1);
  });

  // --- T59 rework M1: concurrent duplicate settlement -----------------------

  it('M1: a concurrent duplicate settlement is ledgered as a NEW reconciliation charge — the winner receipt is never overwritten', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    const txHashA = `0x${'a'.repeat(64)}`;
    const txHashB = `0x${'b'.repeat(64)}`;
    const receiptHash = (txHash: string) =>
      stableHashV1('paid-intelligence-x402-receipt/v1', {
        txHash,
        payer: WALLET_ADDRESS,
        network: 'eip155:8453',
        amount: '10000',
      });

    // Winner settles and delivers.
    const winner = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(txHashA),
        existingCharge: charge,
      },
    );
    assert.equal(winner.outcome, 'simulated');
    if (winner.outcome !== 'simulated') throw new Error('unreachable');

    // Loser raced through x402 with a STALE in-memory pending charge and its
    // OWN on-chain settlement (different txHash).
    const loser = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(txHashB),
        existingCharge: charge, // stale: still paymentState 'pending', receipt null
      },
    );
    assert.equal(loser.outcome, 'paid_service_failed');
    if (loser.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(loser.reason, 'duplicate_settlement');
    assert.equal(loser.charge.status, 'reconciliation_required');
    assert.equal(loser.charge.paymentState, 'settled');
    assert.equal(loser.charge.serviceState, 'failed');
    assert.equal(loser.charge.x402ReceiptHash, receiptHash(txHashB));
    assert.equal(loser.charge.idempotencyKey, charge.idempotencyKey);
    assert.notEqual(loser.charge.id, winner.charge.id);

    // BOTH receipts survive in storage; the winner's row is untouched.
    const stored = await repository.listIntelligenceCharges(routeRunId, charge.tenantId);
    assert.equal(stored.length, 2);
    const receipts = stored.map((entry) => entry.charge.x402ReceiptHash).sort();
    assert.deepEqual(receipts, [receiptHash(txHashA), receiptHash(txHashB)].sort());
    const storedWinner = stored.find((entry) => entry.charge.id === winner.charge.id);
    assert.equal(storedWinner?.charge.status, 'settled');
    assert.equal(storedWinner?.charge.serviceState, 'delivered');
    assert.equal(storedWinner?.charge.x402ReceiptHash, receiptHash(txHashA));
  });

  // --- T59 rework M2: tenant-wide replay ------------------------------------

  it('M2: a settlement receipt already bound to a charge in ANOTHER run of the same tenant is payment_replayed', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });
    const settlement = settledSettlement(`0x${'c'.repeat(64)}`);
    const foreignReceiptHash = stableHashV1('paid-intelligence-x402-receipt/v1', {
      txHash: settlement.txHash,
      payer: WALLET_ADDRESS,
      network: 'eip155:8453',
      amount: '10000',
    });
    const foreignCharge = chargeWithPaymentSettledV1(
      await pendingChargeFor('another-run', 'another-blueprint', 'idem-foreign-key'),
      { x402ReceiptHash: foreignReceiptHash, now: NOW.toISOString() },
    );

    // The tenant-wide lookup finds the foreign run's charge for this receipt.
    const tenantWideRepository = new Proxy(repository, {
      get(target, prop) {
        if (prop === 'findIntelligenceChargeByReceiptHash') {
          return async (_userId: string, hash: string) =>
            hash === foreignReceiptHash
              ? { charge: foreignCharge, evidenceId: null, spendPermissionId: null, x402ReceiptId: null }
              : null;
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof repository;

    await assert.rejects(
      runPaidSimulationV1(
        { repository: tenantWideRepository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
        {
          tenantId: charge.tenantId,
          walletAddress: WALLET_ADDRESS,
          routeRunId,
          blueprintId,
          settlement,
          existingCharge: charge,
        },
      ),
      (error: unknown) => error instanceof PaidSimulationBindingError && error.code === 'payment_replayed',
    );
    assert.equal(provider.callCount, 0);
  });

  // --- T59 rework N1: settlement amount verification -------------------------

  it('N1: a settlement amount that does not match the quoted price fails closed to settlement_amount_mismatch', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: { ...settledSettlement(), amount: '999' }, // quoted was 10000
        existingCharge: charge,
      },
    );
    assert.equal(result.outcome, 'paid_service_failed');
    if (result.outcome !== 'paid_service_failed') throw new Error('unreachable');
    assert.equal(result.reason, 'settlement_amount_mismatch');
    assert.equal(result.charge.status, 'reconciliation_required');
    assert.equal(result.charge.paymentState, 'settled');
    assert.equal(result.charge.serviceState, 'failed');
    // The receipt of the mismatched (but real) payment IS still recorded.
    assert.notEqual(result.charge.x402ReceiptHash, null);
    // The provider never ran on an unexpected amount.
    assert.equal(provider.callCount, 0);
  });

  it('N1: chargedCost and the paid evidence cost reflect the ACTUAL settled amount', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);
    const provider = mockProvider({ ok: true, body: SUCCESS_BODY });

    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(), // amount '10000' == quoted
        existingCharge: charge,
      },
    );
    assert.equal(result.outcome, 'simulated');
    if (result.outcome !== 'simulated') throw new Error('unreachable');
    assert.equal(result.charge.chargedCost?.amountAtomic, '10000');
    assert.equal(result.charge.chargedCost?.amountDecimal, '0.01');
    assert.equal(result.evidence.cost?.amountAtomic, '10000');
  });

  // --- T59 rework N2: provider response size bounds ---------------------------

  it('N2: an oversized stateChanges array (or oversized gasUsed) is invalid_response, never passed', async () => {
    const { repository, routeRunId, blueprintId } = await seedPaidSimulationFixture();
    const charge = await pendingChargeFor(routeRunId, blueprintId);
    await repository.insertIntelligenceCharge(routeRunId, charge);

    const oversizedStateChanges = Array.from({ length: 101 }, (_, index) => ({
      address: WALLET_ADDRESS,
      kind: 'balance' as const,
      summary: `change ${index}`,
    }));
    const provider = mockProvider({ ok: true, body: { ...SUCCESS_BODY, stateChanges: oversizedStateChanges } });
    const result = await runPaidSimulationV1(
      { repository, provider, now: () => NOW, price: SIMULATION_PRICE, chargeProvider: SIMULATION_PROVIDER_REF },
      {
        tenantId: charge.tenantId,
        walletAddress: WALLET_ADDRESS,
        routeRunId,
        blueprintId,
        settlement: settledSettlement(),
        existingCharge: charge,
      },
    );
    assert.equal(result.outcome, 'invalid_response');
    if (result.outcome !== 'invalid_response') throw new Error('unreachable');
    assert.notEqual(result.simulation.status, 'passed');

    assert.equal(
      SimulationProviderResponseV1Schema.safeParse({ ...SUCCESS_BODY, gasUsed: '1'.repeat(33) }).success,
      false,
    );
    assert.equal(
      SimulationProviderResponseV1Schema.safeParse(SUCCESS_BODY).success,
      true,
    );
  });
});
