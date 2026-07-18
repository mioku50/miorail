import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteProofProjectionV1Schema,
  summarizeRouteProofEventsV1,
  toRouteProofProjectionV1,
} from '../src/projection.js';
import { buildApprovedBlueprint, buildEvidence, buildEvidenceSet, buildCandidate, buildIntent, buildPendingProof } from './fixtures.js';

test('projection: strips tenantId, approvedCalls, and raw payloads; stays user-safe', () => {
  const intent = buildIntent();
  const candidate = buildCandidate(intent);
  const evidence = buildEvidence(intent, candidate);
  const evidenceSet = buildEvidenceSet(intent, candidate, evidence);
  const blueprint = buildApprovedBlueprint({ intent, candidate, evidenceSet });
  const proof = buildPendingProof(blueprint);

  const projection = toRouteProofProjectionV1(proof, { blueprintId: blueprint.id, provider: 'uniswap' });
  assert.equal(RouteProofProjectionV1Schema.safeParse(projection).success, true);
  assert.equal(projection.provider, 'uniswap');
  assert.equal(projection.blueprintId, blueprint.id);
  assert.equal(projection.expectedOutput.amountAtomic, proof.expectedResult.outputAmountAtomic);
  assert.equal((projection as Record<string, unknown>).tenantId, undefined);
  assert.equal((projection as Record<string, unknown>).approvedCalls, undefined);
  assert.equal(projection.minimumOutput, proof.expectedResult.assetChanges.find((c) => c.direction === 'credit')!.minimumAmountAtomic);
});

test('projection: provider defaults to null when not supplied', () => {
  const intent = buildIntent();
  const candidate = buildCandidate(intent);
  const evidence = buildEvidence(intent, candidate);
  const evidenceSet = buildEvidenceSet(intent, candidate, evidence);
  const blueprint = buildApprovedBlueprint({ intent, candidate, evidenceSet });
  const proof = buildPendingProof(blueprint);
  const projection = toRouteProofProjectionV1(proof, { blueprintId: blueprint.id });
  assert.equal(projection.provider, null);
});

test('summarizeRouteProofEventsV1: strips payloads and hashes, keeps index/type/createdAt', () => {
  const summary = summarizeRouteProofEventsV1([
    { eventIndex: 0, eventType: 'calls_approved', createdAt: '2026-07-18T12:00:00.000Z' },
  ]);
  assert.deepEqual(summary, [{ eventIndex: 0, eventType: 'calls_approved', createdAt: '2026-07-18T12:00:00.000Z' }]);
});
