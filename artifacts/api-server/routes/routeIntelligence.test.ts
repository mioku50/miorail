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
import {
  routeIntelligenceRouter,
  routePlanRouteRuntime,
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
    routePlanRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false });
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
      classifySwapCallV1({ index: 0, call: { to: USDC.address, value: '0', data: approveData }, routerAddress: ROUTER, usdcAsset: USDC, walletAddress: WALLET }),
      classifySwapCallV1({ index: 1, call: { to: ROUTER, value: '0', data: '0x12345678' }, routerAddress: ROUTER, usdcAsset: USDC, walletAddress: WALLET }),
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
    swapPrepareRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false });
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
    swapPrepareRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false });
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
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false });
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
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false });
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
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false });
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
    swapBlueprintRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: false });
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
