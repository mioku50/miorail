import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { RoutePlanResponseV1 } from '@mioagent/api-spec';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '@mioagent/route-card';
import type { SwapRouteEvaluationV1 } from '@mioagent/route-engine';
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
import { routeIntelligenceRouter, routePlanRouteRuntime } from './routeIntelligence.js';

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
