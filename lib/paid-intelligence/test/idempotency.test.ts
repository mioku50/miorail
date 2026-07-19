import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HashV1 } from '@mioagent/route-domain';
import { resolvePaidSimulationIdempotencyV1 } from '../src/idempotency.js';
import {
  buildDuplicateSettlementChargeV1,
  buildPendingSimulationChargeV1,
  chargeWithEvidencePersistFailedV1,
  chargeWithEvidencePersistedV1,
  chargeWithPaymentSettledV1,
} from '../src/charges.js';
import { SIMULATION_PRICE, SIMULATION_PROVIDER_REF, T59_BLUEPRINT_FIXTURE, WALLET_ADDRESS } from './fixtures.js';

const NOW = '2026-07-19T12:00:00.000Z';
const CANDIDATE_HASH = T59_BLUEPRINT_FIXTURE.selectedCandidateHash;
const OTHER_CANDIDATE_HASH = `0x${'9'.repeat(64)}` as HashV1;

function pendingCharge(idempotencyKey: string) {
  return buildPendingSimulationChargeV1({
    routeRunId: 'run-1',
    blueprintId: 'blueprint-1',
    tenantId: T59_BLUEPRINT_FIXTURE.tenantId,
    walletAddress: WALLET_ADDRESS,
    intentHash: T59_BLUEPRINT_FIXTURE.intentHash,
    candidateHash: CANDIDATE_HASH,
    idempotencyKey,
    price: SIMULATION_PRICE,
    provider: SIMULATION_PROVIDER_REF,
    now: NOW,
  });
}

describe('resolvePaidSimulationIdempotencyV1', () => {
  it('proceeds to pay when there is no existing charge', () => {
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'pay', existingFailedCharge: null });
  });

  it('returns cached when the same idempotencyKey already delivered', () => {
    const delivered = chargeWithEvidencePersistedV1(
      chargeWithPaymentSettledV1(pendingCharge('key-1'), { x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1, now: NOW }),
      {
        chargedCost: SIMULATION_PRICE,
        evidenceHash: `0x${'b'.repeat(64)}` as HashV1,
        evidenceSetHash: `0x${'c'.repeat(64)}` as HashV1,
        serviceResponseHash: `0x${'d'.repeat(64)}` as HashV1,
        now: NOW,
      },
    );
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [delivered],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'cached');
  });

  it('retries the service (no new payment) when paymentState is settled but not yet delivered', () => {
    const settledNotDelivered = chargeWithPaymentSettledV1(pendingCharge('key-1'), {
      x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1,
      now: NOW,
    });
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [settledNotDelivered],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'retry_service');
  });

  it('reuses the same charge row (pay, existingFailedCharge set) on a same-key payment_pending retry', () => {
    const pending = pendingCharge('key-1');
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [pending],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'pay');
    if (decision.kind === 'pay') assert.equal(decision.existingFailedCharge?.id, pending.id);
  });

  it('rejects a different idempotencyKey while an active charge exists for the same blueprint (charge_conflict)', () => {
    const active = pendingCharge('key-1');
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [active],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-2',
    });
    assert.deepEqual(decision, { kind: 'conflict' });
  });

  it('does not conflict across different blueprints (different candidateHash)', () => {
    const active = pendingCharge('key-1');
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [active],
      candidateHash: OTHER_CANDIDATE_HASH,
      idempotencyKey: 'key-2',
    });
    assert.deepEqual(decision, { kind: 'pay', existingFailedCharge: null });
  });

  it('does not conflict with a delivered charge under a different key (already resolved, not active)', () => {
    const delivered = chargeWithEvidencePersistedV1(
      chargeWithPaymentSettledV1(pendingCharge('key-1'), { x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1, now: NOW }),
      {
        chargedCost: SIMULATION_PRICE,
        evidenceHash: `0x${'b'.repeat(64)}` as HashV1,
        evidenceSetHash: `0x${'c'.repeat(64)}` as HashV1,
        serviceResponseHash: `0x${'d'.repeat(64)}` as HashV1,
        now: NOW,
      },
    );
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [delivered],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-2',
    });
    assert.deepEqual(decision, { kind: 'pay', existingFailedCharge: null });
  });

  // --- T59 rework B1 ---------------------------------------------------------

  it('B1: delivered-with-NULL-evidenceHash (evidence_persist_failed) is retry_service, NEVER cached', () => {
    const persistFailed = chargeWithEvidencePersistFailedV1(
      chargeWithPaymentSettledV1(pendingCharge('key-1'), { x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1, now: NOW }),
      NOW,
    );
    assert.equal(persistFailed.serviceState, 'delivered');
    assert.equal(persistFailed.evidenceHash, null);
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [persistFailed],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'retry_service');
  });

  it('B1: the cached branch requires BOTH serviceState delivered AND a non-null evidenceHash', () => {
    const delivered = chargeWithEvidencePersistedV1(
      chargeWithPaymentSettledV1(pendingCharge('key-1'), { x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1, now: NOW }),
      {
        chargedCost: SIMULATION_PRICE,
        evidenceHash: `0x${'b'.repeat(64)}` as HashV1,
        evidenceSetHash: `0x${'c'.repeat(64)}` as HashV1,
        serviceResponseHash: `0x${'d'.repeat(64)}` as HashV1,
        now: NOW,
      },
    );
    assert.notEqual(delivered.evidenceHash, null);
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [delivered],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'cached');
  });

  // --- T59 rework M1 ---------------------------------------------------------

  it('M1: among several same-key rows (winner + duplicate-settlement ledger row) the durably delivered one serves the cache', () => {
    const settled = chargeWithPaymentSettledV1(pendingCharge('key-1'), {
      x402ReceiptHash: `0x${'a'.repeat(64)}` as HashV1,
      now: NOW,
    });
    const winner = chargeWithEvidencePersistedV1(settled, {
      chargedCost: SIMULATION_PRICE,
      evidenceHash: `0x${'b'.repeat(64)}` as HashV1,
      evidenceSetHash: `0x${'c'.repeat(64)}` as HashV1,
      serviceResponseHash: `0x${'d'.repeat(64)}` as HashV1,
      now: NOW,
    });
    const duplicate = buildDuplicateSettlementChargeV1(settled, {
      x402ReceiptHash: `0x${'e'.repeat(64)}` as HashV1,
      now: NOW,
    });
    assert.equal(duplicate.idempotencyKey, winner.idempotencyKey);
    // Order deliberately puts the duplicate FIRST — preference, not position,
    // must decide.
    const decision = resolvePaidSimulationIdempotencyV1({
      existingCharges: [duplicate, winner],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'cached');
    if (decision.kind === 'cached') assert.equal(decision.charge.id, winner.id);
  });
});
