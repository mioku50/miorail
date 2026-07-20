import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HashV1 } from '@mioagent/route-domain';
import { resolveBudgetSimulationIdempotencyV1 } from '../src/idempotency.js';
import {
  BUDGET_BLUEPRINT_FIXTURE,
  paymentPendingChargeFixture,
  reconciliationRequiredChargeFixture,
  releasedChargeFixture,
  reservedChargeFixture,
  settledChargeFixture,
} from './fixtures.js';

const CANDIDATE_HASH = BUDGET_BLUEPRINT_FIXTURE.selectedCandidateHash;
const OTHER_CANDIDATE_HASH = `0x${'9'.repeat(64)}` as HashV1;

describe('resolveBudgetSimulationIdempotencyV1', () => {
  it('is fresh when there is no existing charge for this key', () => {
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'fresh' });
  });

  it('is fresh when other charges exist but none share this idempotencyKey', () => {
    const other = settledChargeFixture({ id: 'charge-other', idempotencyKey: 'key-other' });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [other],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'fresh' });
  });

  it('is retry for a same-key charge still status "reserved" (crash before the provider ever ran)', () => {
    const reserved = reservedChargeFixture({ idempotencyKey: 'key-1' });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [reserved],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'retry');
    if (decision.kind !== 'retry') throw new Error('unreachable');
    assert.equal(decision.charge.id, reserved.id);
  });

  it('is retry for a same-key charge status "payment_pending" (evidence delivered, charge not yet attempted)', () => {
    const pending = paymentPendingChargeFixture({ idempotencyKey: 'key-1' });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [pending],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'retry');
    if (decision.kind !== 'retry') throw new Error('unreachable');
    assert.equal(decision.charge.id, pending.id);
  });

  it('is cached ONLY once status is "settled" with a non-null evidenceHash', () => {
    const settled = settledChargeFixture({ idempotencyKey: 'key-1' });
    assert.notEqual(settled.evidenceHash, null);
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [settled],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.equal(decision.kind, 'cached');
    if (decision.kind !== 'cached') throw new Error('unreachable');
    assert.equal(decision.charge.id, settled.id);
  });

  it('is conflict for a same-key charge status "released" (provider/evidence failure already released the reservation — never auto-retried)', () => {
    const released = releasedChargeFixture({ idempotencyKey: 'key-1' });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [released],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'conflict' });
  });

  it('is conflict for a same-key charge status "reconciliation_required" (must never be auto-retried per decision 5.8)', () => {
    const reconciling = reconciliationRequiredChargeFixture({ idempotencyKey: 'key-1' });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [reconciling],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'conflict' });
  });

  it('is conflict when the same idempotencyKey is bound to a DIFFERENT candidateHash', () => {
    const reserved = reservedChargeFixture({ idempotencyKey: 'key-1', candidateHash: OTHER_CANDIDATE_HASH });
    const decision = resolveBudgetSimulationIdempotencyV1({
      existingCharges: [reserved],
      candidateHash: CANDIDATE_HASH,
      idempotencyKey: 'key-1',
    });
    assert.deepEqual(decision, { kind: 'conflict' });
  });

  it('never returns cached for a "reserved" charge even if requested repeatedly (guards the T59 stuck-500 lesson)', () => {
    const reserved = reservedChargeFixture({ idempotencyKey: 'key-1' });
    for (let i = 0; i < 3; i += 1) {
      const decision = resolveBudgetSimulationIdempotencyV1({
        existingCharges: [reserved],
        candidateHash: CANDIDATE_HASH,
        idempotencyKey: 'key-1',
      });
      assert.notEqual(decision.kind, 'cached');
    }
  });
});
