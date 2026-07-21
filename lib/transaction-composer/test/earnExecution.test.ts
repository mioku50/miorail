import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1 } from '@mioagent/earn-engine';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import type { EarnRouteIntentV1 } from '@mioagent/route-domain';
import {
  approveEarnBlueprintV1,
  approveExecutionBlueprintV1,
  prepareEarnDepositV1,
  routeProofIdV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T62 §3/§4 — earn prepare + goal-aware approve over the persisted store. All
// fixtures come from the OFFLINE earn engine; no live provider/chain call.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-07-21T12:00:00.000Z');
const noopContractSecurity = async () => [];

async function seed(repo: InMemoryRouteStorageRepository) {
  const resolution = resolveEarnIntentV1({ message: 'Deposit 500 USDC for yield.', tenantId: TENANT, walletAddress: WALLET, now: NOW });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('not ready');
  const intent: EarnRouteIntentV1 = resolution.intent;
  const comparison = await compareEarnRoutesV1({ dataSource: createCuratedEarnDataSourceV1() }, { intent, now: NOW });
  assert.equal(comparison.ok, true);
  if (!comparison.ok) throw new Error('no comparison');
  const run = await repo.createEarnRouteRun(intent, `earn:req:${intent.id}`);
  for (const entry of comparison.entries) {
    await repo.insertEarnCandidate(run.id, entry.candidate);
    await repo.insertEarnEvidence(run.id, entry.candidate.id, entry.evidence);
    await repo.insertEarnScore(run.id, entry.candidate.id, entry.score);
  }
  await repo.insertEarnRouteCard(run.id, comparison.routeCard);
  const recommended = comparison.routeCard.recommendedCandidateHash ?? comparison.entries[0].candidate.candidateHash;
  return { repo, run, card: comparison.routeCard, recommendedCandidateHash: recommended };
}

function prepareInput(runId: string, routeCardHash: string, selectedCandidateHash: string) {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: runId,
    routeCardHash: routeCardHash as `0x${string}`,
    selectedCandidateHash: selectedCandidateHash as `0x${string}`,
    requestId: 'earn-prepare-1',
    now: NOW,
  };
}

describe('T62 earn prepare + approve', () => {
  test('prepare loads the persisted card + candidate, builds an earn Blueprint, and persists it', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const result = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, recommendedCandidateHash));
    assert.equal(result.outcome, 'prepared');
    if (result.outcome !== 'prepared') return;
    assert.equal(result.blueprint.goal, 'earn');
    assert.equal(result.blueprint.calls.length, 2);
    assert.equal(result.safety.verdict, 'allowed');
    // Persisted through the shared execution_blueprints table.
    const stored = await repo.listBlueprints(run.id, TENANT);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].blueprint.id, result.blueprint.id);
  });

  test('prepare with an unknown card or candidate hash is refresh_required (no Blueprint built)', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const badCard = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, `0x${'0'.repeat(64)}`, recommendedCandidateHash));
    assert.equal(badCard.outcome, 'refresh_required');
    const badCandidate = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, `0x${'0'.repeat(64)}`));
    assert.equal(badCandidate.outcome, 'refresh_required');
    assert.equal((await repo.listBlueprints(run.id, TENANT)).length, 0);
  });

  test('approve re-validates through the EARN kernel and opens a pending Route Proof for the position', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const prepared = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, recommendedCandidateHash));
    assert.equal(prepared.outcome, 'prepared');
    if (prepared.outcome !== 'prepared') return;

    const approved = await approveEarnBlueprintV1(
      { repository: repo },
      { tenantId: TENANT, walletAddress: WALLET, routeRunId: run.id, blueprintId: prepared.blueprint.id, blueprintHash: prepared.blueprint.blueprintHash, now: NOW },
    );
    assert.equal(approved.outcome, 'approved');
    if (approved.outcome !== 'approved') return;
    assert.equal(approved.payload.calls.length, 2);
    assert.equal(approved.payload.atomicRequired, true);

    const proof = await repo.getProofProjection(routeProofIdV1(prepared.blueprint.id), TENANT);
    assert.ok(proof);
    assert.equal(proof!.finalStatus, 'pending');
    // The expected credit is the position token (deposit target); its amount is
    // deliberately unknown until settlement.
    assert.equal(proof!.expectedResult.outputAmountAtomic, null);
    assert.equal(proof!.expectedResult.outputAsset?.kind, 'erc20');
    // The only promised balance change is the exact USDC debit.
    assert.equal(proof!.expectedResult.assetChanges.length, 1);
    assert.equal(proof!.expectedResult.assetChanges[0].direction, 'debit');
  });

  test('approve is idempotent on a retry', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const prepared = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, recommendedCandidateHash));
    if (prepared.outcome !== 'prepared') throw new Error('not prepared');
    const input = { tenantId: TENANT, walletAddress: WALLET, routeRunId: run.id, blueprintId: prepared.blueprint.id, blueprintHash: prepared.blueprint.blueprintHash, now: NOW };
    const first = await approveEarnBlueprintV1({ repository: repo }, input);
    const second = await approveEarnBlueprintV1({ repository: repo }, input);
    assert.equal(first.outcome, 'approved');
    assert.equal(second.outcome, 'approved');
    if (first.outcome === 'approved' && second.outcome === 'approved') {
      assert.deepEqual(first.payload, second.payload);
    }
  });

  test('the SWAP approve path refuses to process an earn Route Run (goal isolation)', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const prepared = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, recommendedCandidateHash));
    if (prepared.outcome !== 'prepared') throw new Error('not prepared');
    await assert.rejects(() =>
      approveExecutionBlueprintV1(
        { repository: repo, contractSecurity: noopContractSecurity },
        { tenantId: TENANT, walletAddress: WALLET, routeRunId: run.id, blueprintId: prepared.blueprint.id, blueprintHash: prepared.blueprint.blueprintHash, now: NOW },
      ),
    );
  });

  test('wallet mismatch on approve is rejected', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const { run, card, recommendedCandidateHash } = await seed(repo);
    const prepared = await prepareEarnDepositV1({ repository: repo }, prepareInput(run.id, card.routeCardHash, recommendedCandidateHash));
    if (prepared.outcome !== 'prepared') throw new Error('not prepared');
    await assert.rejects(() =>
      approveEarnBlueprintV1(
        { repository: repo },
        { tenantId: TENANT, walletAddress: '0x2222222222222222222222222222222222222222', routeRunId: run.id, blueprintId: prepared.blueprint.id, blueprintHash: prepared.blueprint.blueprintHash, now: NOW },
      ),
    );
  });
});
