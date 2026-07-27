import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRouteStorageRepository, type RouteStorageRepository } from '@mioagent/route-storage';
import type { SimulationProvider, SimulationProviderResultV1 } from '@mioagent/paid-intelligence';
import { hashIntelligenceBudgetV1 } from '@mioagent/intelligence-budget';
import type {
  SpendPermissionCharger,
  SpendPermissionChargeResultV1,
  SpendPermissionPreflightResultV1,
  SpendPermissionSnapshotV1,
  SpendPermissionSourceV1,
  ConfirmedSettlementProofV1,
} from '@mioagent/intelligence-budget';
import { ZERO_HASH_V1, type ExecutionBlueprintV1, type SimulationStateV1 } from '@mioagent/route-domain';
import { buildTransactionReviewProjectionV1 } from '@mioagent/transaction-composer';
import { createRouteStorageFixtureGraph, type RouteStorageFixtureGraph } from '../../../lib/route-storage/test/fixture-graph.js';
import { routeIntelligenceRouter, budgetRouteRuntime } from './routeIntelligence.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-15T09:02:00.000Z');
const PERMISSION_ID = 'permission-api-1';

const USDC_ASSET = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453 as const,
  kind: 'erc20' as const,
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const,
  symbol: 'USDC',
  decimals: 6,
};
const PRICE = { asset: USDC_ASSET, amountAtomic: '10000', amountDecimal: '0.01', usdValue: '0.01' };

const originalRuntime = { ...budgetRouteRuntime };
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

async function seedGraph(): Promise<{ repository: InMemoryRouteStorageRepository; graph: RouteStorageFixtureGraph }> {
  const graph = createRouteStorageFixtureGraph(USER.id, 't60-budget', WALLET as `0x${string}`);
  const repository = new InMemoryRouteStorageRepository();
  await repository.createRouteRun(graph.intent, `${graph.intent.id}:idempotency`);
  await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
  for (const record of graph.completeEvidenceSet.records) {
    await repository.insertEvidence(graph.intent.id, graph.uniswapCandidate.id, record);
  }
  await repository.insertEvidenceSet(graph.intent.id, graph.uniswapCandidate.id, graph.completeEvidenceSet);
  await repository.insertBlueprint(graph.intent.id, graph.blueprint);
  return { repository, graph };
}

async function seedBudget(
  repository: InMemoryRouteStorageRepository,
  overrides: { periodLimitAtomic?: string; maxPerCallAtomic?: string; status?: 'active' | 'paused' } = {},
) {
  const nowIso = NOW.toISOString();
  const periodLimitAtomic = overrides.periodLimitAtomic ?? '1000000';
  const maxPerCallAtomic = overrides.maxPerCallAtomic ?? '100000';
  const status = overrides.status ?? 'active';
  const draft = {
    schemaVersion: 'intelligence-budget/v1' as const,
    id: 'budget-api-1',
    tenantId: USER.id,
    walletAddress: WALLET as `0x${string}`,
    chainId: 8453 as const,
    createdAt: nowIso,
    updatedAt: nowIso,
    status,
    spendPermissionId: PERMISSION_ID,
    periodType: 'monthly' as const,
    asset: USDC_ASSET,
    periodLimitAtomic,
    periodSpentAtomic: '0',
    reservedAtomic: '0',
    maxPerCallAtomic,
    allowedCategories: ['simulation' as const],
    periodStartedAt: nowIso,
    periodEndsAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null,
    budgetHash: ZERO_HASH_V1,
  };
  const budgetHash = hashIntelligenceBudgetV1(draft);
  return repository.insertIntelligenceBudget({
    id: draft.id,
    schemaVersion: draft.schemaVersion,
    userId: USER.id,
    walletAddress: WALLET,
    chainId: 8453,
    spendPermissionId: PERMISSION_ID,
    status,
    periodType: 'monthly',
    periodLimitAtomic,
    maxPerCallAtomic,
    allowedCategories: ['simulation'],
    periodStartedAt: nowIso,
    periodEndsAt: '2027-01-01T00:00:00.000Z',
    budgetHash,
    now: nowIso,
  });
}

/** Self-contained SpendPermissionSourceV1 stub — no @mioagent/autonomy, no
 * on-chain call. Mirrors the proof-keyed idempotent incrementSpent semantics. */
function stubSpendPermissionSource(
  overrides: Partial<SpendPermissionSnapshotV1> = {},
): SpendPermissionSourceV1 & { spent: () => number; incrementCount: () => number } {
  const permission: SpendPermissionSnapshotV1 = {
    id: PERMISSION_ID,
    userId: USER.id,
    chainId: 8453,
    asset: USDC_ASSET.address,
    limit: 1_000_000,
    spent: 0,
    whitelist: [],
    expiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
    isActive: true,
    ...overrides,
  };
  const appliedProofs = new Set<string>();
  let spent = permission.spent;
  let incrementCount = 0;
  return {
    async getById(id: string) {
      return id === permission.id ? { ...permission, spent } : undefined;
    },
    async incrementSpent(id: string, amount: number, proof: ConfirmedSettlementProofV1) {
      if (id !== permission.id) return undefined;
      const key = proof.txHash ?? proof.receiptId ?? proof.batchId ?? proof.x402ReceiptId ?? '';
      incrementCount += 1;
      if (appliedProofs.has(key)) return { ...permission, spent };
      appliedProofs.add(key);
      spent += amount;
      return { ...permission, spent };
    },
    spent: () => spent,
    incrementCount: () => incrementCount,
  };
}

function stubCharger(
  options: { preflightOk?: boolean; chargeOk?: boolean } = {},
): SpendPermissionCharger & { preflightCount: () => number; chargeCount: () => number } {
  let preflightCount = 0;
  let chargeCount = 0;
  const preflightOk = options.preflightOk ?? true;
  const chargeOk = options.chargeOk ?? true;
  return {
    async preflight(): Promise<SpendPermissionPreflightResultV1> {
      preflightCount += 1;
      return preflightOk ? { ok: true } : { ok: false, reason: 'permission_inactive' };
    },
    async charge(): Promise<SpendPermissionChargeResultV1> {
      chargeCount += 1;
      return chargeOk ? { ok: true, proof: { txHash: `0x${'a'.repeat(64)}` } } : { ok: false, reason: 'charge_failed' };
    },
    preflightCount: () => preflightCount,
    chargeCount: () => chargeCount,
  };
}

const SUCCESS_BODY = {
  status: 'success' as const,
  blockNumber: 33_555_111,
  gasUsed: '145000',
  stateChanges: [],
  revertReason: null,
};

function stubProvider(
  result: SimulationProviderResultV1 = { ok: true, body: SUCCESS_BODY },
): SimulationProvider & { callCount: () => number } {
  let calls = 0;
  return {
    providerId: 'stub-sim-v1',
    async simulate(): Promise<SimulationProviderResultV1> {
      calls += 1;
      return result;
    },
    callCount: () => calls,
  };
}

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

function resetRuntime() {
  Object.assign(budgetRouteRuntime, originalRuntime);
  budgetRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: true, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false });
  budgetRouteRuntime.migrationAvailable = async () => true;
  budgetRouteRuntime.now = () => NOW;
  budgetRouteRuntime.pricing = () => ({ amountAtomic: '10000', decimalUsdc: '0.01', price: PRICE });
  budgetRouteRuntime.providerConfig = () => ({
    configured: true,
    url: 'https://sim.example.test/simulate',
    providerId: 'stub-sim-v1',
    allowlist: ['sim.example.test'],
  });
  budgetRouteRuntime.reservationTtlMs = () => 900_000;
  process.env.CHAIN_ENV = 'mainnet-readonly';
}

describe('T60 Intelligence Budget CRUD routes', () => {
  beforeEach(() => resetRuntime());
  afterEach(() => {
    Object.assign(budgetRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('all budget routes 404 when paidIntelligence is off even with routeIntelligenceV1 on', async () => {
    budgetRouteRuntime.flags = () => ({ routeIntelligenceV1: true, legacyTerminal: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false });
    const response = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'intelligence_budget_disabled');
  });

  test('GET requires a signed session', async () => {
    const response = await request(routeApp(null)).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 401);
  });

  test('GET requires Base mainnet runtime', async () => {
    process.env.CHAIN_ENV = 'sepolia';
    const response = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'base_mainnet_required');
  });

  test('GET fails closed 503 when the T60 migration is unavailable', async () => {
    budgetRouteRuntime.migrationAvailable = async () => false;
    const response = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 503);
  });

  test('GET returns null when the caller has no active budget', async () => {
    const repository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => repository;
    const response = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 200);
    assert.equal(response.body.budget, null);
  });

  test('GET returns the projection (decimal USDC, no tenantId/hash) when a budget exists', async () => {
    const { repository } = await seedGraph();
    await seedBudget(repository);
    budgetRouteRuntime.repository = () => repository;
    const response = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(response.status, 200);
    assert.equal(response.body.budget.status, 'active');
    assert.equal(response.body.budget.monthlyLimitUsdc, '1');
    assert.equal(response.body.budget.maxPerRequestUsdc, '0.1');
    assert.equal(response.body.budget.remainingUsdc, '1');
    assert.deepEqual(response.body.budget.allowedCategories, ['simulation']);
    assert.equal(response.body.budget.linkedSpendPermissionId, PERMISSION_ID);
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('tenantId'), false);
    assert.equal(serialized.includes('budgetHash'), false);
  });

  test('POST create rejects when no active Spend Permission exists -> 409 spend_permission_required', async () => {
    const repository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => repository;
    budgetRouteRuntime.spendPermissionRepository = () => stubSpendPermissionSource({ isActive: false });
    const response = await request(routeApp())
      .post('/api/route-intelligence/intelligence-budget')
      .send({ spendPermissionId: PERMISSION_ID, walletAddress: WALLET, periodLimitUsdc: '1', maxPerCallUsdc: '0.1', allowedCategories: ['simulation'] });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'spend_permission_required');
  });

  test('POST create wallet mismatch -> 403', async () => {
    const response = await request(routeApp())
      .post('/api/route-intelligence/intelligence-budget')
      .send({ spendPermissionId: PERMISSION_ID, walletAddress: '0x2222222222222222222222222222222222222222', periodLimitUsdc: '1', maxPerCallUsdc: '0.1', allowedCategories: ['simulation'] });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'wallet_mismatch');
  });

  test('POST create succeeds (201) then a second create is 409 intelligence_budget_exists', async () => {
    const repository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => repository;
    budgetRouteRuntime.spendPermissionRepository = () => stubSpendPermissionSource();
    const body = { spendPermissionId: PERMISSION_ID, walletAddress: WALLET, periodLimitUsdc: '1', maxPerCallUsdc: '0.1', allowedCategories: ['simulation'] };
    const first = await request(routeApp()).post('/api/route-intelligence/intelligence-budget').send(body);
    assert.equal(first.status, 201);
    assert.equal(first.body.budget.status, 'active');
    assert.equal(first.body.budget.monthlyLimitUsdc, '1');

    const second = await request(routeApp()).post('/api/route-intelligence/intelligence-budget').send(body);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'intelligence_budget_exists');
  });

  test('POST create rejects maxPerCall > periodLimit -> 400 invalid_intelligence_budget_request', async () => {
    const repository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => repository;
    budgetRouteRuntime.spendPermissionRepository = () => stubSpendPermissionSource();
    const response = await request(routeApp())
      .post('/api/route-intelligence/intelligence-budget')
      .send({ spendPermissionId: PERMISSION_ID, walletAddress: WALLET, periodLimitUsdc: '1', maxPerCallUsdc: '2', allowedCategories: ['simulation'] });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_intelligence_budget_request');
  });

  test('PATCH updates limits on the active budget; PATCH with no budget -> 404', async () => {
    const { repository } = await seedGraph();
    await seedBudget(repository);
    budgetRouteRuntime.repository = () => repository;
    const response = await request(routeApp())
      .patch('/api/route-intelligence/intelligence-budget')
      .send({ periodLimitUsdc: '2', maxPerCallUsdc: '0.5' });
    assert.equal(response.status, 200);
    assert.equal(response.body.budget.monthlyLimitUsdc, '2');
    assert.equal(response.body.budget.maxPerRequestUsdc, '0.5');

    const emptyRepository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => emptyRepository;
    const missing = await request(routeApp())
      .patch('/api/route-intelligence/intelligence-budget')
      .send({ periodLimitUsdc: '2' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'intelligence_budget_not_found');
  });

  test('revoke sets status revoked; revoke with no budget -> 404', async () => {
    const { repository } = await seedGraph();
    await seedBudget(repository);
    budgetRouteRuntime.repository = () => repository;
    const response = await request(routeApp()).post('/api/route-intelligence/intelligence-budget/revoke').send({});
    assert.equal(response.status, 200);
    assert.equal(response.body.budget.status, 'revoked');
    // After revoke, GET returns null (getActiveIntelligenceBudget only sees active).
    const afterRevoke = await request(routeApp()).get('/api/route-intelligence/intelligence-budget');
    assert.equal(afterRevoke.body.budget, null);

    const emptyRepository = new InMemoryRouteStorageRepository();
    budgetRouteRuntime.repository = () => emptyRepository;
    const missing = await request(routeApp()).post('/api/route-intelligence/intelligence-budget/revoke').send({});
    assert.equal(missing.status, 404);
  });
});

describe('POST /api/route-intelligence/blueprints/:id/simulate-with-budget', () => {
  beforeEach(() => resetRuntime());
  afterEach(() => {
    Object.assign(budgetRouteRuntime, originalRuntime);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  async function wireHappyPath(chargerOptions: { preflightOk?: boolean; chargeOk?: boolean } = {}, providerResult?: SimulationProviderResultV1, budgetOverrides = {}) {
    const { repository, graph } = await seedGraph();
    await seedBudget(repository, budgetOverrides);
    const charger = stubCharger(chargerOptions);
    const provider = stubProvider(providerResult);
    const source = stubSpendPermissionSource();
    budgetRouteRuntime.repository = () => repository;
    budgetRouteRuntime.spendPermissionRepository = () => source;
    budgetRouteRuntime.charger = () => charger;
    budgetRouteRuntime.createProvider = () => provider;
    budgetRouteRuntime.buildReview = stubReviewFor(graph);
    return { repository, graph, charger, provider, source };
  }

  function budgetBody(graph: RouteStorageFixtureGraph, requestId = 'req-1') {
    return { routeRunId: graph.intent.id, walletAddress: WALLET, blueprintHash: graph.blueprint.blueprintHash, requestId };
  }

  test('is a plain POST (no x402 / no signature) — charged happy path: charge called once, spent recorded once', async () => {
    const { graph, charger, provider, source } = await wireHappyPath();
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send(budgetBody(graph));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'charged');
    assert.equal(response.body.charge.status, 'settled');
    assert.equal(response.body.budget.status, 'active');
    assert.equal(response.body.budget.spentUsdc, '0.01');
    assert.ok(response.body.evidence);
    assert.ok(response.body.review);
    assert.equal(charger.chargeCount(), 1);
    assert.equal(provider.callCount(), 1);
    assert.equal(source.spent(), 0.01);
  });

  test('idempotent replay with the SAME requestId never charges twice', async () => {
    const { graph, charger, provider } = await wireHappyPath();
    const app = routeApp();
    const first = await request(app).post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`).send(budgetBody(graph, 'req-idem'));
    assert.equal(first.body.outcome, 'charged');
    const second = await request(app).post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`).send(budgetBody(graph, 'req-idem'));
    assert.equal(second.body.outcome, 'charged');
    assert.equal(charger.chargeCount(), 1);
    assert.equal(provider.callCount(), 1);
  });

  test('provider failure -> 200 provider_failed, user NEVER charged, reservation released', async () => {
    const { graph, charger, source } = await wireHappyPath({}, { ok: false, errorCode: 'timeout', detail: 'timed out' });
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send(budgetBody(graph));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'provider_failed');
    assert.equal(charger.chargeCount(), 0);
    assert.equal(source.spent(), 0);
  });

  test('charge failure after delivery -> 200 reconciliation_required, budget paused', async () => {
    const { graph, charger } = await wireHappyPath({ chargeOk: false });
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send(budgetBody(graph));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'reconciliation_required');
    assert.equal(response.body.budget.status, 'paused');
    assert.equal(charger.chargeCount(), 1);
  });

  test('price above per-call maximum -> 200 limit_exceeded, provider never called', async () => {
    const { graph, charger, provider } = await wireHappyPath({}, undefined, { maxPerCallAtomic: '5000' });
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send(budgetBody(graph));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'limit_exceeded');
    assert.equal(provider.callCount(), 0);
    assert.equal(charger.chargeCount(), 0);
  });

  test('no active budget -> 200 blocked', async () => {
    const { repository, graph } = await seedGraph();
    budgetRouteRuntime.repository = () => repository;
    budgetRouteRuntime.spendPermissionRepository = () => stubSpendPermissionSource();
    budgetRouteRuntime.charger = () => stubCharger();
    budgetRouteRuntime.createProvider = () => stubProvider();
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send(budgetBody(graph));
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'blocked');
  });

  test('wallet mismatch -> 403 before any charge', async () => {
    const { graph, charger } = await wireHappyPath();
    const response = await request(routeApp())
      .post(`/api/route-intelligence/blueprints/${graph.blueprint.id}/simulate-with-budget`)
      .send({ ...budgetBody(graph), walletAddress: '0x2222222222222222222222222222222222222222' });
    assert.equal(response.status, 403);
    assert.equal(charger.chargeCount(), 0);
  });
});
