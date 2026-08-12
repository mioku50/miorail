import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteCardV1Schema,
  ZERO_HASH_V1,
  hashRouteCardV1,
  type AssetRefV1,
  type RouteCardV1,
} from '@mioagent/route-domain';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import { assembleExecutionBlueprintV1, blueprintIdV1, classifySwapCallV1 } from '../src/blueprint.js';
import { createTransactionComposer, TransactionComposerBindingError } from '../src/coordinator.js';
import type { TransactionComposerDependencies, TransactionComposerPrepareInput } from '../src/types.js';
import {
  ETH_BASE,
  NOW,
  TENANT,
  WALLET,
  WETH_BASE,
  buildScenario,
  buildSideOutputs,
  defaultBuiltCalls,
  makeCandidateAndEvidence,
  makeEvidenceSet,
  makeIntent,
  makePathScore,
  passingContractSecurity,
  failingContractSecurity,
  seedRepository,
  stubBuildAdapter,
  stubQuoteAdapter,
} from './fixtures.js';

const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
// Quote-side fresh candidate expected output is 38e15 wei (fixtures); the
// build-side quote is slightly worse but still above the card minimum.
const BUILD_EXPECTED_ATOMIC = '37990000000000000';

function baseDeps(overrides: Partial<TransactionComposerDependencies> = {}): TransactionComposerDependencies {
  return {
    repository: new InMemoryRouteStorageRepository(),
    buildAdapters: [],
    quoteAdapters: [],
    contractSecurity: passingContractSecurity(),
    now: () => NOW,
    ...overrides,
  };
}

async function defaultScenarioDeps(
  scenarioOverrides: Parameters<typeof buildScenario>[0] = {},
  overridesFactory?: (scenario: ReturnType<typeof buildScenario>) => Partial<TransactionComposerDependencies>,
) {
  const scenario = buildScenario(scenarioOverrides);
  const repository = await seedRepository(scenario);
  // A genuinely fresh re-quote must never reuse the seeded candidate/evidence
  // object identically — a different requestId yields a different
  // candidate/evidence id (and, since observedAt/expiresAt shift, a
  // different Evidence Set), matching how a live re-quote behaves.
  const freshUniswap = makeCandidateAndEvidence(scenario.intent, 'uniswap', {
    requestId: 'fresh-requote-uniswap',
    expectedOutputAtomic: scenario.uniswap.candidate.expectedOutput.amountAtomic,
    expiresAt: new Date(NOW.getTime() + 6 * 60_000).toISOString(),
  });
  const freshKyber = makeCandidateAndEvidence(scenario.intent, 'kyberswap', {
    requestId: 'fresh-requote-kyberswap',
    expectedOutputAtomic: scenario.kyberswap.candidate.expectedOutput.amountAtomic,
    expiresAt: new Date(NOW.getTime() + 6 * 60_000).toISOString(),
  });
  const freshQuoteAdapter = stubQuoteAdapter('uniswap', () => ({
    outcome: 'quoted',
    candidate: freshUniswap.candidate,
    evidence: [freshUniswap.evidence],
  }));
  const kyberQuoteAdapter = stubQuoteAdapter('kyberswap', () => ({
    outcome: 'quoted',
    candidate: freshKyber.candidate,
    evidence: [freshKyber.evidence],
  }));
  // Build-side outputs deliberately differ slightly from the quote-side fresh
  // candidate (37.99e15 vs 38e15 wei): the blueprint and review must carry the
  // BUILD numbers — the ones derived from the same provider response as the
  // calldata — never the quote-adapter candidate's numbers.
  const uniswapBuildAdapter = stubBuildAdapter('uniswap', (input) => ({
    outcome: 'built',
    provider: 'uniswap',
    routerAddress: ROUTER,
    calls: defaultBuiltCalls({ amountAtomic: input.intent.amount.amountAtomic }),
    quoteExpiry: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    requestId: input.requestId,
    requestHash: `0x${'a'.repeat(64)}`,
    responseHash: `0x${'b'.repeat(64)}`,
    ...buildSideOutputs(input.intent, BUILD_EXPECTED_ATOMIC),
  }));
  const deps: TransactionComposerDependencies = {
    repository,
    buildAdapters: [uniswapBuildAdapter],
    quoteAdapters: [freshQuoteAdapter, kyberQuoteAdapter],
    contractSecurity: passingContractSecurity(),
    now: () => NOW,
    ...(overridesFactory ? overridesFactory(scenario) : {}),
  };
  return { scenario, deps };
}

function prepareInput(
  scenario: Awaited<ReturnType<typeof buildScenario>>,
  overrides: Partial<TransactionComposerPrepareInput> = {},
): TransactionComposerPrepareInput {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: scenario.intent.id,
    routeCardHash: scenario.card.routeCardHash,
    selectedCandidateHash: scenario.uniswap.candidate.candidateHash,
    requestId: 'prepare-req-1',
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('prepares a valid ExecutionBlueprintV1 with a matching read-only review projection', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'prepared');
  if (result.outcome !== 'prepared') return;
  assert.equal(result.blueprint.status, 'ready_for_review');
  assert.equal(result.blueprint.approvedCallsHash, null);
  assert.equal(result.blueprint.atomicRequired, true);
  assert.equal(result.blueprint.calls.length, 2);
  assert.equal(result.blueprint.requiredApprovals.length, 1);
  assert.equal(result.blueprint.requiredApprovals[0]!.approvalKind, 'exact');
  assert.equal(result.review.readOnly, true);
  assert.equal(result.review.blueprintHash, result.blueprint.blueprintHash);
  assert.equal(result.review.safety.verdict, 'allowed');
  assert.ok(result.review.simulationWarning);
  // The reviewed numbers must be the BUILD-side outputs (same provider
  // response as the calldata), not the quote-adapter candidate's numbers.
  const buildOutputs = buildSideOutputs(scenario.intent, BUILD_EXPECTED_ATOMIC);
  assert.equal(result.review.expectedOutput.amountAtomic, buildOutputs.expectedOutput.amountAtomic);
  assert.equal(result.review.minimumOutput.amountAtomic, buildOutputs.minimumOutput.amountAtomic);
  assert.notEqual(result.review.expectedOutput.amountAtomic, scenario.uniswap.candidate.expectedOutput.amountAtomic);
  const credit = result.blueprint.expectedAssetChanges.find((change) => change.direction === 'credit')!;
  assert.equal(credit.amountAtomic, buildOutputs.expectedOutput.amountAtomic);
  assert.equal(credit.minimumAmountAtomic, buildOutputs.minimumOutput.amountAtomic);
});

// ---------------------------------------------------------------------------
// Binding validation
// ---------------------------------------------------------------------------

test('binding: rejects a wrong tenant', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { tenantId: 'other-tenant' })),
    TransactionComposerBindingError,
  );
});

test('binding: rejects a wallet mismatch', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { walletAddress: '0x2222222222222222222222222222222222222222' })),
    TransactionComposerBindingError,
  );
});

test('binding: rejects an unknown route run', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { routeRunId: 'no-such-run' })),
    TransactionComposerBindingError,
  );
});

test('binding: rejects an unknown Route Card hash', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { routeCardHash: `0x${'9'.repeat(64)}` })),
    TransactionComposerBindingError,
  );
});

test('binding: rejects a candidate hash not contained in the Route Card', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { selectedCandidateHash: `0x${'8'.repeat(64)}` })),
    TransactionComposerBindingError,
  );
});

test('binding: rejects altered routeCardHash / selectedCandidateHash bytes', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  const tamperedCardHash = `0x0${scenario.card.routeCardHash.slice(3)}` as `0x${string}`;
  await assert.rejects(
    () => composer.prepare(prepareInput(scenario, { routeCardHash: tamperedCardHash })),
    TransactionComposerBindingError,
  );
});

test('graceful outcome: an expired Route Card requires a refresh instead of throwing', async () => {
  const scenario = buildScenario({
    cardCreatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    cardExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
  });
  const repository = await seedRepository(scenario);
  const composer = createTransactionComposer(
    baseDeps({
      repository,
      buildAdapters: [],
      quoteAdapters: [],
    }),
  );
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
  if (result.outcome === 'refresh_required') assert.equal(result.reason, 'card_expired');
});

// ---------------------------------------------------------------------------
// Unsupported outcomes
// ---------------------------------------------------------------------------

// The pair rule used to be "the canonical three". An ordinary Base ERC-20 was
// refused here for being unfamiliar, which is not a safety property — whether
// a token may be traded is decided by the token-security verdict and the
// Safety Kernel, both of which run later and neither of which this gate can
// stand in for. What this gate still refuses is a pair that cannot be a trade.

test('a well-formed Base ERC-20 is no longer refused for being unfamiliar', async () => {
  const dai: AssetRefV1 = {
    assetId: 'eip155:8453/erc20:0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    chainId: 8453,
    kind: 'erc20',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    symbol: 'DAI',
    decimals: 18,
  };
  const { scenario, deps } = await defaultScenarioDeps({ toAsset: dai });
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  // It reaches the providers and is prepared like any other pair. The token's
  // legitimacy is not this gate's question and never was.
  assert.equal(result.outcome, 'prepared');
});

test('unsupported: ETH to WETH is never prepared — a wrap is not a routed trade', async () => {
  const scenario = buildScenario({ fromAsset: ETH_BASE, toAsset: WETH_BASE, amountDecimal: '1' });
  const repository = await seedRepository(scenario);
  const composer = createTransactionComposer(baseDeps({ repository }));
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'unsupported');
  if (result.outcome === 'unsupported') assert.equal(result.reason, 'unsupported_pair');
});

test('unsupported: an asset with decimals no amount could survive is refused', async () => {
  const absurd: AssetRefV1 = {
    assetId: 'eip155:8453/erc20:0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    chainId: 8453,
    kind: 'erc20',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    symbol: 'HUGE',
    decimals: 200,
  };
  const scenario = buildScenario({ toAsset: absurd });
  const repository = await seedRepository(scenario);
  const composer = createTransactionComposer(baseDeps({ repository }));
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'unsupported');
  if (result.outcome === 'unsupported') assert.equal(result.reason, 'unsupported_pair');
});

test('unsupported: a provider other than uniswap/kyberswap is never prepared', async () => {
  const intent = makeIntent();
  const sushi = { id: 'sushiswap', displayName: 'SushiSwap', kind: 'dex' as const, operator: 'Sushi' };
  // Built with a non-allowlisted provider from the start (via providerOverride)
  // so the candidate's hash and its linked evidence/evidenceSet stay
  // internally consistent — the point is to prove the coordinator's own
  // provider allowlist check, independent of which adapter produced it.
  const artifacts = makeCandidateAndEvidence(intent, 'uniswap', { providerOverride: sushi });
  const sushiCandidate = artifacts.candidate;
  const evidenceSet = makeEvidenceSet(intent, sushiCandidate, artifacts.evidence);
  const pathScore = makePathScore(intent, sushiCandidate, evidenceSet);

  const cardDraft: RouteCardV1 = {
    schemaVersion: 'route-card/v1',
    id: 'route-card-sushi-fixture',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    status: 'ready',
    intentHash: intent.intentHash,
    selectedCandidateHash: sushiCandidate.candidateHash,
    evidenceSetHash: evidenceSet.evidenceSetHash,
    pathScoreHash: pathScore.pathScoreHash,
    routeCardHash: ZERO_HASH_V1,
    recommendedCandidate: sushiCandidate,
    alternativeCandidates: [],
    pathScore,
    evidenceSummary: { recordCount: 1, paidCostUsd: '0', missingEvidence: [], sourceIndependence: 'independent' },
    recommendationReason: 'Fixture: unsupported provider.',
    expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  };
  const card = RouteCardV1Schema.parse({ ...cardDraft, routeCardHash: hashRouteCardV1(cardDraft) });

  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(intent, 'idempotency-sushi-fixture');
  await repository.insertCandidate(intent.id, sushiCandidate);
  await repository.insertEvidence(intent.id, sushiCandidate.id, artifacts.evidence);
  await repository.insertEvidenceSet(intent.id, sushiCandidate.id, evidenceSet);
  await repository.insertScoreSnapshot(intent.id, sushiCandidate.id, pathScore);
  await repository.insertRouteCard(intent.id, card);

  const composer = createTransactionComposer(baseDeps({ repository }));
  const result = await composer.prepare({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: intent.id,
    routeCardHash: card.routeCardHash,
    selectedCandidateHash: sushiCandidate.candidateHash,
    requestId: 'prepare-sushi-1',
    now: NOW,
  });
  assert.equal(result.outcome, 'unsupported');
  if (result.outcome === 'unsupported') assert.equal(result.reason, 'unsupported_provider');
});

// ---------------------------------------------------------------------------
// Re-quote policy
// ---------------------------------------------------------------------------

test('re-quote: an accepted fresh quote proceeds to a prepared blueprint', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'prepared');
});

test('re-quote: fresh expected output below the original minimum triggers refresh_required', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, (current) => ({
    quoteAdapters: [
      stubQuoteAdapter('uniswap', () => ({
        outcome: 'quoted',
        candidate: {
          ...current.uniswap.candidate,
          expectedOutput: { ...current.uniswap.candidate.expectedOutput, amountAtomic: '1' },
        },
        evidence: [current.uniswap.evidence],
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
  if (result.outcome === 'refresh_required') assert.equal(result.reason, 'fresh_output_below_minimum');
});

test('build: build-side expected output below the original card minimum triggers refresh_required', async () => {
  // Quote-adapter re-quote is fine (38e15 >= card min 37.81e15) but the
  // build round trip's own quote regressed below the original minimum.
  const { scenario, deps } = await defaultScenarioDeps({}, (current) => ({
    buildAdapters: [
      stubBuildAdapter('uniswap', (input) => ({
        outcome: 'built',
        provider: 'uniswap',
        routerAddress: ROUTER,
        calls: defaultBuiltCalls({ amountAtomic: input.intent.amount.amountAtomic }),
        quoteExpiry: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        requestId: input.requestId,
        requestHash: `0x${'a'.repeat(64)}`,
        responseHash: `0x${'b'.repeat(64)}`,
        ...buildSideOutputs(
          input.intent,
          (BigInt(current.uniswap.candidate.minimumOutput.amountAtomic) - BigInt(1)).toString(),
        ),
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
  if (result.outcome === 'refresh_required') {
    assert.equal(result.reason, 'fresh_output_below_minimum');
    assert.match(result.detail, /build/i);
  }
  // Nothing reviewable was persisted for this request.
  const stored = await deps.repository.listBlueprints(scenario.intent.id, TENANT);
  assert.equal(stored.length, 0);
});

test('re-quote: an asset mismatch on the fresh quote triggers refresh_required', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, (current) => ({
    quoteAdapters: [
      stubQuoteAdapter('uniswap', () => ({
        outcome: 'quoted',
        candidate: {
          ...current.uniswap.candidate,
          expectedOutput: { ...current.kyberswap.candidate.expectedOutput, asset: current.uniswap.candidate.inputAmount.asset },
        },
        evidence: [current.uniswap.evidence],
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
});

test('re-quote: a provider mismatch on the fresh quote triggers refresh_required', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, (current) => ({
    quoteAdapters: [
      stubQuoteAdapter('uniswap', () => ({
        outcome: 'quoted',
        candidate: { ...current.kyberswap.candidate, candidateHash: current.uniswap.candidate.candidateHash },
        evidence: [current.kyberswap.evidence],
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
});

test('re-quote: an already-expired fresh quote triggers refresh_required', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, (current) => ({
    quoteAdapters: [
      stubQuoteAdapter('uniswap', () => ({
        outcome: 'quoted',
        candidate: { ...current.uniswap.candidate, quoteExpiresAt: new Date(NOW.getTime() - 1_000).toISOString() },
        evidence: [current.uniswap.evidence],
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
});

test('re-quote: adapter failure to produce a fresh quote triggers refresh_required', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, () => ({
    quoteAdapters: [stubQuoteAdapter('uniswap', () => ({ outcome: 'unavailable', provider: 'uniswap', errorCode: 'provider_no_route', retryable: false }))],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'refresh_required');
});

// ---------------------------------------------------------------------------
// Blueprint persistence + idempotency
// ---------------------------------------------------------------------------

test('blueprint: an identical retry (same requestId) returns the same blueprint idempotently', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const composer = createTransactionComposer(deps);
  const first = await composer.prepare(prepareInput(scenario));
  const second = await composer.prepare(prepareInput(scenario));
  assert.equal(first.outcome, 'prepared');
  assert.equal(second.outcome, 'prepared');
  if (first.outcome === 'prepared' && second.outcome === 'prepared') {
    assert.equal(first.blueprint.blueprintHash, second.blueprint.blueprintHash);
    assert.equal(first.blueprint.id, second.blueprint.id);
  }
  const stored = await deps.repository.listBlueprints(scenario.intent.id, TENANT);
  assert.equal(stored.length, 1);
});

test('blueprint: an expired stored blueprint is never returned as reviewable again', async () => {
  const { scenario, deps } = await defaultScenarioDeps();
  const requestId = 'expired-blueprint-req';
  const id = blueprintIdV1({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: scenario.intent.id,
    routeCardHash: scenario.card.routeCardHash,
    selectedCandidateHash: scenario.uniswap.candidate.candidateHash,
    requestId,
  });
  const calls = [
    classifySwapCallV1({
      index: 0,
      call: defaultBuiltCalls({ amountAtomic: scenario.intent.amount.amountAtomic })[0]!,
      routerAddress: ROUTER,
      inputAsset: scenario.intent.fromAsset!,
      walletAddress: WALLET,
    }),
    classifySwapCallV1({
      index: 1,
      call: defaultBuiltCalls({ amountAtomic: scenario.intent.amount.amountAtomic })[1]!,
      routerAddress: ROUTER,
      inputAsset: scenario.intent.fromAsset!,
      walletAddress: WALLET,
    }),
  ];
  const expiredBlueprint = assembleExecutionBlueprintV1({
    id,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    now: new Date(NOW.getTime() - 60_000),
    intentHash: scenario.intent.intentHash,
    selectedCandidateHash: scenario.uniswap.candidate.candidateHash,
    evidenceSetHash: scenario.uniswap.evidenceSet.evidenceSetHash,
    quoteExpiry: new Date(NOW.getTime() - 1_000).toISOString(),
    calls,
    inputAsset: scenario.intent.fromAsset!,
    inputAmountAtomic: scenario.intent.amount.amountAtomic,
    outputAsset: scenario.intent.toAsset!,
    outputExpectedAtomic: scenario.uniswap.candidate.expectedOutput.amountAtomic,
    outputMinimumAtomic: scenario.uniswap.candidate.minimumOutput.amountAtomic,
    simulationState: { status: 'unavailable', observedAt: null, blockNumber: null, requestHash: null, responseHash: null, errorCode: 'no_simulation_provider' },
  });
  await deps.repository.insertBlueprint(scenario.intent.id, expiredBlueprint);

  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario, { requestId }));
  assert.equal(result.outcome, 'refresh_required');
  if (result.outcome === 'refresh_required') assert.equal(result.reason, 'blueprint_expired');
});

// ---------------------------------------------------------------------------
// Safety Kernel + simulation honesty
// ---------------------------------------------------------------------------

test('standard verification depth prepares with an honest simulation-unavailable warning', async () => {
  const { scenario, deps } = await defaultScenarioDeps({ verificationDepth: 'standard' });
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'prepared');
  if (result.outcome === 'prepared') {
    assert.equal(result.review.simulationState.status, 'unavailable');
    assert.ok(result.review.simulationWarning);
  }
});

test('enhanced verification depth blocks because required simulation evidence is unavailable', async () => {
  const { scenario, deps } = await defaultScenarioDeps({ verificationDepth: 'enhanced' });
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'blocked');
  if (result.outcome === 'blocked') assert.equal(result.safety.verdict, 'blocked');
});

test('maximum verification depth blocks because required simulation evidence is unavailable', async () => {
  const { scenario, deps } = await defaultScenarioDeps({ verificationDepth: 'maximum' });
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'blocked');
});

test('Safety Kernel rejection (unlimited approval from a malicious build) blocks with the full result', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, () => ({
    buildAdapters: [
      stubBuildAdapter('uniswap', (input) => ({
        outcome: 'built',
        provider: 'uniswap',
        routerAddress: ROUTER,
        calls: [
          { to: (input.intent.fromAsset!.address as `0x${string}`), value: '0', data: `0x095ea7b3${ROUTER.slice(2).padStart(64, '0')}${'f'.repeat(64)}` as `0x${string}` },
          { to: ROUTER, value: '0', data: '0x12345678' },
        ],
        quoteExpiry: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
        requestId: input.requestId,
        requestHash: `0x${'a'.repeat(64)}`,
        responseHash: `0x${'b'.repeat(64)}`,
        ...buildSideOutputs(input.intent, BUILD_EXPECTED_ATOMIC),
      })),
    ],
  }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'blocked');
  if (result.outcome === 'blocked') {
    assert.equal(result.safety.verdict, 'blocked');
    assert.ok(result.safety.checks.some((check) => check.status === 'failed'));
  }
});

test('Safety Kernel blocks when contract security has no usable verdict', async () => {
  const { scenario, deps } = await defaultScenarioDeps({}, () => ({ contractSecurity: failingContractSecurity() }));
  const composer = createTransactionComposer(deps);
  const result = await composer.prepare(prepareInput(scenario));
  assert.equal(result.outcome, 'blocked');
});

// ---------------------------------------------------------------------------
// No execution surfaces anywhere in the composer's own source
// ---------------------------------------------------------------------------

test('composer source never references send_calls, x402, spend permissions, or Action Inbox', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcDir = path.join(here, '..', 'src');
  // T57 note: `route[-_]?proof` was forbidden under T56, when the composer had
  // no execution-recording surface. T57 deliberately adds the approve and
  // submission coordinators, which persist pending RouteProofV1 projections —
  // proofs are now a legitimate reference, while Base MCP send_calls / x402 /
  // Action Inbox / Spend Permissions remain banned in every composer source.
  const forbidden = /send_calls|wallet_sendcalls|x402|actioninbox|spend[-_]?permission/i;

  function walk(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  const files = walk(srcDir).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.equal(forbidden.test(content), false, `${file} must not reference forbidden execution surfaces`);
  }
});

