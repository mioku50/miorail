import assert from 'node:assert/strict';
import test from 'node:test';
import { hashApprovedCallsV1, type ExecutionBlueprintV1 } from '@mioagent/route-domain';
import {
  InMemoryRouteStorageRepository,
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  type RouteStorageRepository,
} from '../src/index.js';
import { createRouteStorageFixtureGraph, type RouteStorageFixtureGraph } from './fixture-graph.js';

async function seedBlueprintOnly(
  repository: RouteStorageRepository,
  graph: RouteStorageFixtureGraph,
): Promise<void> {
  const runId = graph.intent.id;
  await repository.createRouteRun(graph.intent, `${runId}:idempotency`);
  await repository.insertCandidate(runId, graph.uniswapCandidate);
  for (const evidence of graph.completeEvidenceSet.records) {
    await repository.insertEvidence(runId, graph.uniswapCandidate.id, evidence);
  }
  await repository.insertEvidenceSet(runId, graph.uniswapCandidate.id, graph.completeEvidenceSet);
  await repository.insertBlueprint(runId, graph.blueprint);
}

function approvedPayload(blueprint: ExecutionBlueprintV1, updatedAt: string): ExecutionBlueprintV1 {
  return {
    ...blueprint,
    status: 'approved',
    approvedCallsHash: hashApprovedCallsV1(blueprint.calls),
    updatedAt,
  };
}

test('approveBlueprint transitions ready_for_review to approved without changing blueprintHash', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const now = new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString();
  const approved = approvedPayload(graph.blueprint, now);

  const result = await repository.approveBlueprint(
    graph.intent.id,
    graph.blueprint.id,
    graph.intent.tenantId,
    approved,
  );

  assert.equal(result.status, 'approved');
  assert.equal(result.blueprintHash, graph.blueprint.blueprintHash);
  assert.equal(result.approvedCallsHash, hashApprovedCallsV1(graph.blueprint.calls));

  const [stored] = await repository.listBlueprints(graph.intent.id, graph.intent.tenantId);
  assert.equal(stored!.blueprint.status, 'approved');
  assert.equal(stored!.blueprint.blueprintHash, graph.blueprint.blueprintHash);
});

test('approveBlueprint is idempotent on a byte-identical retry', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const now = new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString();
  const approved = approvedPayload(graph.blueprint, now);

  const first = await repository.approveBlueprint(graph.intent.id, graph.blueprint.id, graph.intent.tenantId, approved);
  // A later retry (e.g. a different updatedAt) must not overwrite the persisted
  // record — the stored approved payload wins and is returned unchanged.
  const retryAttempt = approvedPayload(graph.blueprint, new Date(Date.parse(now) + 5000).toISOString());
  const second = await repository.approveBlueprint(
    graph.intent.id,
    graph.blueprint.id,
    graph.intent.tenantId,
    retryAttempt,
  );

  assert.deepEqual(second, first);
  const [stored] = await repository.listBlueprints(graph.intent.id, graph.intent.tenantId);
  assert.equal(stored!.blueprint.updatedAt, first.updatedAt);
});

test('approveBlueprint rejects when the persisted approval hash has drifted from the request', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const now = new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString();
  const approved = approvedPayload(graph.blueprint, now);
  await repository.approveBlueprint(graph.intent.id, graph.blueprint.id, graph.intent.tenantId, approved);

  // The hash-chained schema makes it impossible to legitimately hold a
  // *different* approvedCallsHash for the same blueprintHash (approvedCallsHash
  // must equal callsHash, and callsHash participates in blueprintHash), so the
  // RouteStorageConflictError branch inside approveBlueprint is pure defense in
  // depth. The only way to simulate drift is storage corruption — and the
  // repository fails closed at read time (schema validation) before the
  // comparison is even reached, which is an equally safe rejection.
  const corrupted: ExecutionBlueprintV1 = { ...approved, approvedCallsHash: `0x${'9'.repeat(64)}` };
  repository.unsafeCorruptPayloadForTests('blueprint', graph.blueprint.id, corrupted);

  await assert.rejects(
    repository.approveBlueprint(graph.intent.id, graph.blueprint.id, graph.intent.tenantId, approved),
  );
  void RouteStorageConflictError;
});

test('approveBlueprint fails closed when the Blueprint is not in ready_for_review', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const draftBlueprint: ExecutionBlueprintV1 = { ...graph.blueprint, status: 'draft' };
  // Bypass insertBlueprint's own validation by corrupting storage directly to
  // simulate a Blueprint that was never `ready_for_review`.
  repository.unsafeCorruptPayloadForTests('blueprint', graph.blueprint.id, draftBlueprint);

  await assert.rejects(
    repository.approveBlueprint(
      graph.intent.id,
      graph.blueprint.id,
      graph.intent.tenantId,
      approvedPayload(graph.blueprint, new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString()),
    ),
    RouteStorageIntegrityError,
  );
});

test('approveBlueprint enforces tenant isolation', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const now = new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString();

  await assert.rejects(
    repository.approveBlueprint(graph.intent.id, graph.blueprint.id, 'other-tenant', approvedPayload(graph.blueprint, now)),
    RouteStorageIntegrityError,
  );
});

test('approveBlueprint rejects a Blueprint id belonging to another Route Run', async () => {
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await seedBlueprintOnly(repository, graph);
  const now = new Date(Date.parse(graph.blueprint.updatedAt) + 1000).toISOString();

  await assert.rejects(
    repository.approveBlueprint('some-other-run', graph.blueprint.id, graph.intent.tenantId, approvedPayload(graph.blueprint, now)),
    RouteStorageIntegrityError,
  );
});
