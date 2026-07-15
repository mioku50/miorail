import assert from 'node:assert/strict';
import { canonicalJsonV1, type RouteCandidateV1, type RouteIntentV1 } from '@mioagent/route-domain';
import type {
  RouteStorageRepository,
  StoredBlueprintV1,
  StoredIntelligenceChargeV1,
} from '../src/index.js';
import type { RouteStorageFixtureGraph } from './fixture-graph.js';

export interface ContractLinks {
  preparedTransactionActionId?: string | null;
  x402ReceiptId?: string | null;
}

function byId<T extends { id: string }>(values: T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

export async function persistFixtureGraph(
  repository: RouteStorageRepository,
  graph: RouteStorageFixtureGraph,
  links: ContractLinks = {},
): Promise<void> {
  const runId = graph.intent.id;
  await repository.createRouteRun(graph.intent, `${runId}:idempotency`);
  await repository.insertCandidate(runId, graph.uniswapCandidate);
  await repository.insertCandidate(runId, graph.kyberSwapCandidate);

  for (const evidence of graph.completeEvidenceSet.records) {
    await repository.insertEvidence(runId, graph.uniswapCandidate.id, evidence);
  }
  await repository.insertEvidence(runId, graph.kyberSwapCandidate.id, graph.staleEvidence);
  await repository.insertEvidenceSet(runId, graph.uniswapCandidate.id, graph.completeEvidenceSet);
  await repository.insertEvidenceSet(
    runId,
    graph.uniswapCandidate.id,
    graph.missingSafetyEvidenceSet,
  );
  await repository.insertScoreSnapshot(runId, graph.uniswapCandidate.id, graph.pathScore);
  await repository.insertRouteCard(runId, graph.routeCard);
  await repository.insertBlueprint(runId, graph.blueprint, {
    preparedTransactionActionId: links.preparedTransactionActionId ?? null,
  });
  await repository.upsertProofProjection(runId, graph.completedProof);
  await repository.upsertProofProjection(runId, graph.partialFailureProof);
  for (const event of graph.proofEvents) {
    await repository.appendProofEvent(graph.completedProof.id, event);
  }
  await repository.insertIntelligenceCharge(runId, graph.intelligenceCharge, {
    evidenceId: graph.chargeEvidence.id,
    x402ReceiptId: links.x402ReceiptId ?? null,
  });
}

export async function assertFixtureGraphRoundTrip(
  repository: RouteStorageRepository,
  graph: RouteStorageFixtureGraph,
  links: ContractLinks = {},
): Promise<void> {
  const runId = graph.intent.id;
  const run = await repository.getRouteRun(runId, graph.intent.tenantId);
  assert.ok(run);
  assert.deepEqual(run.intent, graph.intent);
  assert.equal(run.intentHash, graph.intent.intentHash);

  const candidates = await repository.listCandidates(runId, graph.intent.tenantId);
  assert.deepEqual(byId(candidates), byId([graph.uniswapCandidate, graph.kyberSwapCandidate]));

  const evidence = await repository.listEvidence(runId, graph.intent.tenantId);
  assert.deepEqual(
    byId(evidence),
    byId([...graph.completeEvidenceSet.records, graph.staleEvidence]),
  );
  assert.ok(evidence.some((record) => record.evidenceHash === graph.staleEvidence.evidenceHash));
  assert.equal(
    evidence.find((record) => record.evidenceHash === graph.staleEvidence.evidenceHash)
      ?.validationStatus,
    'stale',
  );

  const evidenceSets = await repository.listEvidenceSets(runId, graph.intent.tenantId);
  assert.deepEqual(
    byId(evidenceSets),
    byId([graph.completeEvidenceSet, graph.missingSafetyEvidenceSet]),
  );

  const scores = await repository.listScoreSnapshots(runId, graph.intent.tenantId);
  assert.deepEqual(scores, [graph.pathScore]);
  assert.ok(scores[0]?.dimensions.every((dimension) => dimension.score === null));
  assert.ok(scores[0]?.dimensions.every((dimension) => dimension.status === 'not_scored'));

  const cards = await repository.listRouteCards(runId, graph.intent.tenantId);
  assert.deepEqual(cards, [graph.routeCard]);

  const blueprints = await repository.listBlueprints(runId, graph.intent.tenantId);
  assert.deepEqual(blueprints, [
    {
      blueprint: graph.blueprint,
      preparedTransactionActionId: links.preparedTransactionActionId ?? null,
    } satisfies StoredBlueprintV1,
  ]);

  assert.deepEqual(
    await repository.getProofProjection(graph.completedProof.id, graph.intent.tenantId),
    graph.completedProof,
  );
  assert.deepEqual(
    await repository.getProofProjection(graph.partialFailureProof.id, graph.intent.tenantId),
    graph.partialFailureProof,
  );
  assert.deepEqual(
    await repository.listProofEvents(graph.completedProof.id, graph.intent.tenantId),
    graph.proofEvents,
  );

  const charges = await repository.listIntelligenceCharges(runId, graph.intent.tenantId);
  assert.deepEqual(charges, [
    {
      charge: graph.intelligenceCharge,
      evidenceId: graph.chargeEvidence.id,
      spendPermissionId: graph.intelligenceCharge.spendPermissionId,
      x402ReceiptId: links.x402ReceiptId ?? null,
    } satisfies StoredIntelligenceChargeV1,
  ]);

  assert.equal(canonicalJsonV1(run.intent), canonicalJsonV1(graph.intent));
  assert.deepEqual(
    byId(candidates).map(canonicalJsonV1),
    byId([graph.uniswapCandidate, graph.kyberSwapCandidate]).map(canonicalJsonV1),
  );
}

export function duplicateRunIntent(intent: RouteIntentV1, id: string): RouteIntentV1 {
  return { ...intent, id };
}

export function duplicateCandidate(candidate: RouteCandidateV1, id: string): RouteCandidateV1 {
  return { ...candidate, id };
}
