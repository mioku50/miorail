import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createSwapRouteEngine } from '@mioagent/route-engine';
import {
  InMemoryRouteStorageRepository,
  createMemorySwapPendingIntentRepository,
  type SwapPendingIntentRepositoryV1,
  type SwapPendingIntentRowV1,
} from '@mioagent/route-storage';
import type { IntentResolutionV2, PendingSwapIntentV2 } from '@mioagent/intent-engine';
import { hashRouteIntentV1 } from '@mioagent/route-domain';
import {
  NOW,
  WALLET,
  routeCardCandidateFixture,
  routeCardFailedAdapterFixture,
  routeCardIntentFixture,
  routeCardQuotedAdapterFixture,
} from '../../../lib/route-card/test/fixtures.js';
import { createProviderRestV1, raiseVerificationDepthV1, RoutePlanCoordinator, timedSwapAdaptersV1 } from './routePlanCoordinator.js';

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

/** The engine's pending intent as the table holds it: same fields, minus the
 * schema tag the row does not carry. */
function pendingIntentRow(pending: PendingSwapIntentV2): SwapPendingIntentRowV1 {
  const { schemaVersion: _schemaVersion, ...row } = pending;
  return row;
}

function coordinatorFor(inputOptions: {
  repository?: InMemoryRouteStorageRepository;
  pendingIntents?: SwapPendingIntentRepositoryV1;
  resolution?: IntentResolutionV2;
  constrained?: boolean;
  degraded?: boolean;
  failed?: boolean;
  unpriced?: boolean;
}) {
  const repository = inputOptions.repository ?? new InMemoryRouteStorageRepository();
  const intent = inputOptions.resolution?.outcome === 'ready'
    ? inputOptions.resolution.routeIntent
    : routeCardIntentFixture(inputOptions.constrained);
  const uniswap = routeCardCandidateFixture(
    intent,
    'uniswap',
    '2026-07-15T12:03:00.000Z',
    inputOptions.unpriced ? null : '0.50',
  );
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
      pendingIntents: inputOptions.pendingIntents,
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

test('explicit unpriced provider persists a Route Card with Not-scored net result', async () => {
  const intent = routeCardIntentFixture(true);
  const { coordinator, repository } = coordinatorFor({
    constrained: true,
    unpriced: true,
    resolution: readyResolution(intent),
  });
  const result = await coordinator.evaluate({
    ...input,
    requestId: 'coordinator-constrained-unpriced-1',
  });
  assert.equal(result.outcome, 'evaluated');
  if (result.outcome !== 'evaluated') return;
  assert.equal(result.evaluation.outcome, 'constrained');
  assert.equal(result.evaluation.netResultMetrics[0]?.status, 'not_scored');
  assert.equal(result.projection.routeCardHash, result.routeCard?.routeCardHash);
  assert.ok(result.routeCard, 'the explicit provider choice must reach Review');
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

// ---------------------------------------------------------------------------
// The half-finished goal a clarification leaves behind.
//
// It is looked up by the AUTHENTICATED tenant and wallet and never travels
// through the client, so these tests assert what the coordinator does with the
// store rather than what any response carries.
// ---------------------------------------------------------------------------

function pendingIntentFixture(): PendingSwapIntentV2 {
  return {
    schemaVersion: 'pending-swap-intent/v2',
    tenantId: input.tenantId,
    walletAddress: WALLET,
    chainId: 8453,
    sourceRequestId: 'first-turn',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    amountDecimal: '100',
    fromAssetSymbol: 'USDC',
    toAssetSymbol: null,
    optimizationMode: null,
    verificationDepth: null,
    protocolConstraint: null,
    slippageMaxBps: 100,
    executionRequested: true,
  };
}

function clarificationResolution(pendingIntent: PendingSwapIntentV2 | null): IntentResolutionV2 {
  return {
    outcome: 'needs_clarification',
    routeIntent: null,
    clarification: {
      code: 'to_asset_required',
      message: 'Which exact token should be received?',
      missingFields: ['toAsset'],
      locale: 'en',
    },
    issues: [],
    pendingIntent,
  };
}

test('a clarification stores its half-finished goal for the next turn', async () => {
  const pendingIntents = createMemorySwapPendingIntentRepository();
  const coordinator = new RoutePlanCoordinator({
    llm: {} as never,
    engine: { evaluate: async () => { throw new Error('must not run'); } },
    adapters: [],
    repository: new InMemoryRouteStorageRepository(),
    pendingIntents,
    resolveIntent: async () => clarificationResolution(pendingIntentFixture()),
  });
  const result = await coordinator.evaluate({ ...input, requestId: 'clarify-1' });
  assert.equal(result.outcome, 'needs_clarification');
  const stored = await pendingIntents.readPendingIntent(
    { tenantId: input.tenantId, walletAddress: WALLET },
    NOW,
  );
  assert.equal(stored?.amountDecimal, '100');
  // The constraint the user stated, so answering the question cannot lose it.
  assert.equal(stored?.slippageMaxBps, 100);
  assert.equal(stored?.executionRequested, true);
});

test('a GMGN clarification keeps its explicit quote provider for the next turn', async () => {
  const pendingIntents = createMemorySwapPendingIntentRepository();
  const pending = { ...pendingIntentFixture(), protocolConstraint: { mode: 'include_only' as const, protocols: ['gmgn' as const] }, executionRequested: false };
  const coordinator = new RoutePlanCoordinator({
    llm: {} as never, engine: { evaluate: async () => { throw new Error('must not run'); } },
    adapters: [], repository: new InMemoryRouteStorageRepository(), pendingIntents,
    resolveIntent: async () => clarificationResolution(pending),
  });
  assert.equal((await coordinator.evaluate({ ...input, message: 'Get a GMGN quote for 100 USDC' })).outcome, 'needs_clarification');
  const stored = await pendingIntents.readPendingIntent({ tenantId: input.tenantId, walletAddress: WALLET }, NOW);
  assert.deepEqual(stored?.protocolConstraint, pending.protocolConstraint);
  assert.equal(stored?.executionRequested, false);
});

test('a stored goal reaches the resolver as authenticated context, not as input', async () => {
  const pendingIntents = createMemorySwapPendingIntentRepository();
  await pendingIntents.upsertPendingIntent(pendingIntentRow(pendingIntentFixture()));
  let seen: readonly PendingSwapIntentV2[] | undefined;
  const coordinator = new RoutePlanCoordinator({
    llm: {} as never,
    engine: { evaluate: async () => { throw new Error('must not run'); } },
    adapters: [],
    repository: new InMemoryRouteStorageRepository(),
    pendingIntents,
    resolveIntent: async (resolverInput) => {
      seen = resolverInput.context.pendingIntents;
      return clarificationResolution(null);
    },
  });
  await coordinator.evaluate({ ...input, message: 'ETH', requestId: 'clarify-2' });
  assert.equal(seen?.length, 1);
  assert.equal(seen?.[0]?.amountDecimal, '100');
  assert.equal(seen?.[0]?.slippageMaxBps, 100);
});

test('a resolved or refused goal clears the pending intent', async () => {
  for (const resolution of [readyResolution(), {
    outcome: 'rejected' as const,
    routeIntent: null,
    clarification: null,
    issues: [{ code: 'unsupported_goal' as const, field: 'goal', severity: 'rejection' as const, message: 'no' }],
    pendingIntent: null,
  }]) {
    const pendingIntents = createMemorySwapPendingIntentRepository();
    await pendingIntents.upsertPendingIntent(pendingIntentRow(pendingIntentFixture()));
    const { coordinator } = coordinatorFor({ resolution, pendingIntents });
    await coordinator.evaluate({ ...input, requestId: `clear-${resolution.outcome}` });
    // A finished goal that kept its pending intent would lend an amount and a
    // constraint to whatever the user asks next.
    assert.equal(
      await pendingIntents.readPendingIntent({ tenantId: input.tenantId, walletAddress: WALLET }, NOW),
      null,
    );
  }
});

test('a broken pending-intent store degrades the next turn, never this one', async () => {
  const broken = {
    readPendingIntent: async () => { throw new Error('pending storage unavailable'); },
    upsertPendingIntent: async () => { throw new Error('pending storage unavailable'); },
    clearPendingIntent: async () => { throw new Error('pending storage unavailable'); },
  };
  const coordinator = new RoutePlanCoordinator({
    llm: {} as never,
    engine: { evaluate: async () => { throw new Error('must not run'); } },
    adapters: [],
    repository: new InMemoryRouteStorageRepository(),
    pendingIntents: broken,
    resolveIntent: async () => clarificationResolution(pendingIntentFixture()),
  });
  // The clarification is the product; the continuation is a convenience.
  const result = await coordinator.evaluate({ ...input, requestId: 'broken-store' });
  assert.equal(result.outcome, 'needs_clarification');
});

// ---------------------------------------------------------------------------
// 2026-09-06 — the verification floor, and why it is safe to accept from a
// client on a request that otherwise accepts nothing.
//
// It moves in one direction. There is no value of it that asks for less
// checking, it reaches the plan only after the intent is grounded in the
// user's own words, and it names no asset, no amount and no route.
// ---------------------------------------------------------------------------
describe('a verification floor raises and never lowers', () => {
  test('a standard intent is raised to the floor', () => {
    assert.equal(raiseVerificationDepthV1('standard', 'enhanced'), 'enhanced');
  });

  test('a depth the reader already asked for is kept', () => {
    // Somebody who wrote "thoroughly" and got `maximum` must not be quietly
    // dropped to `enhanced` because a link carried a floor.
    assert.equal(raiseVerificationDepthV1('maximum', 'enhanced'), 'maximum');
    assert.equal(raiseVerificationDepthV1('enhanced', 'enhanced'), 'enhanced');
  });

  test('no floor changes nothing', () => {
    for (const depth of ['standard', 'enhanced', 'maximum'] as const) {
      assert.equal(raiseVerificationDepthV1(depth, undefined), depth);
    }
  });

  test('a raised run is stored, hashed at the depth it is checked at', async () => {
    // 2026-09-23. Every buy and sell from the Stocks card carries this floor,
    // and every one failed before any venue was asked: the depth was raised
    // AFTER the resolver hashed the intent, so storage refused the run as
    // tampered — "intentHash does not match the canonical V1 financial
    // payload". The function above was tested; the run it feeds never was.
    const { coordinator, repository, intent } = coordinatorFor({});
    assert.equal(intent.verificationDepth, 'standard');
    const result = await coordinator.evaluate({ ...input, requestId: 'floor-raised-1', minimumVerification: 'enhanced' });
    assert.equal(result.outcome, 'evaluated');
    const run = await repository.getRouteRun(intent.id, intent.tenantId);
    assert.ok(run);
    assert.equal(run.intent.verificationDepth, 'enhanced');
    assert.equal(run.intentHash, hashRouteIntentV1(run.intent));
    assert.notEqual(run.intentHash, intent.intentHash, 'a different depth is a different intent');
    // Nothing else about the goal moved: same pair, same amount.
    assert.deepEqual(
      { ...run.intent, verificationDepth: 'standard', intentHash: intent.intentHash },
      intent,
    );
  });
});

describe('the comparison says which provider it waited for', () => {
  test('each quote is timed under its own id, failures included, and nothing else changes', async () => {
    let clock = 0;
    const durations: Record<string, number> = {};
    const quoted = { outcome: 'unavailable', provider: 'kyberswap', errorCode: 'provider_no_route', retryable: false } as const;
    const [fast, broken] = timedSwapAdaptersV1(
      [
        { id: 'kyberswap', supports: () => true, quote: async () => { clock += 900; return quoted; } },
        { id: 'hydrex', supports: () => false, quote: async () => { clock += 6_300; throw new Error('boom'); } },
      ],
      durations,
      () => clock,
    );
    assert.equal(fast!.id, 'kyberswap');
    assert.equal(broken!.supports(routeCardIntentFixture()), false);
    assert.equal(await fast!.quote({} as never), quoted);
    await assert.rejects(() => broken!.quote({} as never), /boom/);
    assert.deepEqual(durations, { kyberswap: 900, hydrex: 6_300 });
  });
});

// 2026-11-11: Hydrex's API went dark on 11-09, and every comparison waited its whole ten seconds for it.
describe('a router that stopped answering rests', () => {
  const unreachable = { outcome: 'unavailable', provider: 'hydrex', errorCode: 'provider_unreachable', retryable: true } as const;
  const noRoute = { outcome: 'unavailable', provider: 'hydrex', errorCode: 'provider_no_route', retryable: false } as const;
  const free = { intent: { protocolConstraint: { mode: 'none', protocols: [] } } } as never;
  const named = { intent: { protocolConstraint: { mode: 'include_only', protocols: ['hydrex'] } } } as never;

  test('after two answers that never came it is not asked for five minutes, then asked once', async () => {
    let clock = 0, asked = 0, answer: typeof unreachable | typeof noRoute = unreachable;
    const rest = createProviderRestV1({ now: () => clock });
    const [hydrex] = rest.wrap([{ id: 'hydrex', supports: () => true, quote: async () => { asked += 1; return answer; } }]);
    assert.equal(await hydrex!.quote(free), unreachable);
    assert.deepEqual(rest.resting(), []);
    assert.equal(await hydrex!.quote(free), unreachable);
    assert.equal(asked, 2);
    assert.deepEqual(rest.resting(), ['hydrex']);
    // Resting: answered at once, with the same words, and the router is not asked.
    clock += 4 * 60_000;
    assert.deepEqual(await hydrex!.quote(free), unreachable);
    assert.equal(asked, 2);
    // The rest is over: one comparison asks, and one more silence rests it again at once.
    clock += 61_000;
    assert.equal(await hydrex!.quote(free), unreachable);
    assert.equal(asked, 3);
    assert.deepEqual(rest.resting(), ['hydrex']);
    // It answers again, with anything at all: it is asked every time from then on.
    clock += 5 * 60_000 + 1;
    answer = noRoute;
    assert.equal(await hydrex!.quote(free), noRoute);
    assert.equal(await hydrex!.quote(free), noRoute);
    assert.equal(asked, 5);
    assert.deepEqual(rest.resting(), []);
  });

  test('one silence is not a rest, a timeout counts as one, and a throttle or a refusal never does', async () => {
    let clock = 0;
    const answers: unknown[] = [
      unreachable, noRoute, { outcome: 'timeout', provider: 'hydrex', errorCode: 'provider_timeout', retryable: true },
      { outcome: 'rate_limited', provider: 'hydrex', errorCode: 'provider_rate_limited', retryable: true },
      { outcome: 'timeout', provider: 'hydrex', errorCode: 'provider_timeout', retryable: true }, unreachable,
    ];
    const rest = createProviderRestV1({ now: () => clock });
    const [hydrex] = rest.wrap([{ id: 'hydrex', supports: () => true, quote: async () => answers.shift() as never }]);
    for (const expected of [[], [], [], [], [], ['hydrex']]) {
      await hydrex!.quote(free);
      clock += 1_000;
      assert.deepEqual(rest.resting(), expected);
    }
  });

  test('a router the person asked for by name is always asked', async () => {
    let asked = 0;
    const rest = createProviderRestV1({ now: () => 0 });
    const [hydrex] = rest.wrap([{ id: 'hydrex', supports: () => true, quote: async () => { asked += 1; return unreachable; } }]);
    await hydrex!.quote(free);
    await hydrex!.quote(free);
    assert.deepEqual(rest.resting(), ['hydrex']);
    assert.equal(await hydrex!.quote(named), unreachable);
    assert.equal(asked, 3);
  });

  test('each router rests by itself', async () => {
    const rest = createProviderRestV1({ now: () => 0 });
    let kyber = 0;
    const [hydrex, kyberswap] = rest.wrap([
      { id: 'hydrex', supports: () => true, quote: async () => unreachable },
      { id: 'kyberswap', supports: () => true, quote: async () => { kyber += 1; return { ...noRoute, provider: 'kyberswap' } as never; } },
    ]);
    for (let i = 0; i < 3; i++) { await hydrex!.quote(free); await kyberswap!.quote(free); }
    assert.equal(kyber, 3);
    assert.deepEqual(rest.resting(), ['hydrex']);
  });
});

// 2026-11-12, Swap AI: "Swap USDC to PAXG", then "120". Both turns through the
// real resolver and the pending-intent store, as the page drives them.
test('gold over two turns: the pair is kept, and the answer finishes the goal', async () => {
  const pendingIntents = createMemorySwapPendingIntentRepository();
  const answers = [
    { goal: 'swap', amount: null, fromAsset: 'USDC', toAsset: 'PAXG', chainId: null },
    { goal: 'swap', amount: '120', fromAsset: null, toAsset: null, chainId: null },
  ];
  let evaluated: { fromAsset: unknown; toAsset: unknown; amount: { amountAtomic: string } } | null = null;
  const coordinator = new RoutePlanCoordinator({
    llm: { generate: async () => ({ message: { role: 'assistant', content: JSON.stringify(answers.shift()) } }) } as never,
    engine: {
      evaluate: async (request: { intent: typeof evaluated }) => {
        evaluated = request.intent;
        throw new Error('stop after the intent');
      },
    } as never,
    adapters: [],
    repository: new InMemoryRouteStorageRepository(),
    pendingIntents,
  });
  const first = await coordinator.evaluate({ ...input, message: 'Swap USDC to PAXG', requestId: 'gold-1' });
  assert.equal(first.outcome, 'needs_clarification');
  const stored = await pendingIntents.readPendingIntent({ tenantId: input.tenantId, walletAddress: WALLET }, NOW);
  assert.equal(stored?.fromAssetSymbol, 'USDC');
  assert.equal(stored?.toAssetSymbol, 'PAXG');

  await assert.rejects(
    () => coordinator.evaluate({ ...input, message: '120', requestId: 'gold-2', now: new Date(NOW.getTime() + 30_000) }),
    /stop after the intent/,
  );
  assert.equal((evaluated as { amount: { amountAtomic: string } } | null)?.amount.amountAtomic, '120000000');
  assert.equal((evaluated as { toAsset: { address: string } } | null)?.toAsset.address, '0xe904aea5e1b110c9174728fa2effc8aed19e98ef');
});

test('the registry, the pending-intent row and the table name the same assets', async () => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { TRUSTED_ASSET_SYMBOLS } = await import('@mioagent/intent-core');
  const { SWAP_PENDING_ASSET_SYMBOLS_V1 } = await import('@mioagent/route-storage');
  assert.deepEqual([...SWAP_PENDING_ASSET_SYMBOLS_V1], [...TRUSTED_ASSET_SYMBOLS]);
  // The runner starts this package's tests in artifacts/api-server.
  const root = process.cwd().endsWith('artifacts/api-server') ? resolve(process.cwd(), '../..') : process.cwd();
  const sql = await readFile(resolve(root, 'lib/db/drizzle/0098_swap_pending_intents_paxg.sql'), 'utf8');
  const lists = [...sql.matchAll(/IN \(([^)]*)\)/g)].map((match) => match[1]!.split(',').map((item) => item.trim().replace(/'/g, '')));
  assert.equal(lists.length, 2);
  for (const list of lists) assert.deepEqual(list, [...TRUSTED_ASSET_SYMBOLS]);
});
