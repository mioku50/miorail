import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
  type RouteCandidateV1,
} from '@mioagent/route-domain';
import { InMemoryRouteStorageRepository, RouteStorageConflictError } from '../src/index.js';
import { createRouteStorageFixtureGraph } from './fixture-graph.js';
import {
  assertFixtureGraphRoundTrip,
  duplicateCandidate,
  duplicateRunIntent,
  persistFixtureGraph,
} from './repository-contract.js';

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
