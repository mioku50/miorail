import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteCardV1Schema, canonicalJsonV1 } from '@mioagent/route-domain';
import {
  RoutePlanProjectionV1Schema,
  buildRouteCardV1,
  buildRoutePlanProjectionV1,
} from '../src/index.js';
import {
  constrainedEvaluation,
  degradedEvaluation,
  failedEvaluation,
  readyEvaluation,
} from './fixtures.js';

test('ready evaluation produces a valid canonical RouteCardV1', async () => {
  const evaluation = await readyEvaluation();
  const card = buildRouteCardV1(evaluation);
  assert.ok(card);
  assert.deepEqual(RouteCardV1Schema.parse(card), card);
  assert.equal(card.selectedCandidateHash, evaluation.recommendedCandidateHash);
  assert.match(card.recommendationReason, /after comparing multiple routes/);
});

test('constrained card uses honest non-global wording', async () => {
  const card = buildRouteCardV1(await constrainedEvaluation());
  assert.ok(card);
  assert.match(card.recommendationReason, /explicitly requested/);
  assert.match(card.recommendationReason, /not compared as the global best route/);
});

test('degraded and failed evaluations never produce a canonical Route Card', async () => {
  assert.equal(buildRouteCardV1(await degradedEvaluation()), null);
  assert.equal(buildRouteCardV1(await failedEvaluation()), null);
});

test('alternatives follow evaluation order and earliest displayed expiry wins', async () => {
  const evaluation = await readyEvaluation();
  const card = buildRouteCardV1(evaluation)!;
  assert.deepEqual(
    card.alternativeCandidates.map((candidate) => candidate.candidateHash),
    evaluation.alternativeCandidateHashes,
  );
  assert.equal(card.expiresAt, '2026-07-15T12:03:00.000Z');
});

test('UI projection hash and JSON are stable and contain no combined score', async () => {
  const evaluation = await readyEvaluation();
  const card = buildRouteCardV1(evaluation);
  const first = buildRoutePlanProjectionV1(evaluation, { routeCard: card, routeRunId: 'run-card' });
  const second = buildRoutePlanProjectionV1(evaluation, { routeCard: card, routeRunId: 'run-card' });
  assert.deepEqual(RoutePlanProjectionV1Schema.parse(first), first);
  assert.equal(first.projectionHash, second.projectionHash);
  assert.equal(canonicalJsonV1(first), canonicalJsonV1(second));
  assert.equal(canonicalJsonV1(first).includes('overallScore'), false);
});

test('degraded projection preserves available routes without recommendation styling data', async () => {
  const projection = buildRoutePlanProjectionV1(await degradedEvaluation(), { routeRunId: 'run-degraded' });
  assert.equal(projection.outcome, 'degraded');
  assert.equal(projection.recommendedRoute, null);
  assert.equal(projection.routeCardHash, null);
  assert.equal(projection.availableRoutes.length, 1);
  assert.equal(projection.readOnly, true);
});
