import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  RouteCardV1Schema,
  hashRouteCardV1,
  stableHashV1,
  ZERO_HASH_V1,
  type RouteCandidateV1,
  type RouteCardV1,
  type RouteIntentV1,
  type SimulationStateV1,
} from '@mioagent/route-domain';
import {
  AERODROME_PROVIDER_V1,
  AERODROME_ROUTER_V1,
  aerodromeSourceKeyV1,
  buildQuoteArtifacts,
  type AerodromeReaderV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import { AERODROME_BASE_ROUTER, decodeAerodromeSwapCalldata } from '@mioagent/security/aerodromeGuard';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';

import { AerodromeSwapBuildAdapter } from '../src/adapters/aerodrome.js';
import { approveExecutionBlueprintV1, routeProofIdV1 } from '../src/approval.js';
import { aerodromeKernelInputV1, createTransactionComposer } from '../src/coordinator.js';
import type { SwapBuildAdapter, SwapBuildInput, SwapBuildResultV1, SwapSimulationRequestV1 } from '../src/types.js';
import {
  ETH_BASE,
  NOW,
  TENANT,
  USDC_BASE,
  WALLET,
  WETH_BASE,
  makeEvidenceSet,
  makeIntent,
  makePathScore,
  passingContractSecurity,
  stubQuoteAdapter,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// T67B.1 — Aerodrome execution.
//
// Everything below turns on one fact: this server writes the calldata. There
// is no partner response to fall back on, so every number in the bytes has to
// be one this code put there deliberately, and every test here is either "it
// put the right one in" or "it refused rather than guess".
// ---------------------------------------------------------------------------

const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da' as const;
const OTHER_FACTORY = '0x0000000000000000000000000000000000001234' as const;
const USDC = USDC_BASE.address as `0x${string}`;
const WETH = WETH_BASE.address as `0x${string}`;
const AMOUNT_IN = 100_000_000n; // 100 USDC, matching the fixture intent.
const EXPECTED_OUT = 38_000_000_000_000_000n;

function leg(from: string, to: string, stable: boolean, factory = FACTORY): AerodromeRouteLegV1 {
  return { from: from as `0x${string}`, to: to as `0x${string}`, stable, factory };
}

const DIRECT_VOLATILE = [leg(USDC, WETH, false)];
const DIRECT_STABLE = [leg(USDC, WETH, true)];

function reader(overrides: Partial<AerodromeReaderV1> = {}): AerodromeReaderV1 {
  return {
    async readDefaultFactory() {
      return { ok: true, value: FACTORY };
    },
    async readAmountsOut(input) {
      return { ok: true, value: [input.amountIn, EXPECTED_OUT] };
    },
    async readBlockNumber() {
      return '33123456';
    },
    async readAllowance() {
      return { ok: true, value: 0n };
    },
    ...overrides,
  };
}

/** An Aerodrome candidate whose liquidity source keys carry `route`. */
function aerodromeCandidate(
  intent: RouteIntentV1,
  route: readonly AerodromeRouteLegV1[],
  overrides: { expectedOutputAtomic?: string; requestId?: string } = {},
) {
  const expectedOutputAtomic = overrides.expectedOutputAtomic ?? EXPECTED_OUT.toString();
  const requestId = overrides.requestId ?? 'aerodrome-request';
  return buildQuoteArtifacts({
    adapterId: 'aerodrome',
    intent,
    provider: AERODROME_PROVIDER_V1,
    requestId,
    providerQuoteId: null,
    requestHash: stableHashV1('fixture/request/v1', { requestId, route: [...route] }),
    responseHash: stableHashV1('fixture/response/v1', { requestId, expectedOutputAtomic }),
    expectedOutputAtomic,
    providerMinimumOutputAtomic: null,
    gas: { gasUnits: '180000', maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null },
    priceImpactBps: 0,
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    blockNumber: '33123456',
    provenance: {
      pools: [],
      liquiditySources: route.map((entry) => ({
        sourceKey: aerodromeSourceKeyV1(entry),
        chainId: 8453,
        protocol: entry.stable ? 'aerodrome-stable' : 'aerodrome-volatile',
        poolAddress: null,
        assets: [intent.fromAsset!, intent.toAsset!],
        upstreamProvider: null,
      })),
    },
    riskFlags: ['price_impact_unmeasured'],
    usesExternalAggregators: false,
    sourceIndependence: 'independent',
  });
}

function buildInput(
  intent: RouteIntentV1,
  reviewed: RouteCandidateV1,
  fresh: RouteCandidateV1 = reviewed,
): SwapBuildInput {
  return {
    intent,
    selectedCandidate: fresh,
    reviewedCandidate: reviewed,
    walletAddress: WALLET,
    now: NOW,
    requestId: 'req-aerodrome-1',
  };
}

async function built(result: SwapBuildResultV1) {
  assert.equal(result.outcome, 'built', `expected a build, got ${JSON.stringify(result)}`);
  if (result.outcome !== 'built') throw new Error('unreachable');
  return result;
}

// ---------------------------------------------------------------------------
// The build adapter
// ---------------------------------------------------------------------------

describe('the Aerodrome build adapter encodes the reviewed route', () => {
  test('a volatile direct route becomes exact approve + swap, in that order', async () => {
    // ERC-20 in, ERC-20 out. The fixture default asks for native ETH out,
    // which is a different Router entrypoint — covered further down.
    const intent = makeIntent({ toAsset: WETH_BASE });
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await built(
      await new AerodromeSwapBuildAdapter({ reader: reader() }).build(buildInput(intent, candidate)),
    );

    assert.equal(result.routerAddress, AERODROME_ROUTER_V1);
    assert.equal(result.calls.length, 2);
    const [approve, swap] = result.calls;
    assert.equal(approve!.to, USDC);
    assert.equal(approve!.value, '0');
    assert.equal(approve!.data.slice(0, 10), '0x095ea7b3');
    assert.equal(BigInt(`0x${approve!.data.slice(74)}`), AMOUNT_IN, 'the approval is exactly the input amount');
    assert.equal(
      `0x${approve!.data.slice(34, 74)}`,
      AERODROME_ROUTER_V1,
      'and it names only the pinned Router as spender',
    );
    assert.equal(swap!.to, AERODROME_ROUTER_V1);
    assert.equal(swap!.value, '0');

    // The guard's INDEPENDENT decoder has to agree with what was encoded.
    const decoded = decodeAerodromeSwapCalldata(swap!.data);
    assert.ok(decoded);
    assert.equal(decoded.kind, 'tokens_for_tokens');
    assert.equal(decoded.amountIn, AMOUNT_IN);
    assert.equal(decoded.to, WALLET);
    assert.deepEqual(decoded.route, [{ from: USDC, to: WETH, stable: false, factory: FACTORY }]);
    assert.equal(decoded.amountOutMin, BigInt(result.minimumOutput.amountAtomic));
    assert.ok(decoded.deadline * 1000n > BigInt(NOW.getTime()), 'the deadline outlives the build');
  });

  test('a stable direct route keeps its curve into the calldata', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_STABLE);
    const result = await built(
      await new AerodromeSwapBuildAdapter({ reader: reader() }).build(buildInput(intent, candidate)),
    );
    const decoded = decodeAerodromeSwapCalldata(result.calls[1]!.data);
    assert.deepEqual(decoded?.route, [{ from: USDC, to: WETH, stable: true, factory: FACTORY }]);
  });

  test('a two-hop route survives with both legs and both curves', async () => {
    const intent = makeIntent();
    const middle = '0x0000000000000000000000000000000000009999';
    const route = [leg(USDC, middle, true), leg(middle, WETH, false)];
    const { candidate } = aerodromeCandidate(intent, route);
    const result = await built(
      await new AerodromeSwapBuildAdapter({ reader: reader() }).build(buildInput(intent, candidate)),
    );
    const decoded = decodeAerodromeSwapCalldata(result.calls[1]!.data);
    assert.equal(decoded?.route.length, 2);
    assert.deepEqual(
      decoded?.route.map((entry) => entry.stable),
      [true, false],
    );
  });

  test('the reviewed minimum is a floor, not a starting point', async () => {
    // The fresh quote decayed: still above the reviewed MINIMUM, but a minimum
    // re-derived from it would sit below the floor the user approved.
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const reviewedMinimum = BigInt(candidate.minimumOutput.amountAtomic);
    const decayed = reviewedMinimum + 1n;
    const result = await built(
      await new AerodromeSwapBuildAdapter({
        reader: reader({
          async readAmountsOut(input) {
            return { ok: true, value: [input.amountIn, decayed] };
          },
        }),
      }).build(buildInput(intent, candidate)),
    );
    const decoded = decodeAerodromeSwapCalldata(result.calls[1]!.data);
    assert.equal(BigInt(result.minimumOutput.amountAtomic), reviewedMinimum);
    assert.equal(decoded?.amountOutMin, reviewedMinimum);
  });

  test('an output that can no longer clear the reviewed floor is refused', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const belowFloor = BigInt(candidate.minimumOutput.amountAtomic) - 1n;
    const result = await new AerodromeSwapBuildAdapter({
      reader: reader({
        async readAmountsOut(input) {
          return { ok: true, value: [input.amountIn, belowFloor] };
        },
      }),
    }).build(buildInput(intent, candidate));
    assert.equal(result.outcome, 'expired');
    if (result.outcome === 'expired') assert.equal(result.errorCode, 'aerodrome_output_below_minimum');
  });
});

describe('the Aerodrome build adapter refuses rather than substitute', () => {
  test('a route that moved between the card and prepare', async () => {
    const intent = makeIntent();
    const { candidate: reviewed } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    // The re-quote now prefers the stable pool. Better price, different pool,
    // and not the trade anyone looked at.
    const { candidate: fresh } = aerodromeCandidate(intent, DIRECT_STABLE, { requestId: 'fresh' });
    const result = await new AerodromeSwapBuildAdapter({ reader: reader() }).build(
      buildInput(intent, reviewed, fresh),
    );
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.errorCode, 'aerodrome_route_changed');
  });

  test('a Router that has changed its default factory', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await new AerodromeSwapBuildAdapter({
      reader: reader({
        async readDefaultFactory() {
          return { ok: true, value: OTHER_FACTORY };
        },
      }),
    }).build(buildInput(intent, candidate));
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.errorCode, 'aerodrome_factory_changed');
  });

  test('a reviewed route that is no longer quotable', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await new AerodromeSwapBuildAdapter({
      reader: reader({
        async readAmountsOut() {
          return { ok: false, reason: 'no_route' };
        },
      }),
    }).build(buildInput(intent, candidate));
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.errorCode, 'aerodrome_route_unavailable');
  });

  test('an allowance it could not read', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await new AerodromeSwapBuildAdapter({
      reader: reader({
        async readAllowance() {
          return { ok: false, reason: 'invalid_response' };
        },
      }),
    }).build(buildInput(intent, candidate));
    assert.equal(result.outcome, 'unavailable');
    if (result.outcome === 'unavailable') assert.equal(result.errorCode, 'aerodrome_allowance_unreadable');
  });

  test('a candidate whose liquidity sources are not Aerodrome route keys', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const tampered = {
      ...candidate,
      liquiditySources: [{ ...candidate.liquiditySources[0]!, sourceKey: 'uniswap:v3:0.05%' }],
    } as RouteCandidateV1;
    const result = await new AerodromeSwapBuildAdapter({ reader: reader() }).build(
      buildInput(intent, tampered, tampered),
    );
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.errorCode, 'aerodrome_reviewed_route_unreadable');
  });

  test('a prepare with no reviewed candidate at all', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await new AerodromeSwapBuildAdapter({ reader: reader() }).build({
      ...buildInput(intent, candidate),
      reviewedCandidate: undefined,
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.errorCode, 'aerodrome_reviewed_candidate_missing');
  });

  test('no RPC endpoint means not_configured, not a guess', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await new AerodromeSwapBuildAdapter({ rpcUrl: '  ' }).build(buildInput(intent, candidate));
    assert.equal(result.outcome, 'not_configured');
  });
});

describe('native ETH legs pick a different entrypoint', () => {
  test('ETH in carries the amount as value and emits no approval', async () => {
    const intent = makeIntent({ fromAsset: ETH_BASE, toAsset: USDC_BASE, amountDecimal: '1' });
    const route = [leg(WETH, USDC, false)];
    const { candidate } = aerodromeCandidate(intent, route, { expectedOutputAtomic: '3800000000' });
    const result = await built(
      await new AerodromeSwapBuildAdapter({
        reader: reader({
          async readAmountsOut(input) {
            return { ok: true, value: [input.amountIn, 3_800_000_000n] };
          },
        }),
      }).build(buildInput(intent, candidate)),
    );
    assert.equal(result.calls.length, 1, 'native ETH needs no approval');
    assert.equal(result.calls[0]!.to, AERODROME_ROUTER_V1);
    assert.equal(result.calls[0]!.value, intent.amount.amountAtomic);
    assert.equal(decodeAerodromeSwapCalldata(result.calls[0]!.data)?.kind, 'eth_for_tokens');
    assert.equal(result.aerodrome?.inputIsNative, true);
    assert.equal(result.aerodrome?.observedAllowanceAtomic, null);
  });

  test('ETH out still approves the token going in', async () => {
    const intent = makeIntent({ toAsset: ETH_BASE });
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const result = await built(
      await new AerodromeSwapBuildAdapter({ reader: reader() }).build(buildInput(intent, candidate)),
    );
    assert.equal(result.calls.length, 2);
    assert.equal(decodeAerodromeSwapCalldata(result.calls[1]!.data)?.kind, 'tokens_for_eth');
    assert.equal(result.aerodrome?.outputIsNative, true);
  });

  test('a standing allowance is read and overwritten anyway', async () => {
    const intent = makeIntent();
    const { candidate } = aerodromeCandidate(intent, DIRECT_VOLATILE);
    const unlimited = (1n << 256n) - 1n;
    const result = await built(
      await new AerodromeSwapBuildAdapter({
        reader: reader({
          async readAllowance() {
            return { ok: true, value: unlimited };
          },
        }),
      }).build(buildInput(intent, candidate)),
    );
    assert.equal(result.calls.length, 2, 'a leftover unlimited grant is reduced, not reused');
    assert.equal(BigInt(`0x${result.calls[0]!.data.slice(74)}`), AMOUNT_IN);
    assert.equal(result.aerodrome?.observedAllowanceAtomic, unlimited.toString());
  });
});

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

function aerodromeCard(intent: RouteIntentV1, candidate: RouteCandidateV1, evidenceSetHash: string, pathScoreHash: string): RouteCardV1 {
  const draft: RouteCardV1 = {
    schemaVersion: 'route-card/v1',
    id: 'route-card-aerodrome',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'ready',
    intentHash: intent.intentHash,
    selectedCandidateHash: candidate.candidateHash,
    evidenceSetHash: evidenceSetHash as `0x${string}`,
    pathScoreHash: pathScoreHash as `0x${string}`,
    routeCardHash: ZERO_HASH_V1,
    recommendedCandidate: candidate,
    alternativeCandidates: [],
    pathScore: undefined as never,
    evidenceSummary: { recordCount: 1, paidCostUsd: '0', missingEvidence: [], sourceIndependence: 'independent' },
    recommendationReason: 'Fixture: Aerodrome recommended for T67B.1 tests.',
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  };
  return draft;
}

interface Scene {
  intent: RouteIntentV1;
  candidate: RouteCandidateV1;
  card: RouteCardV1;
  repository: InMemoryRouteStorageRepository;
}

async function scene(route: readonly AerodromeRouteLegV1[] = DIRECT_VOLATILE): Promise<Scene> {
  const intent = makeIntent();
  const { candidate, evidence } = aerodromeCandidate(intent, route);
  const evidenceSet = makeEvidenceSet(intent, candidate, evidence);
  const pathScore = makePathScore(intent, candidate, evidenceSet);
  const draft = {
    ...aerodromeCard(intent, candidate, evidenceSet.evidenceSetHash, pathScore.pathScoreHash),
    pathScore,
  };
  const card = RouteCardV1Schema.parse({ ...draft, routeCardHash: hashRouteCardV1(draft) });

  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(intent, 'idempotency-aerodrome');
  await repository.insertCandidate(intent.id, candidate);
  await repository.insertEvidence(intent.id, candidate.id, evidence);
  await repository.insertEvidenceSet(intent.id, candidate.id, evidenceSet);
  await repository.insertScoreSnapshot(intent.id, candidate.id, pathScore);
  await repository.insertRouteCard(intent.id, card);
  return { intent, candidate, card, repository };
}

const PASSED_SIMULATION: SimulationStateV1 = {
  status: 'passed',
  observedAt: NOW.toISOString(),
  blockNumber: '33123456',
  requestHash: stableHashV1('test/sim-request', { ok: true }),
  responseHash: stableHashV1('test/sim-response', { ok: true }),
  errorCode: null,
};

function aerodromeQuoteAdapter(intent: RouteIntentV1, route: readonly AerodromeRouteLegV1[]) {
  return stubQuoteAdapter('aerodrome', async () => {
    const { candidate, evidence } = aerodromeCandidate(intent, route, { requestId: 'fresh-requote' });
    return { outcome: 'quoted', candidate, evidence: [evidence] };
  });
}

function composerFor(
  s: Scene,
  options: {
    simulate?: (input: SwapSimulationRequestV1) => Promise<SimulationStateV1>;
    supportedProviders?: readonly ('uniswap' | 'kyberswap' | 'aerodrome')[];
    buildAdapter?: SwapBuildAdapter;
    quoteRoute?: readonly AerodromeRouteLegV1[];
  } = {},
) {
  return createTransactionComposer({
    repository: s.repository,
    buildAdapters: [options.buildAdapter ?? new AerodromeSwapBuildAdapter({ reader: reader() })],
    quoteAdapters: [aerodromeQuoteAdapter(s.intent, options.quoteRoute ?? DIRECT_VOLATILE)],
    supportedProviders: options.supportedProviders ?? ['uniswap', 'kyberswap', 'aerodrome'],
    simulate: options.simulate ?? (async () => PASSED_SIMULATION),
    contractSecurity: passingContractSecurity(),
    now: () => NOW,
  });
}

function prepareInput(s: Scene, requestId = 'req-1') {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: s.intent.id,
    routeCardHash: s.card.routeCardHash,
    selectedCandidateHash: s.candidate.candidateHash,
    requestId,
    now: NOW,
  };
}

describe('the composer prepares Aerodrome only under its own conditions', () => {
  test('a simulated, guarded batch reaches the review screen', async () => {
    const s = await scene();
    const result = await composerFor(s).prepare(prepareInput(s));
    assert.equal(result.outcome, 'prepared', JSON.stringify(result));
    if (result.outcome !== 'prepared') return;

    assert.equal(result.blueprint.simulationState.status, 'passed');
    assert.equal(result.blueprint.calls.length, 2);
    assert.equal(result.blueprint.calls[0]!.callType, 'approval');
    assert.equal(result.blueprint.calls[1]!.callType, 'swap');
    assert.equal(result.blueprint.calls[1]!.to, AERODROME_ROUTER_V1);
    assert.equal(result.blueprint.requiredApprovals.length, 1);
    assert.equal(result.blueprint.requiredApprovals[0]!.approvalKind, 'exact');
    assert.equal(result.blueprint.requiredApprovals[0]!.amountAtomic, AMOUNT_IN.toString());
    assert.equal(result.blueprint.requiredApprovals[0]!.spender, AERODROME_ROUTER_V1);
    assert.equal(result.blueprint.atomicRequired, true);

    const guard = result.review.safety.checks.find((entry) => entry.id === 'provider_guard_aerodrome');
    assert.equal(guard?.status, 'passed', guard?.detail ?? '');
    assert.equal(result.review.simulationState.blockNumber, '33123456');
  });

  test('with the execution flag off it is unsupported, not an error', async () => {
    const s = await scene();
    const result = await composerFor(s, { supportedProviders: ['uniswap', 'kyberswap'] }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'unsupported');
    if (result.outcome === 'unsupported') assert.equal(result.reason, 'unsupported_provider');
  });

  test('an unavailable simulation blocks — it is never read as a pass', async () => {
    const s = await scene();
    const result = await composerFor(s, {
      simulate: async () => ({
        status: 'unavailable',
        observedAt: NOW.toISOString(),
        blockNumber: null,
        requestHash: null,
        responseHash: null,
        errorCode: 'provider_not_configured',
      }),
    }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const check = result.safety.checks.find((entry) => entry.id === 'simulation_evidence');
    assert.equal(check?.status, 'failed');
    assert.match(check?.detail ?? '', /must simulate/);
  });

  test('with no simulation provider wired at all it still blocks', async () => {
    const s = await scene();
    const composer = createTransactionComposer({
      repository: s.repository,
      buildAdapters: [new AerodromeSwapBuildAdapter({ reader: reader() })],
      quoteAdapters: [aerodromeQuoteAdapter(s.intent, DIRECT_VOLATILE)],
      supportedProviders: ['aerodrome'],
      contractSecurity: passingContractSecurity(),
      now: () => NOW,
    });
    const result = await composer.prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
  });

  test('a reverting simulation blocks and says so', async () => {
    const s = await scene();
    const result = await composerFor(s, {
      simulate: async () => ({
        status: 'failed',
        observedAt: NOW.toISOString(),
        blockNumber: '33123456',
        requestHash: stableHashV1('test/sim-request', { ok: false }),
        responseHash: stableHashV1('test/sim-response', { ok: false }),
        errorCode: 'reverted',
      }),
    }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const check = result.safety.checks.find((entry) => entry.id === 'simulation_evidence');
    assert.match(check?.detail ?? '', /reverts in simulation/);
  });

  test('a moved route is reported as route_changed, not as an expired quote', async () => {
    const s = await scene(DIRECT_VOLATILE);
    const result = await composerFor(s, { quoteRoute: DIRECT_STABLE }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'refresh_required');
    if (result.outcome === 'refresh_required') assert.equal(result.reason, 'route_changed');
  });

  test('a build that weakened the minimum output is blocked by the Safety Kernel', async () => {
    // A build adapter that agrees with itself: its own reported minimum
    // matches its calldata. Only the Route Card the user looked at can catch
    // this, which is exactly what the kernel is handed.
    const s = await scene();
    const honest = new AerodromeSwapBuildAdapter({ reader: reader() });
    const weakening: SwapBuildAdapter = {
      id: 'aerodrome',
      async build(input) {
        const result = await honest.build(input);
        if (result.outcome !== 'built') return result;
        const weaker = (BigInt(input.reviewedCandidate!.minimumOutput.amountAtomic) - 1n).toString();
        const inner = await new AerodromeSwapBuildAdapter({ reader: reader() }).build(input);
        if (inner.outcome !== 'built') return inner;
        return {
          ...inner,
          calls: [
            inner.calls[0]!,
            {
              ...inner.calls[1]!,
              data: rewriteMinimum(inner.calls[1]!.data, BigInt(weaker)),
            },
          ],
          minimumOutput: { ...inner.minimumOutput, amountAtomic: weaker },
        } satisfies SwapBuildResultV1;
      },
    };
    const result = await composerFor(s, { buildAdapter: weakening }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const guard = result.safety.checks.find((entry) => entry.id === 'provider_guard_aerodrome');
    assert.equal(guard?.status, 'failed');
    assert.match(guard?.detail ?? '', /minimum_output_weakened/);
  });

  test('a batch that pays someone else is blocked', async () => {
    const s = await scene();
    const honest = new AerodromeSwapBuildAdapter({ reader: reader() });
    const redirecting: SwapBuildAdapter = {
      id: 'aerodrome',
      async build(input: SwapBuildInput) {
        const inner = await honest.build(input);
        if (inner.outcome !== 'built') return inner;
        const attacker = '0x2222222222222222222222222222222222222222';
        return {
          ...inner,
          calls: [inner.calls[0]!, { ...inner.calls[1]!, data: rewriteRecipient(inner.calls[1]!.data, attacker) }],
        } satisfies SwapBuildResultV1;
      },
    };
    const result = await composerFor(s, { buildAdapter: redirecting }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const guard = result.safety.checks.find((entry) => entry.id === 'provider_guard_aerodrome');
    assert.match(guard?.detail ?? '', /recipient_mismatch/);
  });

  test('a build that reports no Aerodrome facts is blocked, not waved through', async () => {
    const s = await scene();
    const honest = new AerodromeSwapBuildAdapter({ reader: reader() });
    const silent: SwapBuildAdapter = {
      id: 'aerodrome',
      async build(input) {
        const inner = await honest.build(input);
        if (inner.outcome !== 'built') return inner;
        return { ...inner, aerodrome: undefined } satisfies SwapBuildResultV1;
      },
    };
    const result = await composerFor(s, { buildAdapter: silent }).prepare(prepareInput(s));
    assert.equal(result.outcome, 'blocked');
    if (result.outcome !== 'blocked') return;
    const guard = result.safety.checks.find((entry) => entry.id === 'provider_guard_aerodrome');
    assert.match(guard?.detail ?? '', /build_facts_missing/);
  });

  test('replaying the same request re-reviews the stored batch without re-simulating', async () => {
    const s = await scene();
    let simulations = 0;
    const composer = composerFor(s, {
      simulate: async () => {
        simulations += 1;
        return PASSED_SIMULATION;
      },
    });
    const first = await composer.prepare(prepareInput(s));
    const second = await composer.prepare(prepareInput(s));
    assert.equal(first.outcome, 'prepared');
    assert.equal(second.outcome, 'prepared');
    if (first.outcome !== 'prepared' || second.outcome !== 'prepared') return;
    assert.equal(first.blueprint.blueprintHash, second.blueprint.blueprintHash);
    assert.equal(simulations, 1, 'the same immutable bytes are not simulated twice');
    const guard = second.review.safety.checks.find((entry) => entry.id === 'provider_guard_aerodrome');
    assert.equal(guard?.status, 'passed', guard?.detail ?? '');
  });
});

/** Rewrites the amountOutMin word of a tokens-for-tokens call. Word 1. */
function rewriteMinimum(data: `0x${string}`, value: bigint): `0x${string}` {
  const body = data.slice(10);
  const word = value.toString(16).padStart(64, '0');
  return `0x${data.slice(2, 10)}${body.slice(0, 64)}${word}${body.slice(128)}` as `0x${string}`;
}

/** Rewrites the recipient word of a tokens-for-tokens call. Word 3. */
function rewriteRecipient(data: `0x${string}`, recipient: string): `0x${string}` {
  const body = data.slice(10);
  const word = recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `0x${data.slice(2, 10)}${body.slice(0, 192)}${word}${body.slice(256)}` as `0x${string}`;
}

describe('approve re-checks the stored batch on the shared path', () => {
  test('an Aerodrome Blueprint approves and opens a pending Route Proof', async () => {
    const s = await scene();
    const prepared = await composerFor(s).prepare(prepareInput(s));
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;

    const result = await approveExecutionBlueprintV1(
      { repository: s.repository, contractSecurity: passingContractSecurity() },
      {
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: s.intent.id,
        blueprintId: prepared.blueprint.id,
        blueprintHash: prepared.blueprint.blueprintHash,
        now: NOW,
      },
    );
    assert.equal(result.outcome, 'approved', JSON.stringify(result));
    if (result.outcome !== 'approved') return;
    // The wallet gets back exactly the calls that were reviewed — approve
    // first, then the pinned Router — as one atomic batch.
    assert.equal(result.payload.calls.length, 2);
    assert.equal(result.payload.calls[0]!.to, USDC);
    assert.equal(result.payload.calls[1]!.to, AERODROME_ROUTER_V1);
    assert.equal(result.payload.atomicRequired, true);
    assert.equal(result.payload.chainId, '0x2105');
    assert.equal(result.payload.from, WALLET);

    const proof = await s.repository.getProofProjection(routeProofIdV1(prepared.blueprint.id), TENANT);
    assert.ok(proof, 'approval opens the proof the reconciler will later fill in');
    assert.equal(proof.finalStatus, 'pending');
    assert.equal(proof.approvedCallsHash, result.payload.approvedCallsHash);
  });

  test('the guard inputs approve re-derives come from storage, never from the calldata', async () => {
    const s = await scene();
    const prepared = await composerFor(s).prepare(prepareInput(s));
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;

    const facts = aerodromeKernelInputV1('aerodrome', s.candidate, prepared.blueprint);
    assert.deepEqual(facts.aerodrome?.route, [...DIRECT_VOLATILE]);
    assert.equal(facts.aerodrome?.factory, FACTORY);
    // The floor stored with the calls, not one re-derived at approve time.
    const credit = prepared.blueprint.expectedAssetChanges.find((change) => change.direction === 'credit')!;
    assert.equal(facts.reviewedMinimumOutputAtomic, credit.minimumAmountAtomic);

    // A candidate whose route cannot be recovered yields NO facts — and the
    // Safety Kernel treats absent facts as a block, which the composer suite
    // above asserts directly.
    const opaque = {
      ...s.candidate,
      liquiditySources: [{ ...s.candidate.liquiditySources[0]!, sourceKey: 'uniswap:v3:0.05%' }],
    } as RouteCandidateV1;
    assert.deepEqual(aerodromeKernelInputV1('aerodrome', opaque, prepared.blueprint), {});

    // And nothing at all is derived for the partner-built providers.
    assert.deepEqual(aerodromeKernelInputV1('uniswap', s.candidate, prepared.blueprint), {});
  });
});

describe('the pinned Router is pinned in both packages', () => {
  test('the guard and the encoder name the same address', () => {
    // They are duplicated because @mioagent/security cannot import
    // @mioagent/swap-adapters. Duplication that nothing checks is duplication
    // that drifts.
    assert.equal(AERODROME_ROUTER_V1, AERODROME_BASE_ROUTER);
  });
});
