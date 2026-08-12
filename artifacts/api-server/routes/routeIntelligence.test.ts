import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { RoutePlanResponseV1, SwapPrepareResponseV1 } from '@mioagent/api-spec';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '@mioagent/route-card';
import type { SwapRouteEvaluationV1 } from '@mioagent/route-engine';
import {
  BlueprintSubmissionConflictError,
  assembleExecutionBlueprintV1,
  blueprintIdV1,
  buildTransactionReviewProjectionV1,
  classifySwapCallV1,
} from '@mioagent/transaction-composer';
import {
  NOW,
  WALLET,
  constrainedEvaluation,
  degradedEvaluation,
  failedEvaluation,
  readyEvaluation,
  routeCardIntentFixture,
  unsupportedOptimizationEvaluation,
} from '../../../lib/route-card/test/fixtures.js';
import { RouteProofReconcileBindingError } from '@mioagent/route-proof';
import { RouteStorageIntegrityError } from '@mioagent/route-storage';
import { logger } from '@mioagent/utils';
import {
  routeIntelligenceRouter,
  routePlanRouteRuntime,
  routeProofRouteRuntime,
  swapBlueprintRouteRuntime,
  swapPrepareRouteRuntime,
} from './routeIntelligence.js';

const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const originalRuntime = { ...routePlanRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

function routeApp(user: typeof USER | null = USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  app.use('/api/route-intelligence', routeIntelligenceRouter);
  return app;
}

async function evaluatedResponse(
  evaluation: SwapRouteEvaluationV1,
  constrained = false,
  unsupportedOptimization = false,
): Promise<RoutePlanResponseV1> {
  const intent = routeCardIntentFixture(
    constrained,
    unsupportedOptimization ? 'lowest_risk' : 'best_net_result',
  );
  const routeCard = buildRouteCardV1(evaluation);
  return {
    outcome: 'evaluated',
    routeRunId: intent.id,
    intent,
    evaluation,
    routeCard,
    projection: buildRoutePlanProjectionV1(evaluation, { routeCard, routeRunId: intent.id }),
  };
}

describe('POST /api/route-intelligence/swap/evaluate', () => {
  beforeEach(() => {
    routePlanRouteRuntime.flags = () => ({
      routeIntelligenceV1: true,
      legacyTerminal: true,
      paidIntelligence: false,
      earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false,
      nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false,
    });
    routePlanRouteRuntime.migrationAvailable = async () => true;
    routePlanRouteRuntime.now = () => NOW;
    routePlanRouteRuntime.coordinate = async () => ({
      outcome: 'needs_clarification',
      clarification: {
        code: 'amount_required',
        message: 'Tell me the exact amount to swap.',
        missingFields: ['amount'],
        locale: 'en',
      },
    });
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(routePlanRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('returns a stable disabled error without coordinating', async () => {
    let coordinated = false;
    routePlanRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    routePlanRouteRuntime.coordinate = async () => {
      coordinated = true;
      throw new Error('must not run');
    };
    const response = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'disabled-1',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    assert.equal(coordinated, false);
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    const body = { message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'auth-1' };
    assert.equal((await request(routeApp(null)).post('/api/route-intelligence/swap/evaluate').send(body)).status, 401);
    const mismatch = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      ...body,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects extra request fields and Sepolia runtime context', async () => {
    const extra = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'strict-1', score: 100,
    });
    assert.equal(extra.status, 400);
    delete process.env.CHAIN_ENV;
    const unspecified = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'unspecified-chain-1',
    });
    assert.equal(unspecified.status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'sepolia-1',
    });
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('returns clarification and rejection without constructing evaluation artifacts', async () => {
    const clarification = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap tokens', walletAddress: WALLET, requestId: 'clarify-1',
    });
    assert.equal(clarification.status, 200);
    assert.equal(clarification.body.outcome, 'needs_clarification');
    assert.equal('evaluation' in clarification.body, false);

    routePlanRouteRuntime.coordinate = async () => ({
      outcome: 'rejected',
      issues: [{ code: 'server_signing_forbidden', field: 'message', severity: 'rejection', message: 'Server signing is forbidden.' }],
    });
    const rejected = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Sign and send this swap for me', walletAddress: WALLET, requestId: 'reject-1',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.outcome, 'rejected');
    assert.equal('routeRunId' in rejected.body, false);
  });

  for (const scenario of [
    { name: 'ready comparison', fixture: readyEvaluation, outcome: 'ready', constrained: false, unsupported: false },
    { name: 'explicit protocol constraint', fixture: constrainedEvaluation, outcome: 'constrained', constrained: true, unsupported: false },
    { name: 'one-provider degradation', fixture: degradedEvaluation, outcome: 'degraded', constrained: false, unsupported: false },
    { name: 'unsupported optimization', fixture: unsupportedOptimizationEvaluation, outcome: 'degraded', constrained: false, unsupported: true },
    { name: 'both providers failed', fixture: failedEvaluation, outcome: 'failed', constrained: false, unsupported: false },
  ] as const) {
    test(`returns a validated ${scenario.name} projection`, async () => {
      const evaluation = await scenario.fixture();
      const responseFixture = await evaluatedResponse(evaluation, scenario.constrained, scenario.unsupported);
      routePlanRouteRuntime.coordinate = async () => responseFixture;
      const response = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
        message: scenario.name, walletAddress: WALLET, requestId: `scenario-${scenario.outcome}`,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.outcome, 'evaluated');
      assert.equal(response.body.projection.outcome, scenario.outcome);
      if (scenario.outcome === 'degraded' || scenario.outcome === 'failed') {
        assert.equal(response.body.routeCard, null);
        assert.equal(response.body.projection.recommendedRoute, null);
      }
      const serialized = JSON.stringify(response.body);
      assert.equal(/calldata|walletCalls|executionBlueprint|x402Receipt/i.test(serialized), false);
    });
  }

  test('fails closed when migration or coordinator storage is unavailable', async () => {
    routePlanRouteRuntime.migrationAvailable = async () => false;
    const unavailable = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'migration-1',
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'route_storage_unavailable');

    routePlanRouteRuntime.migrationAvailable = async () => true;
    routePlanRouteRuntime.coordinate = async () => { throw new Error('storage failed'); };
    const failed = await request(routeApp()).post('/api/route-intelligence/swap/evaluate').send({
      message: 'Swap 100 USDC to ETH', walletAddress: WALLET, requestId: 'storage-1',
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'route_plan_evaluation_failed', code: 'route_plan_evaluation_failed' });
    assert.equal(JSON.stringify(failed.body).includes('storage failed'), false);
  });
});

describe('POST /api/route-intelligence/swap/prepare', () => {
  const originalSwapPrepareRuntime = { ...swapPrepareRouteRuntime };
  const PREPARE_BODY = {
    routeRunId: 'run-t56-fixture',
    routeCardHash: `0x${'1'.repeat(64)}`,
    selectedCandidateHash: `0x${'2'.repeat(64)}`,
    walletAddress: WALLET,
    requestId: 'prepare-req-1',
  };

  function preparedFixture(): SwapPrepareResponseV1 {
    const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
    const USDC = {
      assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      chainId: 8453 as const,
      kind: 'erc20' as const,
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
      symbol: 'USDC',
      decimals: 6,
    };
    const ETH = {
      assetId: 'eip155:8453/native',
      chainId: 8453 as const,
      kind: 'native' as const,
      address: null,
      symbol: 'ETH',
      decimals: 18,
    };
    const approveData = `0x095ea7b3${ROUTER.slice(2).padStart(64, '0')}${(100_000_000n).toString(16).padStart(64, '0')}` as `0x${string}`;
    const calls = [
      classifySwapCallV1({ index: 0, call: { to: USDC.address, value: '0', data: approveData }, routerAddress: ROUTER, inputAsset: USDC, walletAddress: WALLET }),
      classifySwapCallV1({ index: 1, call: { to: ROUTER, value: '0', data: '0x12345678' }, routerAddress: ROUTER, inputAsset: USDC, walletAddress: WALLET }),
    ];
    const blueprint = assembleExecutionBlueprintV1({
      id: blueprintIdV1({ tenantId: USER.id, walletAddress: WALLET, routeRunId: PREPARE_BODY.routeRunId, routeCardHash: PREPARE_BODY.routeCardHash as `0x${string}`, selectedCandidateHash: PREPARE_BODY.selectedCandidateHash as `0x${string}`, requestId: PREPARE_BODY.requestId }),
      tenantId: USER.id,
      walletAddress: WALLET,
      chainId: 8453,
      now: NOW,
      intentHash: `0x${'3'.repeat(64)}` as `0x${string}`,
      selectedCandidateHash: PREPARE_BODY.selectedCandidateHash as `0x${string}`,
      evidenceSetHash: `0x${'4'.repeat(64)}` as `0x${string}`,
      quoteExpiry: new Date(NOW.getTime() + 60_000).toISOString(),
      calls,
      inputAsset: USDC,
      inputAmountAtomic: '100000000',
      outputAsset: ETH,
      outputExpectedAtomic: '38000000000000000',
      outputMinimumAtomic: '37810000000000000',
      simulationState: { status: 'unavailable', observedAt: null, blockNumber: null, requestHash: null, responseHash: null, errorCode: 'no_simulation_provider' },
    });
    const review = buildTransactionReviewProjectionV1({
      routeRunId: PREPARE_BODY.routeRunId,
      provider: { id: 'uniswap', displayName: 'Uniswap', kind: 'dex', operator: 'Uniswap Labs' },
      input: { asset: USDC, amountAtomic: '100000000', amountDecimal: '100' },
      expectedOutput: { asset: ETH, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
      minimumOutput: { asset: ETH, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
      cardExpectedOutput: { asset: ETH, amountAtomic: '38000000000000000', amountDecimal: '0.038' },
      cardMinimumOutput: { asset: ETH, amountAtomic: '37810000000000000', amountDecimal: '0.03781' },
      blueprint,
      safety: {
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'allowed',
        checks: [{ id: 'chain_pinned', description: 'Base mainnet', status: 'passed', detail: null }],
        blockedReason: null,
      },
      contractSecurity: { provider: 'goplus', required: true, status: 'passed', verdicts: [] },
      simulationWarning: 'No fork-simulation provider is configured.',
    });
    return { outcome: 'prepared', routeRunId: PREPARE_BODY.routeRunId, blueprint, review };
  }

  beforeEach(() => {
    swapPrepareRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapPrepareRouteRuntime.migrationAvailable = async () => true;
    swapPrepareRouteRuntime.now = () => NOW;
    swapPrepareRouteRuntime.prepare = async () => ({ outcome: 'unsupported', reason: 'unsupported_pair', detail: 'fixture' });
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(swapPrepareRouteRuntime, originalSwapPrepareRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('returns a stable disabled error without preparing', async () => {
    let prepared = false;
    swapPrepareRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapPrepareRouteRuntime.prepare = async () => {
      prepared = true;
      throw new Error('must not run');
    };
    const response = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    assert.equal(prepared, false);
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    assert.equal((await request(routeApp(null)).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY)).status, 401);
    const mismatch = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send({
      ...PREPARE_BODY,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects an invalid body and a non-mainnet runtime context', async () => {
    const invalid = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send({ ...PREPARE_BODY, routeCardHash: 'not-a-hash' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_swap_prepare_request');

    delete process.env.CHAIN_ENV;
    const unspecified = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(unspecified.status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('fails closed when migration is unavailable or the composer throws, without leaking the error', async () => {
    swapPrepareRouteRuntime.migrationAvailable = async () => false;
    const unavailable = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'route_storage_unavailable');

    swapPrepareRouteRuntime.migrationAvailable = async () => true;
    swapPrepareRouteRuntime.prepare = async () => { throw new Error('tenant binding violated: secret detail'); };
    const failed = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'swap_prepare_failed', code: 'swap_prepare_failed' });
    assert.equal(JSON.stringify(failed.body).includes('secret detail'), false);
  });

  test('a 500 is recorded server-side, with no provider URL or key in the record', async () => {
    // The defect this closes: the catch discarded its cause, so a real failure
    // in production left one access-log line saying `500` and nothing else.
    // Diagnosing it meant reconstructing the flow from database rows.
    const entries: { title: string; meta: Record<string, unknown> }[] = [];
    const original = logger.error;
    logger.error = ((title: string, meta: Record<string, unknown>) => {
      entries.push({ title, meta });
    }) as typeof logger.error;
    try {
      swapPrepareRouteRuntime.migrationAvailable = async () => true;
      swapPrepareRouteRuntime.prepare = async () => {
        throw new TypeError('fetch failed for https://trade-api.example/v1/quote key 0xdeadbeefdeadbeef');
      };
      const failed = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
      assert.equal(failed.status, 500);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.title, 'Swap prepare failed');
      assert.equal(entries[0]!.meta.name, 'TypeError');
      const recorded = JSON.stringify(entries[0]!.meta);
      // The sentence survives; the URL and the long hex do not.
      assert.match(recorded, /fetch failed/);
      assert.equal(recorded.includes('trade-api.example'), false);
      assert.equal(recorded.includes('deadbeefdeadbeef'), false);
    } finally {
      logger.error = original;
    }
  });

  test('returns a validated unsupported outcome', async () => {
    swapPrepareRouteRuntime.prepare = async () => ({ outcome: 'unsupported', reason: 'unsupported_pair', detail: 'Only canonical Base USDC to ETH or WETH is supported' });
    const response = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unsupported');
  });

  test('returns a validated refresh_required outcome', async () => {
    swapPrepareRouteRuntime.prepare = async () => ({ outcome: 'refresh_required', routeRunId: PREPARE_BODY.routeRunId, reason: 'card_expired', detail: 'Route Card quote comparison has expired' });
    const response = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refresh_required');
  });

  test('returns a validated blocked outcome carrying the full Safety Kernel result', async () => {
    swapPrepareRouteRuntime.prepare = async () => ({
      outcome: 'blocked',
      routeRunId: PREPARE_BODY.routeRunId,
      safety: {
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'blocked',
        checks: [{ id: 'contract_token_security', description: 'GoPlus verdict', status: 'failed', detail: 'No usable verdict' }],
        blockedReason: 'contract_token_security: No usable verdict',
      },
    });
    const response = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'blocked');
    assert.equal(response.body.safety.verdict, 'blocked');
  });

  test('returns a validated prepared outcome with the full blueprint and review projection', async () => {
    swapPrepareRouteRuntime.prepare = async () => preparedFixture();
    const response = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'prepared');
    assert.equal(response.body.review.readOnly, true);
    assert.equal(response.body.blueprint.approvedCallsHash, null);
    const serialized = JSON.stringify(response.body);
    assert.equal(/send_calls|x402Receipt/i.test(serialized), false);
  });

  // T59: the only change this task makes to /swap/prepare's response.
  test('surfaces simulationPriceUsdc alongside a prepared outcome, and null when the feature is unavailable', async () => {
    swapPrepareRouteRuntime.prepare = async () => preparedFixture();
    delete process.env.MIORAIL_SIMULATION_PRICE_USDC;
    delete process.env.MIORAIL_SIMULATION_PROVIDER_URL;
    delete process.env.MIORAIL_SIMULATION_PROVIDER_ALLOWLIST;

    const unavailable = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.outcome, 'prepared');
    assert.equal(unavailable.body.simulationPriceUsdc, null);

    process.env.MIORAIL_SIMULATION_PRICE_USDC = '0.02';
    process.env.MIORAIL_SIMULATION_PROVIDER_URL = 'https://sim.example.test/simulate';
    process.env.MIORAIL_SIMULATION_PROVIDER_ALLOWLIST = 'sim.example.test';

    // A configured price is still no price when the surface is off. Miorail no
    // longer sells paid swap simulation, and advertising a figure the server
    // would refuse to honour is how a client ends up rendering "Simulate for
    // $0.02" over an endpoint that answers 404.
    const surfaceOff = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(surfaceOff.status, 200);
    assert.equal(surfaceOff.body.simulationPriceUsdc, null);

    process.env.MIORAIL_PAID_SWAP_SIMULATION_V1 = 'true';
    const configured = await request(routeApp()).post('/api/route-intelligence/swap/prepare').send(PREPARE_BODY);
    assert.equal(configured.status, 200);
    assert.equal(configured.body.simulationPriceUsdc, '0.02');

    delete process.env.MIORAIL_PAID_SWAP_SIMULATION_V1;
    delete process.env.MIORAIL_SIMULATION_PRICE_USDC;
    delete process.env.MIORAIL_SIMULATION_PROVIDER_URL;
    delete process.env.MIORAIL_SIMULATION_PROVIDER_ALLOWLIST;
  });
});

// ---------------------------------------------------------------------------
// T57: blueprint approve + submission routes
// ---------------------------------------------------------------------------

describe('POST /api/route-intelligence/swap/blueprints/:blueprintId/approve', () => {
  const originalBlueprintRuntime = { ...swapBlueprintRouteRuntime };
  const BLUEPRINT_ID = 'blueprint-t57-route-fixture';
  const APPROVE_BODY = {
    routeRunId: 'run-t57-fixture',
    blueprintHash: `0x${'5'.repeat(64)}` as `0x${string}`,
    walletAddress: WALLET,
  };
  const APPROVED_PAYLOAD = {
    blueprintId: BLUEPRINT_ID,
    blueprintHash: APPROVE_BODY.blueprintHash,
    approvedCallsHash: `0x${'6'.repeat(64)}` as `0x${string}`,
    chainId: '0x2105' as const,
    from: WALLET,
    calls: [
      {
        to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as `0x${string}`,
        value: '0x0' as `0x${string}`,
        data: '0x095ea7b3' as `0x${string}`,
      },
      {
        to: '0x6ff5693b99212da76ad316178a184ab56d299b43' as `0x${string}`,
        value: '0x0' as `0x${string}`,
        data: '0x12345678' as `0x${string}`,
      },
    ],
    atomicRequired: true as const,
  };

  beforeEach(() => {
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapBlueprintRouteRuntime.migrationAvailable = async () => true;
    swapBlueprintRouteRuntime.now = () => NOW;
    swapBlueprintRouteRuntime.approve = async () => ({ outcome: 'approved', payload: APPROVED_PAYLOAD, lifecycle: 'approved' });
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(swapBlueprintRouteRuntime, originalBlueprintRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  const url = `/api/route-intelligence/swap/blueprints/${BLUEPRINT_ID}/approve`;

  test('returns a stable disabled error without approving', async () => {
    let approved = false;
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapBlueprintRouteRuntime.approve = async () => {
      approved = true;
      throw new Error('must not run');
    };
    const response = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    assert.equal(approved, false);
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    assert.equal((await request(routeApp(null)).post(url).send(APPROVE_BODY)).status, 401);
    const mismatch = await request(routeApp()).post(url).send({
      ...APPROVE_BODY,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects an invalid body and a non-mainnet runtime context', async () => {
    const invalid = await request(routeApp()).post(url).send({ ...APPROVE_BODY, blueprintHash: 'not-a-hash' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_blueprint_approve_request');
    const extra = await request(routeApp()).post(url).send({ ...APPROVE_BODY, calls: [] });
    assert.equal(extra.status, 400);

    delete process.env.CHAIN_ENV;
    assert.equal((await request(routeApp()).post(url).send(APPROVE_BODY)).status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('fails closed on missing storage and on approve errors without leaking details', async () => {
    swapBlueprintRouteRuntime.migrationAvailable = async () => false;
    const unavailable = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'route_storage_unavailable');

    swapBlueprintRouteRuntime.migrationAvailable = async () => true;
    swapBlueprintRouteRuntime.approve = async () => { throw new Error('binding violated: secret detail'); };
    const failed = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'blueprint_approve_failed', code: 'blueprint_approve_failed' });
    assert.equal(JSON.stringify(failed.body).includes('secret detail'), false);
  });

  test('returns the validated approved payload with lifecycle', async () => {
    const response = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'approved');
    assert.equal(response.body.lifecycle, 'approved');
    assert.deepEqual(response.body.payload, APPROVED_PAYLOAD);
    const serialized = JSON.stringify(response.body);
    assert.equal(/send_calls|x402/i.test(serialized), false);
  });

  test('returns validated expired and blocked outcomes', async () => {
    swapBlueprintRouteRuntime.approve = async () => ({ outcome: 'expired', reason: 'Blueprint quote has expired' });
    const expired = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(expired.status, 200);
    assert.equal(expired.body.outcome, 'expired');

    swapBlueprintRouteRuntime.approve = async () => ({
      outcome: 'blocked',
      reason: 'contract_token_security failed',
      safety: {
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'blocked',
        checks: [{ id: 'contract_token_security', description: 'GoPlus verdict', status: 'failed', detail: 'No usable verdict' }],
        blockedReason: 'contract_token_security: No usable verdict',
      },
    });
    const blocked = await request(routeApp()).post(url).send(APPROVE_BODY);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.outcome, 'blocked');
    assert.equal(blocked.body.safety.verdict, 'blocked');
  });
});

describe('POST /api/route-intelligence/swap/blueprints/:blueprintId/submission', () => {
  const originalBlueprintRuntime = { ...swapBlueprintRouteRuntime };
  const BLUEPRINT_ID = 'blueprint-t57-route-fixture';
  const SUBMISSION_BODY = {
    routeRunId: 'run-t57-fixture',
    walletAddress: WALLET,
    approvedCallsHash: `0x${'6'.repeat(64)}`,
    batchId: 'batch-1',
    status: 'submitted',
  };

  beforeEach(() => {
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapBlueprintRouteRuntime.migrationAvailable = async () => true;
    swapBlueprintRouteRuntime.now = () => NOW;
    swapBlueprintRouteRuntime.recordSubmission = async () => ({
      outcome: 'recorded',
      lifecycle: 'submitted',
      proofId: 'route-proof:abc',
      finalStatus: 'pending',
    });
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(swapBlueprintRouteRuntime, originalBlueprintRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  const url = `/api/route-intelligence/swap/blueprints/${BLUEPRINT_ID}/submission`;

  test('returns a stable disabled error without recording', async () => {
    let recorded = false;
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    swapBlueprintRouteRuntime.recordSubmission = async () => {
      recorded = true;
      throw new Error('must not run');
    };
    const response = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    assert.equal(recorded, false);
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    assert.equal((await request(routeApp(null)).post(url).send(SUBMISSION_BODY)).status, 401);
    const mismatch = await request(routeApp()).post(url).send({
      ...SUBMISSION_BODY,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects an invalid body (calls are never accepted) and non-mainnet context', async () => {
    const badStatus = await request(routeApp()).post(url).send({ ...SUBMISSION_BODY, status: 'executed' });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.body.code, 'invalid_blueprint_submission_request');
    const withCalls = await request(routeApp()).post(url).send({ ...SUBMISSION_BODY, calls: [{ to: '0x1', data: '0x' }] });
    assert.equal(withCalls.status, 400);

    delete process.env.CHAIN_ENV;
    assert.equal((await request(routeApp()).post(url).send(SUBMISSION_BODY)).status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('rejects a batch-claiming status without a batchId and never records it', async () => {
    let recorded = 0;
    const okRuntime = swapBlueprintRouteRuntime.recordSubmission;
    swapBlueprintRouteRuntime.recordSubmission = async (arg) => {
      recorded += 1;
      return okRuntime(arg);
    };
    for (const status of ['submitted', 'confirmed', 'submitted_unknown']) {
      const response = await request(routeApp()).post(url).send({
        routeRunId: 'run-t57-fixture',
        walletAddress: WALLET,
        approvedCallsHash: `0x${'6'.repeat(64)}`,
        status,
        transactionHashes: [`0x${'ab'.repeat(32)}`],
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'invalid_blueprint_submission_request');
    }
    assert.equal(recorded, 0);
    // A terminal failed/cancelled WITHOUT a batchId is still valid (transport
    // failure / refusal before any batch id was assigned).
    const cancelled = await request(routeApp()).post(url).send({
      routeRunId: 'run-t57-fixture',
      walletAddress: WALLET,
      approvedCallsHash: `0x${'6'.repeat(64)}`,
      status: 'cancelled',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(recorded, 1);
  });

  test('fails closed on missing storage and on record errors without leaking details', async () => {
    swapBlueprintRouteRuntime.migrationAvailable = async () => false;
    const unavailable = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'route_storage_unavailable');

    swapBlueprintRouteRuntime.migrationAvailable = async () => true;
    swapBlueprintRouteRuntime.recordSubmission = async () => { throw new Error('secret submission detail'); };
    const failed = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'blueprint_submission_failed', code: 'blueprint_submission_failed' });
    assert.equal(JSON.stringify(failed.body).includes('secret submission detail'), false);
  });

  test('maps a submission conflict to a stable 409', async () => {
    swapBlueprintRouteRuntime.recordSubmission = async () => {
      throw new BlueprintSubmissionConflictError('a different batch is already recorded');
    };
    const response = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: 'blueprint_submission_conflict', code: 'blueprint_submission_conflict' });
    assert.equal(JSON.stringify(response.body).includes('different batch'), false);
  });

  test('returns the validated recorded response', async () => {
    const response = await request(routeApp()).post(url).send(SUBMISSION_BODY);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      outcome: 'recorded',
      lifecycle: 'submitted',
      proofId: 'route-proof:abc',
      finalStatus: 'pending',
    });
  });
});

// ---------------------------------------------------------------------------
// T58: route-proof reconciliation, read projection, and tenant history.
// ---------------------------------------------------------------------------

const PROOF_ID = 'route-proof:t58-route-fixture';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const PROOF_PROJECTION = {
  proofId: PROOF_ID,
  blueprintId: 'blueprint-t58-route-fixture',
  blueprintHash: `0x${'5'.repeat(64)}`,
  approvedCallsHash: `0x${'6'.repeat(64)}`,
  intentHash: `0x${'7'.repeat(64)}`,
  provider: 'uniswap',
  expectedOutput: {
    amountAtomic: '38000000000000000',
    asset: { symbol: 'WETH', decimals: 18, address: '0x4200000000000000000000000000000000000006', kind: 'erc20' as const },
  },
  minimumOutput: '37810000000000000',
  actualOutput: '38000000000000000',
  actualOutputUnavailableReason: null,
  outputDeviationBps: 0,
  minimumSatisfied: true,
  estimatedGas: { gasUnits: '190000', maxFeePerGasWei: '1500000000', estimatedCostNative: '0.000285', estimatedCostUsd: '0.71' },
  actualGas: { gasUnits: '185000', maxFeePerGasWei: null, estimatedCostNative: '0.000222', estimatedCostUsd: null },
  transactionHashes: [TX_HASH],
  receipts: [{ transactionHash: TX_HASH, status: 'success' as const, blockNumber: '33123499', gasUsed: '185000' }],
  finalStatus: 'completed' as const,
  reconciliationState: 'matched' as const,
  createdAt: '2026-07-18T12:00:00.000Z',
  updatedAt: '2026-07-18T12:01:00.000Z',
};

describe('POST /api/route-intelligence/route-proofs/:proofId/reconcile', () => {
  const originalProofRuntime = { ...routeProofRouteRuntime };
  const RECONCILE_BODY = { routeRunId: 'run-t58-fixture', walletAddress: WALLET };
  const url = `/api/route-intelligence/route-proofs/${PROOF_ID}/reconcile`;

  beforeEach(() => {
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    routeProofRouteRuntime.migrationAvailable = async () => true;
    routeProofRouteRuntime.now = () => NOW;
    routeProofRouteRuntime.reconcile = async () => ({
      outcome: 'completed',
      proof: PROOF_PROJECTION,
      lifecycle: 'completed',
    }) as never;
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(routeProofRouteRuntime, originalProofRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('returns a stable disabled error without reconciling', async () => {
    let reconciled = false;
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    routeProofRouteRuntime.reconcile = async () => {
      reconciled = true;
      throw new Error('must not run');
    };
    const response = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    assert.equal(reconciled, false);
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    assert.equal((await request(routeApp(null)).post(url).send(RECONCILE_BODY)).status, 401);
    const mismatch = await request(routeApp()).post(url).send({
      ...RECONCILE_BODY,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects an invalid body and a non-mainnet runtime context', async () => {
    const missingRun = await request(routeApp()).post(url).send({ walletAddress: WALLET });
    assert.equal(missingRun.status, 400);
    assert.equal(missingRun.body.code, 'invalid_route_proof_reconcile_request');
    const extra = await request(routeApp()).post(url).send({ ...RECONCILE_BODY, rpcUrl: 'https://attacker.example' });
    assert.equal(extra.status, 400);

    delete process.env.CHAIN_ENV;
    assert.equal((await request(routeApp()).post(url).send(RECONCILE_BODY)).status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('maps typed binding errors to 404/403/409 and everything else to an opaque 500', async () => {
    routeProofRouteRuntime.reconcile = async () => {
      throw new RouteProofReconcileBindingError('route_proof_not_found', 'no such proof');
    };
    const notFound = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(notFound.status, 404);
    assert.deepEqual(notFound.body, { error: 'route_proof_not_found', code: 'route_proof_not_found' });

    routeProofRouteRuntime.reconcile = async () => {
      throw new RouteProofReconcileBindingError('wallet_mismatch', 'wrong wallet');
    };
    assert.equal((await request(routeApp()).post(url).send(RECONCILE_BODY)).status, 403);

    routeProofRouteRuntime.reconcile = async () => {
      throw new RouteProofReconcileBindingError('route_proof_conflict', 'event chain broken');
    };
    const conflict = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: 'route_proof_conflict', code: 'route_proof_conflict' });

    routeProofRouteRuntime.reconcile = async () => { throw new Error('secret reconcile detail'); };
    const failed = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'route_proof_reconcile_failed', code: 'route_proof_reconcile_failed' });
    assert.equal(JSON.stringify(failed.body).includes('secret reconcile detail'), false);
  });

  test('fails closed on missing storage', async () => {
    routeProofRouteRuntime.migrationAvailable = async () => false;
    const unavailable = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, 'route_storage_unavailable');
  });

  test('propagates the reconciler outcome verbatim through the validated response', async () => {
    const response = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'completed');
    assert.equal(response.body.lifecycle, 'completed');
    assert.deepEqual(response.body.proof, PROOF_PROJECTION);
    assert.equal(/send_calls|x402/i.test(JSON.stringify(response.body)), false);

    routeProofRouteRuntime.reconcile = async () => ({
      outcome: 'reconciliation_required',
      proof: {
        ...PROOF_PROJECTION,
        actualOutput: null,
        // A native output emits no Transfer log, so the amount is not readable
        // from the receipt and the projection says which of the two it is.
        actualOutputUnavailableReason: 'native_output_unverifiable' as const,
        finalStatus: 'reconciliation_required',
        reconciliationState: 'manual_review',
      },
      lifecycle: 'reconciliation_required',
    }) as never;
    const manual = await request(routeApp()).post(url).send(RECONCILE_BODY);
    assert.equal(manual.status, 200);
    assert.equal(manual.body.outcome, 'reconciliation_required');
    assert.equal(manual.body.proof.actualOutput, null);
  });
});

describe('GET /api/route-intelligence/route-proofs/:proofId', () => {
  const originalProofRuntime = { ...routeProofRouteRuntime };
  const url = `/api/route-intelligence/route-proofs/${PROOF_ID}`;

  beforeEach(() => {
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    routeProofRouteRuntime.migrationAvailable = async () => true;
    routeProofRouteRuntime.getProof = async () => ({
      proof: PROOF_PROJECTION,
      lifecycle: 'completed',
      events: [
        { eventIndex: 0, eventType: 'calls_approved', createdAt: '2026-07-18T12:00:00.000Z' },
        { eventIndex: 1, eventType: 'completed', createdAt: '2026-07-18T12:01:00.000Z' },
      ],
    }) as never;
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(routeProofRouteRuntime, originalProofRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('guards: flag 404, session 401, chain 409, storage 503', async () => {
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    assert.equal((await request(routeApp()).get(url)).status, 404);
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });

    assert.equal((await request(routeApp(null)).get(url)).status, 401);

    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).get(url);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
    process.env.CHAIN_ENV = 'mainnet-readonly';

    routeProofRouteRuntime.migrationAvailable = async () => false;
    assert.equal((await request(routeApp()).get(url)).status, 503);
  });

  test('a foreign or missing proof id is a stable 404 without an existence leak', async () => {
    let requestedProofId: string | null = null;
    routeProofRouteRuntime.getProof = async (input) => {
      requestedProofId = input.proofId;
      return null;
    };
    const response = await request(routeApp()).get(url);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'route_proof_not_found', code: 'route_proof_not_found' });
    assert.equal(requestedProofId, PROOF_ID);
  });

  test('returns the validated user-safe projection with lifecycle and payload-free events', async () => {
    const response = await request(routeApp()).get(url);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.proof, PROOF_PROJECTION);
    assert.equal(response.body.lifecycle, 'completed');
    assert.deepEqual(response.body.events, [
      { eventIndex: 0, eventType: 'calls_approved', createdAt: '2026-07-18T12:00:00.000Z' },
      { eventIndex: 1, eventType: 'completed', createdAt: '2026-07-18T12:01:00.000Z' },
    ]);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('tenantId'), false);
    assert.equal(serialized.includes('payload'), false);
  });

  test('opaque 500 on runtime errors', async () => {
    routeProofRouteRuntime.getProof = async () => { throw new Error('secret get detail'); };
    const failed = await request(routeApp()).get(url);
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(failed.body).includes('secret get detail'), false);
  });
});

describe('GET /api/route-intelligence/history', () => {
  const originalProofRuntime = { ...routeProofRouteRuntime };
  const url = '/api/route-intelligence/history';
  const HISTORY_ITEM = {
    routeRunId: 'run-t58-fixture',
    createdAt: '2026-07-18T12:00:00.000Z',
    runStatus: 'ready',
    intentHash: `0x${'7'.repeat(64)}`,
    intentSummary: 'swap 100 USDC -> WETH',
    blueprintId: 'blueprint-t58-route-fixture',
    blueprintStatus: 'approved',
    proofId: PROOF_ID,
    proofFinalStatus: 'completed',
    reconciliationState: 'matched',
    provider: null,
  };

  beforeEach(() => {
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    routeProofRouteRuntime.migrationAvailable = async () => true;
    routeProofRouteRuntime.listHistory = async () => ({ items: [HISTORY_ITEM], nextCursor: null });
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(routeProofRouteRuntime, originalProofRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('guards: flag 404, session 401, chain 409, storage 503', async () => {
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });
    assert.equal((await request(routeApp()).get(url)).status, 404);
    routeProofRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, tokenIdentityV1: false, });

    assert.equal((await request(routeApp(null)).get(url)).status, 401);

    process.env.CHAIN_ENV = 'sepolia';
    assert.equal((await request(routeApp()).get(url)).status, 409);
    process.env.CHAIN_ENV = 'mainnet-readonly';

    routeProofRouteRuntime.migrationAvailable = async () => false;
    assert.equal((await request(routeApp()).get(url)).status, 503);
  });

  test('rejects an invalid limit and an undecodable cursor with 400', async () => {
    const zero = await request(routeApp()).get(`${url}?limit=0`);
    assert.equal(zero.status, 400);
    assert.equal(zero.body.code, 'invalid_history_request');
    const tooBig = await request(routeApp()).get(`${url}?limit=100`);
    assert.equal(tooBig.status, 400);
    const notANumber = await request(routeApp()).get(`${url}?limit=abc`);
    assert.equal(notANumber.status, 400);

    routeProofRouteRuntime.listHistory = async () => {
      throw new RouteStorageIntegrityError('cursor is garbage');
    };
    const badCursor = await request(routeApp()).get(`${url}?cursor=%21%21not-base64url%21%21`);
    assert.equal(badCursor.status, 400);
    assert.deepEqual(badCursor.body, { error: 'invalid_history_request', code: 'invalid_history_request' });
  });

  test('passes limit/cursor through, is tenant-bound, and returns a validated page', async () => {
    let received: { tenantId: string; limit: number; cursor?: string } | null = null;
    routeProofRouteRuntime.listHistory = async (input) => {
      received = input;
      return { items: [HISTORY_ITEM], nextCursor: 'bmV4dA' };
    };
    const response = await request(routeApp()).get(`${url}?limit=5&cursor=bmV4dA`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items: [HISTORY_ITEM], nextCursor: 'bmV4dA' });
    assert.deepEqual(received, { tenantId: USER.id, limit: 5, cursor: 'bmV4dA' });
  });

  test('opaque 500 on non-cursor runtime failures', async () => {
    routeProofRouteRuntime.listHistory = async () => { throw new Error('secret history detail'); };
    const failed = await request(routeApp()).get(url);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: 'history_failed', code: 'history_failed' });
  });
});
