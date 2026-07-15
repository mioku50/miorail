import assert from 'node:assert/strict';
import test from 'node:test';
import { createSwapRouteEngine } from '@mioagent/route-engine';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import type { IntentResolutionV2 } from '@mioagent/intent-engine';
import {
  NOW,
  WALLET,
  routeCardCandidateFixture,
  routeCardFailedAdapterFixture,
  routeCardIntentFixture,
  routeCardQuotedAdapterFixture,
} from '../../../lib/route-card/test/fixtures.js';
import { RoutePlanCoordinator } from './routePlanCoordinator.js';

const input = {
  tenantId: 'tenant-card',
  walletAddress: WALLET,
  message: 'Swap 0.1 ETH to USDC using the best net result.',
  requestId: 'coordinator-ready-1',
  now: NOW,
} as const;

function readyResolution(routeIntent = routeCardIntentFixture()): IntentResolutionV2 {
  return {
    outcome: 'ready',
    routeIntent,
    clarification: null,
    issues: [],
    pendingIntent: null,
  };
}

function coordinatorFor(inputOptions: {
  repository?: InMemoryRouteStorageRepository;
  resolution?: IntentResolutionV2;
  constrained?: boolean;
  degraded?: boolean;
  failed?: boolean;
}) {
  const repository = inputOptions.repository ?? new InMemoryRouteStorageRepository();
  const intent = inputOptions.resolution?.outcome === 'ready'
    ? inputOptions.resolution.routeIntent
    : routeCardIntentFixture(inputOptions.constrained);
  const uniswap = routeCardCandidateFixture(intent, 'uniswap', '2026-07-15T12:03:00.000Z');
  const kyberswap = routeCardCandidateFixture(intent, 'kyberswap', '2026-07-15T12:04:00.000Z');
  const adapters = inputOptions.failed
    ? [routeCardFailedAdapterFixture('uniswap'), routeCardFailedAdapterFixture('kyberswap')]
    : inputOptions.degraded
      ? [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardFailedAdapterFixture('kyberswap')]
      : inputOptions.constrained
        ? [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardFailedAdapterFixture('kyberswap')]
        : [routeCardQuotedAdapterFixture('uniswap', uniswap), routeCardQuotedAdapterFixture('kyberswap', kyberswap)];
  const resolution = inputOptions.resolution ?? readyResolution(intent);
  return {
    repository,
    intent,
    coordinator: new RoutePlanCoordinator({
      llm: {} as never,
      engine: createSwapRouteEngine(),
      adapters,
      repository,
      resolveIntent: async () => resolution,
    }),
  };
}

test('ready coordinator persists only the T51 read-only graph and one canonical card', async () => {
  const { coordinator, repository, intent } = coordinatorFor({});
  const result = await coordinator.evaluate(input);
  assert.equal(result.outcome, 'evaluated');
  if (result.outcome !== 'evaluated') return;
  assert.equal(result.evaluation.outcome, 'ready');
  assert.ok(result.routeCard);
  assert.equal(result.projection.readOnly, true);
  assert.equal((await repository.listCandidates(intent.id, intent.tenantId)).length, 2);
  assert.equal(
    (await repository.listEvidence(intent.id, intent.tenantId)).length,
    result.evaluation.evidenceSets.flatMap((set) => set.records).length,
  );
  assert.equal((await repository.listEvidenceSets(intent.id, intent.tenantId)).length, 2);
  assert.equal((await repository.listScoreSnapshots(intent.id, intent.tenantId)).length, 2);
  assert.equal((await repository.listRouteCards(intent.id, intent.tenantId)).length, 1);
  assert.equal((await repository.listBlueprints(intent.id, intent.tenantId)).length, 0);
  assert.equal((await repository.listIntelligenceCharges(intent.id, intent.tenantId)).length, 0);
});

test('manual retry with the same request ID is idempotent across the full persisted graph', async () => {
  const { coordinator, repository, intent } = coordinatorFor({});
  const first = await coordinator.evaluate(input);
  const second = await coordinator.evaluate(input);
  assert.deepEqual(second, first);
  assert.equal(first.outcome, 'evaluated');
  if (first.outcome !== 'evaluated') return;
  assert.equal((await repository.listCandidates(intent.id, intent.tenantId)).length, 2);
  assert.equal(
    (await repository.listEvidence(intent.id, intent.tenantId)).length,
    first.evaluation.evidenceSets.flatMap((set) => set.records).length,
  );
  assert.equal((await repository.listEvidenceSets(intent.id, intent.tenantId)).length, 2);
  assert.equal((await repository.listScoreSnapshots(intent.id, intent.tenantId)).length, 2);
  assert.equal((await repository.listRouteCards(intent.id, intent.tenantId)).length, 1);
});

test('explicit protocol constraint persists an honest constrained card', async () => {
  const intent = routeCardIntentFixture(true);
  const { coordinator, repository } = coordinatorFor({ constrained: true, resolution: readyResolution(intent) });
  const result = await coordinator.evaluate({ ...input, requestId: 'coordinator-constrained-1' });
  assert.equal(result.outcome, 'evaluated');
  if (result.outcome !== 'evaluated') return;
  assert.equal(result.evaluation.outcome, 'constrained');
  assert.match(result.routeCard?.recommendationReason ?? '', /not compared as the global best route/);
  assert.equal((await repository.listRouteCards(intent.id, intent.tenantId)).length, 1);
});

test('degraded and failed evaluations never persist a fake Route Card', async () => {
  const degraded = coordinatorFor({ degraded: true });
  const degradedResult = await degraded.coordinator.evaluate({ ...input, requestId: 'coordinator-degraded-1' });
  assert.equal(degradedResult.outcome, 'evaluated');
  if (degradedResult.outcome !== 'evaluated') return;
  assert.equal(degradedResult.evaluation.outcome, 'degraded');
  assert.equal(degradedResult.routeCard, null);
  assert.equal(degradedResult.projection.recommendedRoute, null);
  assert.equal((await degraded.repository.listCandidates(degraded.intent.id, degraded.intent.tenantId)).length, 1);
  assert.equal((await degraded.repository.listRouteCards(degraded.intent.id, degraded.intent.tenantId)).length, 0);

  const failed = coordinatorFor({ failed: true });
  const failedResult = await failed.coordinator.evaluate({ ...input, requestId: 'coordinator-failed-1' });
  assert.equal(failedResult.outcome, 'evaluated');
  if (failedResult.outcome !== 'evaluated') return;
  assert.equal(failedResult.evaluation.outcome, 'failed');
  assert.equal(failedResult.routeCard, null);
  assert.equal((await failed.repository.listCandidates(failed.intent.id, failed.intent.tenantId)).length, 0);
  assert.equal((await failed.repository.listRouteCards(failed.intent.id, failed.intent.tenantId)).length, 0);
});

test('clarification and rejection do not create route runs or invoke providers', async () => {
  for (const resolution of [
    {
      outcome: 'needs_clarification', routeIntent: null,
      clarification: { code: 'amount_required', message: 'Amount required.', missingFields: ['amount'], locale: 'en' },
      issues: [], pendingIntent: null,
    },
    {
      outcome: 'rejected', routeIntent: null, clarification: null,
      issues: [{ code: 'server_signing_forbidden', field: 'message', severity: 'rejection', message: 'Signing forbidden.' }],
      pendingIntent: null,
    },
  ] as IntentResolutionV2[]) {
    const repository = new InMemoryRouteStorageRepository();
    let createCalls = 0;
    const originalCreate = repository.createRouteRun.bind(repository);
    repository.createRouteRun = async (...args) => {
      createCalls += 1;
      return originalCreate(...args);
    };
    let engineCalls = 0;
    const coordinator = new RoutePlanCoordinator({
      llm: {} as never,
      engine: { evaluate: async () => { engineCalls += 1; throw new Error('must not run'); } },
      adapters: [],
      repository,
      resolveIntent: async () => resolution,
    });
    const result = await coordinator.evaluate({ ...input, requestId: `early-${resolution.outcome}` });
    assert.equal(result.outcome, resolution.outcome);
    assert.equal(createCalls, 0);
    assert.equal(engineCalls, 0);
  }
});

test('route-run storage failure fails closed before provider evaluation', async () => {
  const repository = new InMemoryRouteStorageRepository();
  repository.createRouteRun = async () => { throw new Error('storage unavailable'); };
  let engineCalls = 0;
  const coordinator = new RoutePlanCoordinator({
    llm: {} as never,
    engine: { evaluate: async () => { engineCalls += 1; throw new Error('must not run'); } },
    adapters: [],
    repository,
    resolveIntent: async () => readyResolution(),
  });
  await assert.rejects(coordinator.evaluate(input), /storage unavailable/);
  assert.equal(engineCalls, 0);
});
