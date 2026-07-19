import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
  IntelligenceChargeV1Schema,
  hashIntelligenceChargeV1,
  stableHashV1,
  type IntelligenceChargeV1,
  type RouteCandidateV1,
} from '@mioagent/route-domain';
import {
  InMemoryRouteStorageRepository,
  RouteStorageConflictError,
  RouteStorageIntegrityError,
} from '../src/index.js';
import { createRouteStorageFixtureGraph } from './fixture-graph.js';
import {
  assertFixtureGraphRoundTrip,
  duplicateCandidate,
  duplicateRunIntent,
  persistFixtureGraph,
} from './repository-contract.js';

function pendingChargeDraft(base: IntelligenceChargeV1, overrides: Partial<IntelligenceChargeV1> = {}): IntelligenceChargeV1 {
  const draft: IntelligenceChargeV1 = {
    ...base,
    id: 'charge-t59-pending',
    status: 'payment_pending',
    evidenceHash: null,
    evidenceSetHash: null,
    chargedCost: null,
    paymentState: 'pending',
    serviceState: 'not_started',
    x402ReceiptHash: null,
    serviceResponseHash: null,
    idempotencyKey: 'idem-t59-pending',
    ...overrides,
  };
  return IntelligenceChargeV1Schema.parse({ ...draft, chargeHash: hashIntelligenceChargeV1(draft) });
}

test('in-memory repository round-trips every T50 contract', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph, { x402ReceiptId: 'x402-receipt-link' });
  await assertFixtureGraphRoundTrip(repository, graph, {
    x402ReceiptId: 'x402-receipt-link',
  });
});

test('write validation rejects an invalid candidate before storage', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await repository.createRouteRun(graph.intent, 'invalid-write-run');
  const invalid = structuredClone(graph.uniswapCandidate) as RouteCandidateV1;
  invalid.expectedOutput.amountAtomic = '1';
  await assert.rejects(repository.insertCandidate(graph.intent.id, invalid));
  assert.deepEqual(await repository.listCandidates(graph.intent.id, graph.intent.tenantId), []);
});

test('reads validate stored payloads and fail closed on corrupt JSONB-equivalent data', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await repository.createRouteRun(graph.intent, 'corrupt-read-run');
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  repository.unsafeCorruptPayloadForTests('candidate', graph.uniswapCandidate.id, {
    schemaVersion: 'route-candidate/v1',
    id: graph.uniswapCandidate.id,
  });
  await assert.rejects(repository.listCandidates(graph.intent.id, graph.intent.tenantId));
});

test('tenant isolation hides route objects from another user', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await repository.createRouteRun(graph.intent, 'tenant-run');
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  assert.equal(await repository.getRouteRun(graph.intent.id, 'other-user'), null);
  assert.deepEqual(await repository.listCandidates(graph.intent.id, 'other-user'), []);
});

test('identical intent hashes create separate runs and candidate hashes may repeat across runs', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  const secondIntent = RouteIntentV1Schema.parse(
    duplicateRunIntent(graph.intent, `${graph.intent.id}:second`),
  );
  assert.equal(secondIntent.intentHash, graph.intent.intentHash);
  await repository.createRouteRun(graph.intent, 'same-intent-first');
  await repository.createRouteRun(secondIntent, 'same-intent-second');
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  const secondCandidate = RouteCandidateV1Schema.parse(
    duplicateCandidate(graph.uniswapCandidate, `${graph.uniswapCandidate.id}:second`),
  );
  await repository.insertCandidate(secondIntent.id, secondCandidate);
  assert.equal(secondCandidate.candidateHash, graph.uniswapCandidate.candidateHash);
  assert.equal((await repository.listCandidates(secondIntent.id, graph.intent.tenantId)).length, 1);
});

test('duplicate candidate is idempotent only when ID, hash, links, and payload match', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await repository.createRouteRun(graph.intent, 'duplicate-candidate-run');
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  assert.equal((await repository.listCandidates(graph.intent.id, graph.intent.tenantId)).length, 1);

  const conflicting = RouteCandidateV1Schema.parse(
    duplicateCandidate(graph.uniswapCandidate, `${graph.uniswapCandidate.id}:conflict`),
  );
  await assert.rejects(
    repository.insertCandidate(graph.intent.id, conflicting),
    RouteStorageConflictError,
  );
});

test('proof event history is append-only and rejects duplicate sequence', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph);
  await assert.rejects(
    repository.appendProofEvent(graph.completedProof.id, graph.proofEvents[0]!),
    RouteStorageConflictError,
  );
});

// --- T59: updateIntelligenceCharge ------------------------------------------

test('updateIntelligenceCharge transitions payment/service state and the run-scoped hash', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph);

  const pending = pendingChargeDraft(graph.intelligenceCharge);
  await repository.insertIntelligenceCharge(graph.intent.id, pending);
  const afterInsert = await repository.listIntelligenceCharges(graph.intent.id, graph.intent.tenantId);
  const storedPending = afterInsert.find((entry) => entry.charge.id === pending.id);
  assert.ok(storedPending);
  assert.equal(storedPending.charge.status, 'payment_pending');
  assert.equal(storedPending.evidenceId, null);

  const settledDraft: IntelligenceChargeV1 = {
    ...pending,
    status: 'settled',
    evidenceHash: graph.chargeEvidence.evidenceHash,
    evidenceSetHash: graph.completeEvidenceSet.evidenceSetHash,
    chargedCost: pending.quotedCost,
    paymentState: 'settled',
    serviceState: 'delivered',
    x402ReceiptHash: stableHashV1('t59-test-x402-receipt/v1', { txHash: '0xabc' }),
    serviceResponseHash: stableHashV1('t59-test-service-response/v1', { ok: true }),
    updatedAt: pending.updatedAt,
  };
  const settled = IntelligenceChargeV1Schema.parse({
    ...settledDraft,
    chargeHash: hashIntelligenceChargeV1(settledDraft),
  });
  assert.notEqual(settled.chargeHash, pending.chargeHash);

  await repository.updateIntelligenceCharge(graph.intent.id, pending.id, graph.intent.tenantId, settled, {
    evidenceId: graph.chargeEvidence.id,
  });

  const afterUpdate = await repository.listIntelligenceCharges(graph.intent.id, graph.intent.tenantId);
  const storedSettled = afterUpdate.find((entry) => entry.charge.id === pending.id);
  assert.ok(storedSettled);
  assert.deepEqual(storedSettled.charge, settled);
  assert.equal(storedSettled.evidenceId, graph.chargeEvidence.id);
});

test('updateIntelligenceCharge is idempotent on an identical repeat and fails closed otherwise', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph);
  const pending = pendingChargeDraft(graph.intelligenceCharge);
  await repository.insertIntelligenceCharge(graph.intent.id, pending);

  // Idempotent no-op: identical repeat does not throw and leaves state unchanged.
  await repository.updateIntelligenceCharge(graph.intent.id, pending.id, graph.intent.tenantId, pending);
  const afterNoop = await repository.listIntelligenceCharges(graph.intent.id, graph.intent.tenantId);
  assert.deepEqual(
    afterNoop.find((entry) => entry.charge.id === pending.id)?.charge,
    pending,
  );

  // Not found.
  await assert.rejects(
    repository.updateIntelligenceCharge(graph.intent.id, 'missing-charge', graph.intent.tenantId, pending),
    RouteStorageIntegrityError,
  );

  // Wrong tenant.
  await assert.rejects(
    repository.updateIntelligenceCharge(graph.intent.id, pending.id, 'other-tenant', pending),
    RouteStorageIntegrityError,
  );

  // Cannot change idempotencyKey mid-flight.
  const rekeyedDraft: IntelligenceChargeV1 = { ...pending, idempotencyKey: 'a-different-key' };
  const rekeyed = IntelligenceChargeV1Schema.parse({
    ...rekeyedDraft,
    chargeHash: hashIntelligenceChargeV1(rekeyedDraft),
  });
  await assert.rejects(
    repository.updateIntelligenceCharge(graph.intent.id, pending.id, graph.intent.tenantId, rekeyed),
    RouteStorageIntegrityError,
  );
});

// --- T59 rework M2: tenant-wide receipt lookup -------------------------------

test('findIntelligenceChargeByReceiptHash finds a tenant charge by receipt hash and isolates tenants', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph);

  const receiptHash = stableHashV1('t59-test-receipt-lookup/v1', { txHash: '0xdef' });
  // No charge carries this receipt hash yet.
  assert.equal(await repository.findIntelligenceChargeByReceiptHash(graph.intent.tenantId, receiptHash), null);

  const settledDraft: IntelligenceChargeV1 = {
    ...pendingChargeDraft(graph.intelligenceCharge),
    paymentState: 'settled',
    serviceState: 'pending',
    x402ReceiptHash: receiptHash,
  };
  const settled = IntelligenceChargeV1Schema.parse({
    ...settledDraft,
    chargeHash: hashIntelligenceChargeV1(settledDraft),
  });
  await repository.insertIntelligenceCharge(graph.intent.id, settled);

  const found = await repository.findIntelligenceChargeByReceiptHash(graph.intent.tenantId, receiptHash);
  assert.equal(found?.charge.id, settled.id);
  assert.equal(found?.charge.x402ReceiptHash, receiptHash);

  // Tenant isolation: another user never sees this receipt.
  assert.equal(await repository.findIntelligenceChargeByReceiptHash('other-tenant', receiptHash), null);
  // A different hash still finds nothing.
  assert.equal(
    await repository.findIntelligenceChargeByReceiptHash(
      graph.intent.tenantId,
      stableHashV1('t59-test-receipt-lookup/v1', { txHash: '0xother' }),
    ),
    null,
  );
});
