import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRouteStorageRepository, type RouteStorageRepository } from '@mioagent/route-storage';
import type { SimulationProvider, SimulationProviderResultV1 } from '@mioagent/paid-intelligence';
import type { ExecutionBlueprintV1, SimulationStateV1 } from '@mioagent/route-domain';
import { buildTransactionReviewProjectionV1 } from '@mioagent/transaction-composer';
import { createRouteStorageFixtureGraph, type RouteStorageFixtureGraph } from '../../../lib/route-storage/test/fixture-graph.js';
import { routeIntelligenceRouter, simulateRouteRuntime, simulateSettlementStorage } from './routeIntelligence.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-15T09:02:00.000Z');

const originalRuntime = { ...simulateRouteRuntime };
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

async function seedRepository(): Promise<{
  repository: RouteStorageRepository;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
  graph: RouteStorageFixtureGraph;
}> {
  const graph = createRouteStorageFixtureGraph(USER.id, 't59-simulate', WALLET as `0x${string}`);
  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(graph.intent, `${graph.intent.id}:idempotency`);
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  await repository.insertCandidate(graph.intent.id, graph.kyberSwapCandidate);
  for (const record of graph.completeEvidenceSet.records) {
    await repository.insertEvidence(graph.intent.id, graph.uniswapCandidate.id, record);
  }
  await repository.insertEvidenceSet(graph.intent.id, graph.uniswapCandidate.id, graph.completeEvidenceSet);
  await repository.insertBlueprint(graph.intent.id, graph.blueprint);
  return {
    repository,
    routeRunId: graph.intent.id,
    blueprintId: graph.blueprint.id,
    blueprintHash: graph.blueprint.blueprintHash,
    graph,
  };
}

/** Stubs the Safety Kernel / contract-security re-run (already covered by
 * @mioagent/transaction-composer's own unit tests) with a real, valid
 * TransactionReviewProjectionV1 — same seam every other route in this file
 * uses (stubbing the whole prepare/coordinate call, never re-exercising the
 * Safety Kernel through an HTTP-level test). */
function stubReviewFor(graph: RouteStorageFixtureGraph) {
  return async (
    _repository: RouteStorageRepository,
    routeRunId: string,
    blueprint: ExecutionBlueprintV1,
    _walletAddress: `0x${string}`,
    simulationStateOverride: SimulationStateV1,
  ) => {
    const review = buildTransactionReviewProjectionV1({
      routeRunId,
      provider: graph.uniswapCandidate.provider,
      input: graph.uniswapCandidate.inputAmount,
      expectedOutput: graph.uniswapCandidate.expectedOutput,
      minimumOutput: graph.uniswapCandidate.minimumOutput,
      cardExpectedOutput: graph.uniswapCandidate.expectedOutput,
      cardMinimumOutput: graph.uniswapCandidate.minimumOutput,
      blueprint,
      safety: {
        schemaVersion: 'safety-kernel-result/v1',
        verdict: 'allowed',
        checks: [{ id: 'stub_check', description: 'stub', status: 'passed', detail: null }],
        blockedReason: null,
      },
      contractSecurity: { provider: 'goplus', required: true, status: 'passed', verdicts: [] },
      simulationWarning: null,
      simulationStateOverride,
    });
    return { outcome: 'ready' as const, review };
  };
}

function stubProvider(
  result: SimulationProviderResultV1 | ((request: unknown) => SimulationProviderResultV1),
): SimulationProvider & { callCount: number } {
  const provider = {
    providerId: 'stub-sim-v1',
    callCount: 0,
    async simulate(req: unknown): Promise<SimulationProviderResultV1> {
      provider.callCount += 1;
      return typeof result === 'function' ? result(req) : result;
    },
  };
  return provider;
}

const SUCCESS_BODY = {
  status: 'success' as const,
  blockNumber: 33_555_111,
  gasUsed: '145000',
  stateChanges: [],
  revertReason: null,
};

function stubSettlementPaymentMiddleware(txHash = `0x${'a'.repeat(64)}`) {
  let calls = 0;
  const middleware = (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => {
    calls += 1;
    const ctx = simulateSettlementStorage.getStore();
    if (ctx) ctx.settlement = { txHash, payer: WALLET, network: 'eip155:8453', amount: '10000', status: 'settled' };
    next();
  };
  return { middleware: middleware as unknown as typeof simulateRouteRuntime.paymentMiddleware, callCount: () => calls };
}

function resetSimulateRuntime() {
  Object.assign(simulateRouteRuntime, originalRuntime);
  simulateRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: true, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false });
  simulateRouteRuntime.migrationAvailable = async () => true;
  simulateRouteRuntime.now = () => NOW;
  simulateRouteRuntime.pricing = () => ({
    amountAtomic: '10000',
    decimalUsdc: '0.01',
    price: {
      asset: {
        assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        chainId: 8453,
        kind: 'erc20',
        address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        symbol: 'USDC',
        decimals: 6,
      },
      amountAtomic: '10000',
      amountDecimal: '0.01',
      usdValue: '0.01',
    },
  });
  simulateRouteRuntime.providerConfig = () => ({
    configured: true,
    url: 'https://sim.example.test/simulate',
    providerId: 'stub-sim-v1',
    allowlist: ['sim.example.test'],
  });
  process.env.CHAIN_ENV = 'mainnet-readonly';
}

describe('POST /api/route-intelligence/blueprints/:blueprintId/simulate', () => {
  beforeEach(() => {
    resetSimulateRuntime();
  });

  afterEach(() => {
    Object.assign(simulateRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  function requestBody(overrides: Partial<{ routeRunId: string; walletAddress: string; blueprintHash: string; idempotencyKey: string }> = {}) {
    return {
      routeRunId: 'run-1',
      walletAddress: WALLET,
      blueprintHash: `0x${'1'.repeat(64)}`,
      idempotencyKey: 'idem-test-key-1',
      ...overrides,
    };
  }

  test('returns a stable disabled error (404) when paidIntelligence is off, even with routeIntelligenceV1 on', async () => {
    simulateRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false });
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'paid_intelligence_disabled');
  });

  test('returns 404 when routeIntelligenceV1 is off regardless of paidIntelligence', async () => {
    simulateRouteRuntime.flags = () => ({ routeIntelligenceV1: false, legacyTerminal: true, paidIntelligence: true, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false });
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'paid_intelligence_disabled');
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    const unauth = await request(routeApp(null))
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(unauth.status, 401);

    const mismatch = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody({ walletAddress: '0x2222222222222222222222222222222222222222' }));
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('rejects a malformed body (short idempotencyKey, no calldata field accepted)', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody({ idempotencyKey: 'short' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_simulation_request');

    const withCalldata = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send({ ...requestBody(), calls: [{ to: WALLET, value: '0', data: '0x' }] });
    assert.equal(withCalldata.status, 400);
  });

  test('requires Base mainnet runtime context', async () => {
    process.env.CHAIN_ENV = 'sepolia';
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'base_mainnet_required');
  });

  test('fails closed with 503 when the extended migration check (intelligence_charges) is unavailable', async () => {
    simulateRouteRuntime.migrationAvailable = async () => false;
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'paid_intelligence_unavailable');
  });

  test('fails closed with 503 when the simulation provider/price is not configured — no facilitator leak', async () => {
    simulateRouteRuntime.providerConfig = () => ({ configured: false, providerId: 'generic-sim-v1', allowlist: [] });
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/b1/simulate')
      .send(requestBody());
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'simulation_provider_unavailable');
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('facilitator'), false);
    assert.equal(serialized.includes('sim.example.test'), false);
  });

  test('a missing/foreign blueprint id is a stable 404', async () => {
    const { repository, routeRunId } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    const response = await request(routeApp())
      .post('/api/route-intelligence/blueprints/does-not-exist/simulate')
      .send(requestBody({ routeRunId }));
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'blueprint_not_found');
  });

  test('rejects a blueprintHash that does not match the stored Blueprint', async () => {
    const { repository, routeRunId, blueprintId } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash: `0x${'9'.repeat(64)}` }));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'blueprint_hash_mismatch');
  });

  test('a request without any payment gets a 402 from the payment gate stub (client-cancellation server view)', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    // Stand-in for the real x402 middleware refusing an unpaid request.
    simulateRouteRuntime.paymentMiddleware = (_req, res) => {
      (res as { status: (n: number) => { json: (b: unknown) => void } }).status(402).json({
        x402Version: 2,
        accepts: [],
        error: 'Payment Required',
      });
    };
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(response.status, 402);
  });

  test('happy path: settles, simulates, and returns outcome simulated with a review and scoreNote', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash, graph } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    simulateRouteRuntime.buildReview = stubReviewFor(graph);
    const provider = stubProvider({ ok: true, body: SUCCESS_BODY });
    simulateRouteRuntime.createProvider = () => provider;
    const stub = stubSettlementPaymentMiddleware();
    simulateRouteRuntime.paymentMiddleware = stub.middleware;

    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));

    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'simulated');
    assert.equal(response.body.simulation.status, 'passed');
    assert.equal(response.body.scoreNote.transactionSafety, 'not_scored');
    assert.equal(response.body.charge.status, 'settled');
    assert.equal(response.body.charge.paymentState, 'settled');
    assert.equal(response.body.charge.serviceState, 'delivered');
    assert.equal(provider.callCount, 1);
    assert.equal(stub.callCount(), 1);
  });

  test('idempotent repeat with the same key returns cached WITHOUT invoking the payment middleware again', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash, graph } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    simulateRouteRuntime.buildReview = stubReviewFor(graph);
    const provider = stubProvider({ ok: true, body: SUCCESS_BODY });
    simulateRouteRuntime.createProvider = () => provider;
    const stub = stubSettlementPaymentMiddleware();
    simulateRouteRuntime.paymentMiddleware = stub.middleware;

    const first = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, 'simulated');
    assert.equal(stub.callCount(), 1);
    assert.equal(provider.callCount, 1);

    const second = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(second.status, 200);
    assert.equal(second.body.outcome, 'cached');
    // Neither the payment middleware nor the provider ran a second time.
    assert.equal(stub.callCount(), 1);
    assert.equal(provider.callCount, 1);
    assert.equal(second.body.charge.chargeId, first.body.charge.chargeId);
  });

  test('a different idempotencyKey while an active charge exists for the same blueprint is a 409 charge_conflict', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    // Never settle — leave the first charge 'payment_pending' (active).
    simulateRouteRuntime.paymentMiddleware = (_req, res) => {
      (res as { status: (n: number) => { end: () => void } }).status(402).end();
    };
    const first = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash, idempotencyKey: 'idem-test-key-a' }));
    assert.equal(first.status, 402);

    const second = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash, idempotencyKey: 'idem-test-key-b' }));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'charge_conflict');
  });

  test('settled+service_failed retries the service WITHOUT a second payment', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash, graph } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    simulateRouteRuntime.buildReview = stubReviewFor(graph);
    const flakyProvider = stubProvider({ ok: false, errorCode: 'timeout', detail: 'timed out' });
    simulateRouteRuntime.createProvider = () => flakyProvider;
    const stub = stubSettlementPaymentMiddleware();
    simulateRouteRuntime.paymentMiddleware = stub.middleware;

    const first = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, 'paid_service_failed');
    assert.equal(stub.callCount(), 1);

    const workingProvider = stubProvider({ ok: true, body: SUCCESS_BODY });
    simulateRouteRuntime.createProvider = () => workingProvider;
    const second = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(second.status, 200);
    assert.equal(second.body.outcome, 'simulated');
    // No second call to the payment middleware — the retry skipped payment.
    assert.equal(stub.callCount(), 1);
    assert.equal(workingProvider.callCount, 1);
  });

  // T59 rework B1: the deterministic client idempotencyKey must NEVER trap a
  // paid user in an unrecoverable state. evidence_persist_failed leaves the
  // charge serviceState 'delivered' with a NULL evidenceHash — a repeat with
  // the same key must re-run the service WITHOUT a second payment and recover
  // to a durably persisted result (pre-rework this was a permanent 500 loop).
  test('B1: evidence_persist_failed -> same-key repeat -> no second payment -> service re-runs -> evidence_persisted', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash, graph } = await seedRepository();
    let evidenceSetFailures = 1;
    const flakyRepository = new Proxy(repository, {
      get(target, prop) {
        if (prop === 'insertEvidenceSet') {
          return async (...args: unknown[]) => {
            if (evidenceSetFailures > 0) {
              evidenceSetFailures -= 1;
              throw new Error('transient storage fault');
            }
            return (target.insertEvidenceSet as (...a: unknown[]) => Promise<void>).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof repository;
    simulateRouteRuntime.repository = () => flakyRepository;
    simulateRouteRuntime.buildReview = stubReviewFor(graph);
    const provider = stubProvider({ ok: true, body: SUCCESS_BODY });
    simulateRouteRuntime.createProvider = () => provider;
    const stub = stubSettlementPaymentMiddleware();
    simulateRouteRuntime.paymentMiddleware = stub.middleware;

    const first = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, 'paid_service_failed');
    assert.equal(first.body.reason, 'evidence_persist_failed');
    assert.equal(first.body.charge.status, 'reconciliation_required');
    assert.equal(stub.callCount(), 1);
    assert.equal(provider.callCount, 1);

    // Same deterministic key: the payment middleware must NOT run again, the
    // service re-runs, and the result durably persists.
    const second = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(second.status, 200);
    assert.equal(second.body.outcome, 'simulated');
    assert.equal(second.body.charge.status, 'settled');
    assert.equal(second.body.charge.serviceState, 'delivered');
    assert.equal(stub.callCount(), 1);
    assert.equal(provider.callCount, 2);

    // And a THIRD repeat now serves the durably persisted cache — no payment,
    // no provider call.
    const third = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(third.status, 200);
    assert.equal(third.body.outcome, 'cached');
    assert.equal(stub.callCount(), 1);
    assert.equal(provider.callCount, 2);
  });

  test('never leaks internal error detail on an opaque simulation_failed', async () => {
    const { repository, routeRunId, blueprintId, blueprintHash } = await seedRepository();
    simulateRouteRuntime.repository = () => repository;
    simulateRouteRuntime.buildReview = async () => {
      throw new Error('super secret internal stack trace detail');
    };
    const provider = stubProvider({ ok: true, body: SUCCESS_BODY });
    simulateRouteRuntime.createProvider = () => provider;
    const stub = stubSettlementPaymentMiddleware();
    simulateRouteRuntime.paymentMiddleware = stub.middleware;

    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${blueprintId}/simulate`)
      .send(requestBody({ routeRunId, blueprintHash }));
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'simulation_failed');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});
