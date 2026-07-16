import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { RoutePlanResponseV1, SwapPrepareResponseV1 } from '@mioagent/api-spec';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '@mioagent/route-card';
import type { SwapRouteEvaluationV1 } from '@mioagent/route-engine';
import {
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
import { routeIntelligenceRouter, routePlanRouteRuntime, swapPrepareRouteRuntime } from './routeIntelligence.js';

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
