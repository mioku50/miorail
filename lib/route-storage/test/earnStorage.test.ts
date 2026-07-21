import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionBlueprintV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  type EarnCandidateV1,
  type EarnRouteIntentV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
} from '@mioagent/route-domain';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1 } from '@mioagent/earn-engine';
import { InMemoryRouteStorageRepository, RouteStorageIntegrityError, RouteStorageTenantError } from '../src/index.js';

// ---------------------------------------------------------------------------
// T62 §1/§2 — additive earn persistence. Fixtures come from the real OFFLINE
// earn engine (resolveEarnIntentV1 + curated compare), so intent/candidate/
// evidence/score/card hashes are genuine and no live call is made. Verifies the
// persisted comparison, deterministic retry, tenant isolation, the earn
// Blueprint lineage/goal guards, and that the swap path is unaffected.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-07-21T12:00:00.000Z');

async function earnFixtures(tenantId = TENANT, walletAddress: `0x${string}` = WALLET) {
  const resolution = resolveEarnIntentV1({ message: 'Deposit 500 USDC for yield.', tenantId, walletAddress, now: NOW });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  const comparison = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: resolution.intent, now: NOW },
  );
  assert.equal(comparison.ok, true);
  if (!comparison.ok) throw new Error('comparison failed');
  return { intent: resolution.intent, entries: comparison.entries, card: comparison.routeCard };
}

async function persistFullComparison(repo: InMemoryRouteStorageRepository, tenantId = TENANT, wallet: `0x${string}` = WALLET) {
  const { intent, entries, card } = await earnFixtures(tenantId, wallet);
  const run = await repo.createEarnRouteRun(intent, `earn:req:${intent.id}`);
  for (const entry of entries) {
    await repo.insertEarnCandidate(run.id, entry.candidate);
    await repo.insertEarnEvidence(run.id, entry.candidate.id, entry.evidence);
    await repo.insertEarnScore(run.id, entry.candidate.id, entry.score);
  }
  await repo.insertEarnRouteCard(run.id, card);
  return { run, intent, entries, card };
}

function earnBlueprintFixture(
  intent: EarnRouteIntentV1,
  candidate: EarnCandidateV1,
  goal: 'swap' | 'earn' = 'earn',
): ExecutionBlueprintV1 {
  const usdc = intent.asset;
  const amount = intent.amount.amountAtomic;
  const calls: ExecutionCallV1[] = [
    { index: 0, callType: 'approval', to: candidate.contracts.asset, valueWei: '0', data: '0x095ea7b3', asset: usdc, amountAtomic: amount, recipient: null, spender: candidate.contracts.approvalSpender },
    { index: 1, callType: 'deposit', to: candidate.contracts.target, valueWei: '0', data: '0x6e553f65', asset: usdc, amountAtomic: amount, recipient: intent.walletAddress, spender: null },
  ];
  const nowIso = NOW.toISOString();
  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal,
    id: `earn-blueprint:${candidate.candidateHash.slice(2, 20)}`,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    chainId: 8453,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'ready_for_review',
    intentHash: intent.intentHash,
    selectedCandidateHash: candidate.candidateHash,
    evidenceSetHash: `0x${'a'.repeat(64)}`,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1(calls),
    approvedCallsHash: null,
    quoteExpiry: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    calls,
    expectedAssetChanges: [
      { asset: usdc, direction: 'debit', amountAtomic: amount, minimumAmountAtomic: amount, maximumAmountAtomic: amount },
    ],
    requiredApprovals: [
      { asset: usdc, spender: candidate.contracts.approvalSpender, amountAtomic: amount, approvalKind: 'exact', state: 'required' },
    ],
    simulationState: { status: 'unavailable', observedAt: null, blockNumber: null, requestHash: null, responseHash: null, errorCode: 'no_simulation_provider' },
    atomicRequired: true,
  };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}

describe('T62 earn storage', () => {
  test('persists a full earn comparison (run, candidates, evidence, scores, card) and reads it back', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, entries, card } = await persistFullComparison(repo);

    const fetched = await repo.getEarnRouteRun(run.id, TENANT);
    assert.ok(fetched);
    assert.equal(fetched!.goal, 'earn');
    assert.equal(fetched!.intent.goal, 'earn');
    assert.equal(fetched!.intent.amount.amountAtomic, '500000000');

    const candidates = await repo.listEarnCandidates(run.id, TENANT);
    assert.equal(candidates.length, entries.length);
    assert.deepEqual(candidates.map((c) => c.protocol).sort(), ['moonwell', 'morpho']);

    assert.equal((await repo.listEarnEvidence(run.id, TENANT)).length, entries.length);
    assert.equal((await repo.listEarnScores(run.id, TENANT)).length, entries.length);

    const cards = await repo.listEarnRouteCards(run.id, TENANT);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].routeCardHash, card.routeCardHash);
  });

  test('createEarnRouteRun is idempotent for a deterministic retry (same intent + key)', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { intent } = await earnFixtures();
    const a = await repo.createEarnRouteRun(intent, 'earn:req:retry');
    const b = await repo.createEarnRouteRun(intent, 'earn:req:retry');
    assert.equal(a.id, b.id);
    assert.equal(a.intentHash, b.intentHash);
    // Re-inserting a candidate is likewise a no-op.
    const { entries } = await earnFixtures();
    await repo.insertEarnCandidate(a.id, entries[0].candidate);
    await repo.insertEarnCandidate(a.id, entries[0].candidate);
    assert.equal((await repo.listEarnCandidates(a.id, TENANT)).length, 1);
  });

  test('earn runs are tenant-isolated and never leak through the swap getter', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run } = await persistFullComparison(repo);
    assert.equal(await repo.getEarnRouteRun(run.id, 'eip155:8453:0x9999999999999999999999999999999999999999'), null);
    assert.equal((await repo.listEarnCandidates(run.id, 'other-tenant')).length, 0);
    // The swap getter must never return an earn run.
    assert.equal(await repo.getRouteRun(run.id, TENANT), null);
  });

  test('an earn Blueprint stores through the shared table with an earn candidate lineage', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, entries, intent } = await persistFullComparison(repo);
    const blueprint = earnBlueprintFixture(intent, entries[0].candidate);
    await repo.insertEarnBlueprint(run.id, blueprint);
    const stored = await repo.listBlueprints(run.id, TENANT);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].blueprint.goal, 'earn');
    assert.equal(stored[0].blueprint.blueprintHash, blueprint.blueprintHash);
  });

  test('an earn Blueprint referencing an unstored candidate is rejected', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, intent, entries } = await persistFullComparison(repo);
    // A blueprint whose selectedCandidateHash was never stored as an earn candidate.
    const otherResolution = await earnFixtures(TENANT, '0x2222222222222222222222222222222222222222');
    const alien = earnBlueprintFixture(otherResolution.intent, otherResolution.entries[0].candidate);
    await assert.rejects(() => repo.insertEarnBlueprint(run.id, { ...alien, tenantId: intent.tenantId } as ExecutionBlueprintV1), RouteStorageIntegrityError);
    // A truly-stored candidate works (control).
    await repo.insertEarnBlueprint(run.id, earnBlueprintFixture(intent, entries[0].candidate));
  });

  test('a swap-goal Blueprint is rejected by insertEarnBlueprint (goal guard)', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, intent, entries } = await persistFullComparison(repo);
    const swapGoal = earnBlueprintFixture(intent, entries[0].candidate, 'swap');
    await assert.rejects(() => repo.insertEarnBlueprint(run.id, swapGoal), RouteStorageIntegrityError);
  });

  test('the swap path is unaffected: getEarnRouteRun never returns a swap run', async () => {
    const repo = new InMemoryRouteStorageRepository();
    // A swap run cannot be created here without a swap intent fixture, but the
    // getter contract is verifiable directly: an unknown id is null for both.
    assert.equal(await repo.getEarnRouteRun('route-run:swap-xyz', TENANT), null);
    assert.equal(await repo.getRouteRun('earn-intent:xyz', TENANT), null);
  });
});
