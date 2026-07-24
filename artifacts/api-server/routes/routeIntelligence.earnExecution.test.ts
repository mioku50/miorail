import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1 } from '@mioagent/earn-engine';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import {
  approveEarnBlueprintV1,
  prepareEarnDepositV1,
  recordBlueprintSubmissionV1,
} from '@mioagent/transaction-composer';
import {
  RouteProofReconcileBindingError,
  createEarnRouteProofReconciler,
  CANONICAL_BASE_USDC,
  ERC20_TRANSFER_TOPIC0,
  type BaseReceiptReader,
  type VerifiedReceiptSourceV1,
} from '@mioagent/route-proof';
import { stableHashV1, type EarnCandidateV1 } from '@mioagent/route-domain';
import { PINNED_BASE_USDC_V1 } from '@mioagent/earn-engine';
import {
  earnBlueprintRouteRuntime,
  earnExecutionGateRuntime,
  earnPrepareRouteRuntime,
  earnReconcileRouteRuntime,
  routeIntelligenceRouter,
} from './routeIntelligence.js';

// A passing pinned-contract preflight — the earn gate consults this seam, never
// a live RPC, so the suite stays offline.
const OK_PREFLIGHT = {
  ok: true as const,
  usdc: { address: PINNED_BASE_USDC_V1, codePresent: true },
  venues: [],
  failures: [] as string[],
};

// ---------------------------------------------------------------------------
// T62 §2/§3/§4/§5 — the earn execution routes (prepare / approve / submission /
// reconcile). Every runtime seam is repointed at an in-memory repo seeded by the
// REAL offline earn flow (resolve -> compare -> persist -> prepare -> approve ->
// submit) plus a mock receipt reader; there is no DB and no live provider/RPC
// call. The routes never sign, broadcast, or accept client calldata.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-21T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);
const TX_HASH = `0x${'ab'.repeat(32)}` as const;

const originalPrepare = { ...earnPrepareRouteRuntime };
const originalBlueprint = { ...earnBlueprintRouteRuntime };
const originalReconcile = { ...earnReconcileRouteRuntime };
const originalGate = { ...earnExecutionGateRuntime };
const originalChainEnv = process.env.CHAIN_ENV;
const originalRouteFlag = process.env.MIORAIL_ROUTE_INTELLIGENCE_V1;
const originalEarnFlag = process.env.MIORAIL_EARN_ROUTE_V1;

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

interface SeededEarn {
  repo: InMemoryRouteStorageRepository;
  runId: string;
  routeCardHash: `0x${string}`;
  recommendedCandidateHash: `0x${string}`;
  candidate: EarnCandidateV1;
}

/** Persists a full earn comparison into an in-memory repo (run + candidates +
 * evidence + scores + Route Card) via the real offline engine. */
async function seedPersistedComparison(): Promise<SeededEarn> {
  const repo = new InMemoryRouteStorageRepository();
  const resolution = resolveEarnIntentV1({ message: 'Deposit 500 USDC for yield.', tenantId: USER.id, walletAddress: WALLET, now: NOW });
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  const comparison = await compareEarnRoutesV1({ dataSource: createCuratedEarnDataSourceV1() }, { intent: resolution.intent, now: NOW });
  if (!comparison.ok) throw new Error('no comparison');
  const run = await repo.createEarnRouteRun(resolution.intent, 'earn-req-1');
  for (const entry of comparison.entries) {
    await repo.insertEarnCandidate(run.id, entry.candidate);
    await repo.insertEarnEvidence(run.id, entry.candidate.id, entry.evidence);
    await repo.insertEarnScore(run.id, entry.candidate.id, entry.score);
  }
  await repo.insertEarnRouteCard(run.id, comparison.routeCard);
  const recommended = (comparison.routeCard.recommendedCandidateHash ?? comparison.entries[0].candidate.candidateHash) as `0x${string}`;
  const candidate = comparison.entries.find((entry) => entry.candidate.candidateHash === recommended)!.candidate;
  return { repo, runId: run.id, routeCardHash: comparison.routeCard.routeCardHash as `0x${string}`, recommendedCandidateHash: recommended, candidate };
}

async function prepareInSeed(seed: SeededEarn) {
  const prepared = await prepareEarnDepositV1(
    { repository: seed.repo },
    { tenantId: USER.id, walletAddress: WALLET, routeRunId: seed.runId, routeCardHash: seed.routeCardHash, selectedCandidateHash: seed.recommendedCandidateHash, requestId: 'earn-prep-1', now: NOW },
  );
  if (prepared.outcome !== 'prepared') throw new Error(`prepare failed: ${prepared.outcome}`);
  return prepared.blueprint;
}

function proofIdFor(blueprintId: string): string {
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId }).slice(2)}`;
}

function padTopic(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
}

function transferLog(token: string, from: string, to: string, value: bigint) {
  return {
    address: token.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC0, padTopic(from), padTopic(to)] as [`0x${string}`, ...`0x${string}`[]],
    data: `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`,
  };
}

function mockReader(source: VerifiedReceiptSourceV1 | null): BaseReceiptReader {
  return { async getTransactionReceipt(hash) { return hash === TX_HASH ? source : null; } };
}

function earnSuccessSource(candidate: EarnCandidateV1, positionCredit: bigint): VerifiedReceiptSourceV1 {
  const logs = [transferLog(CANONICAL_BASE_USDC, WALLET, candidate.contracts.approvalSpender, BigInt('500000000'))];
  if (positionCredit > 0n) logs.push(transferLog(candidate.contracts.target, candidate.contracts.target, WALLET, positionCredit));
  return { transactionHash: TX_HASH, status: 'success', blockNumber: BigInt(33223499), gasUsed: BigInt(210000), effectiveGasPriceWei: BigInt(1200000000), logs };
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.CHAIN_ENV = 'mainnet-readonly';
  process.env.MIORAIL_ROUTE_INTELLIGENCE_V1 = 'true';
  process.env.MIORAIL_EARN_ROUTE_V1 = 'true';
  // Earn gate green by default (migration present + preflight passed); tests
  // that exercise a gate miss override these per-case.
  earnExecutionGateRuntime.migrationAvailable = async () => true;
  earnExecutionGateRuntime.preflight = async () => OK_PREFLIGHT;
});

afterEach(() => {
  Object.assign(earnPrepareRouteRuntime, originalPrepare);
  Object.assign(earnBlueprintRouteRuntime, originalBlueprint);
  Object.assign(earnReconcileRouteRuntime, originalReconcile);
  Object.assign(earnExecutionGateRuntime, originalGate);
  restore('CHAIN_ENV', originalChainEnv);
  restore('MIORAIL_ROUTE_INTELLIGENCE_V1', originalRouteFlag);
  restore('MIORAIL_EARN_ROUTE_V1', originalEarnFlag);
});

describe('POST /api/route-intelligence/earn/prepare', () => {
  const BODY = {
    routeRunId: 'earn-run',
    routeCardHash: `0x${'0'.repeat(64)}`,
    selectedCandidateHash: `0x${'0'.repeat(64)}`,
    walletAddress: WALLET,
    requestId: 'earn-prep-req-1',
  };

  test('enforces the guard chain before any storage/gate work (auth / wallet / chain)', async () => {
    earnExecutionGateRuntime.migrationAvailable = async () => { throw new Error('must not run'); };
    assert.equal((await request(routeApp(null)).post('/api/route-intelligence/earn/prepare').send(BODY)).status, 401);
    assert.equal((await request(routeApp()).post('/api/route-intelligence/earn/prepare').send({ ...BODY, walletAddress: OTHER_WALLET })).status, 403);
    delete process.env.CHAIN_ENV;
    assert.equal((await request(routeApp()).post('/api/route-intelligence/earn/prepare').send(BODY)).status, 409);
  });

  test('503 when the earn storage migration is unavailable', async () => {
    earnExecutionGateRuntime.migrationAvailable = async () => false;
    const response = await request(routeApp()).post('/api/route-intelligence/earn/prepare').send(BODY);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'earn_storage_unavailable');
  });

  test('503 earn_gate_unavailable when the pinned-contract preflight has NOT passed', async () => {
    earnExecutionGateRuntime.preflight = async () => ({
      ok: false,
      usdc: { address: PINNED_BASE_USDC_V1, codePresent: true },
      venues: [],
      failures: ['morpho_underlying_not_canonical_usdc'],
    });
    const response = await request(routeApp()).post('/api/route-intelligence/earn/prepare').send(BODY);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'earn_gate_unavailable');
  });

  test('prepared: builds the exact earn deposit Blueprint from the persisted card (2 calls, goal=earn)', async () => {
    const seed = await seedPersistedComparison();
    earnPrepareRouteRuntime.prepare = (input) => prepareEarnDepositV1({ repository: seed.repo }, input);
    earnPrepareRouteRuntime.now = () => NOW;
    const response = await request(routeApp())
      .post('/api/route-intelligence/earn/prepare')
      .send({ routeRunId: seed.runId, routeCardHash: seed.routeCardHash, selectedCandidateHash: seed.recommendedCandidateHash, walletAddress: WALLET, requestId: 'earn-prep-1' });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'prepared');
    assert.equal(response.body.blueprint.goal, 'earn');
    assert.equal(response.body.blueprint.calls.length, 2);
    assert.equal(response.body.safety.verdict, 'allowed');
    const serialized = JSON.stringify(response.body);
    assert.equal(/send_calls|walletCalls|x402/i.test(serialized), false);
  });

  test('refresh_required: an unknown card hash never builds a Blueprint', async () => {
    const seed = await seedPersistedComparison();
    earnPrepareRouteRuntime.prepare = (input) => prepareEarnDepositV1({ repository: seed.repo }, input);
    earnPrepareRouteRuntime.now = () => NOW;
    const response = await request(routeApp())
      .post('/api/route-intelligence/earn/prepare')
      .send({ routeRunId: seed.runId, routeCardHash: `0x${'0'.repeat(64)}`, selectedCandidateHash: seed.recommendedCandidateHash, walletAddress: WALLET, requestId: 'earn-prep-1' });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refresh_required');
  });

  test('fails closed with an opaque 500 when prepare throws, without leaking the error', async () => {
    earnPrepareRouteRuntime.prepare = async () => { throw new Error('earn run secret detail'); };
    const response = await request(routeApp()).post('/api/route-intelligence/earn/prepare').send(BODY);
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'earn_prepare_failed');
    assert.equal(JSON.stringify(response.body).includes('secret detail'), false);
  });
});

describe('POST /api/route-intelligence/earn/blueprints/:id/approve', () => {
  test('approved: re-validates through the EARN kernel and returns the exact unsigned batch payload', async () => {
    const seed = await seedPersistedComparison();
    const blueprint = await prepareInSeed(seed);
    earnBlueprintRouteRuntime.approve = (input) => approveEarnBlueprintV1({ repository: seed.repo }, input);
    earnBlueprintRouteRuntime.now = () => NOW;
    const response = await request(routeApp())
      .post(`/api/route-intelligence/earn/blueprints/${blueprint.id}/approve`)
      .send({ routeRunId: seed.runId, blueprintHash: blueprint.blueprintHash, walletAddress: WALLET });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'approved');
    assert.equal(response.body.payload.calls.length, 2);
    assert.equal(response.body.payload.atomicRequired, true);
    assert.equal(response.body.payload.chainId, '0x2105');
  });

  test('fails closed with an opaque 500 when approve throws', async () => {
    earnBlueprintRouteRuntime.approve = async () => { throw new Error('kernel secret'); };
    const response = await request(routeApp())
      .post('/api/route-intelligence/earn/blueprints/bp-1/approve')
      .send({ routeRunId: 'earn-run', blueprintHash: `0x${'0'.repeat(64)}`, walletAddress: WALLET });
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'blueprint_approve_failed');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});

describe('POST /api/route-intelligence/earn/blueprints/:id/submission', () => {
  test('recorded: binds the earn run and records the wallet-reported submission', async () => {
    const seed = await seedPersistedComparison();
    const blueprint = await prepareInSeed(seed);
    await approveEarnBlueprintV1({ repository: seed.repo }, { tenantId: USER.id, walletAddress: WALLET, routeRunId: seed.runId, blueprintId: blueprint.id, blueprintHash: blueprint.blueprintHash, now: NOW });
    earnBlueprintRouteRuntime.recordSubmission = (input) => recordBlueprintSubmissionV1({ repository: seed.repo }, input);
    earnBlueprintRouteRuntime.now = () => NOW;
    const response = await request(routeApp())
      .post(`/api/route-intelligence/earn/blueprints/${blueprint.id}/submission`)
      .send({ routeRunId: seed.runId, walletAddress: WALLET, approvedCallsHash: blueprint.callsHash, status: 'submitted', batchId: 'earn-batch-1', transactionHashes: [TX_HASH] });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'recorded');
    assert.equal(response.body.finalStatus, 'pending');
  });
});

describe('POST /api/route-intelligence/earn/route-proofs/:id/reconcile', () => {
  async function seedSubmitted(positionCredit: bigint) {
    const seed = await seedPersistedComparison();
    const blueprint = await prepareInSeed(seed);
    await approveEarnBlueprintV1({ repository: seed.repo }, { tenantId: USER.id, walletAddress: WALLET, routeRunId: seed.runId, blueprintId: blueprint.id, blueprintHash: blueprint.blueprintHash, now: NOW });
    await recordBlueprintSubmissionV1({ repository: seed.repo }, { tenantId: USER.id, walletAddress: WALLET, routeRunId: seed.runId, blueprintId: blueprint.id, approvedCallsHash: blueprint.callsHash, status: 'submitted', batchId: 'earn-batch-1', transactionHashes: [TX_HASH], now: NOW });
    const reader = mockReader(positionCredit >= 0n ? earnSuccessSource(seed.candidate, positionCredit) : null);
    earnReconcileRouteRuntime.reconcile = (input) => createEarnRouteProofReconciler({ repository: seed.repo, receiptReader: reader }).reconcile(input);
    earnReconcileRouteRuntime.now = () => LATER;
    return { seed, proofId: proofIdFor(blueprint.id) };
  }

  test('completed: a proven position (USDC debit + position credit) finalizes matched', async () => {
    const { seed, proofId } = await seedSubmitted(BigInt('2450000000000'));
    const response = await request(routeApp())
      .post(`/api/route-intelligence/earn/route-proofs/${proofId}/reconcile`)
      .send({ routeRunId: seed.runId, walletAddress: WALLET });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'completed');
    assert.equal(response.body.proof.reconciliationState, 'matched');
  });

  test('reconciliation_required: a success receipt with NO observable position is not proof of deposit', async () => {
    const { seed, proofId } = await seedSubmitted(BigInt(0));
    const response = await request(routeApp())
      .post(`/api/route-intelligence/earn/route-proofs/${proofId}/reconcile`)
      .send({ routeRunId: seed.runId, walletAddress: WALLET });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'reconciliation_required');
    assert.equal(response.body.proof.reconciliationState, 'manual_review');
  });

  test('a foreign proof id is a stable 404 (binding error mapping)', async () => {
    const { seed } = await seedSubmitted(BigInt('2450000000000'));
    const response = await request(routeApp())
      .post(`/api/route-intelligence/earn/route-proofs/route-proof:deadbeef/reconcile`)
      .send({ routeRunId: seed.runId, walletAddress: WALLET });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'route_proof_not_found');
  });

  test('a wallet mismatch inside the reconciler maps to 403', async () => {
    earnReconcileRouteRuntime.reconcile = async () => { throw new RouteProofReconcileBindingError('wallet_mismatch', 'nope'); };
    const response = await request(routeApp())
      .post('/api/route-intelligence/earn/route-proofs/route-proof:abc/reconcile')
      .send({ routeRunId: 'earn-run', walletAddress: WALLET });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'wallet_mismatch');
  });
});
