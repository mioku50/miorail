import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1 } from '@mioagent/earn-engine';
import { InMemoryRouteStorageRepository } from '@mioagent/route-storage';
import {
  approveEarnBlueprintV1,
  prepareEarnDepositV1,
  recordBlueprintSubmissionV1,
} from '@mioagent/transaction-composer';
import type { EarnCandidateV1 } from '@mioagent/route-domain';
import { RouteProofReconcileBindingError } from '../src/reconciler.js';
import { createEarnRouteProofReconciler } from '../src/earnReconciler.js';
import { CANONICAL_BASE_USDC } from '../src/constants.js';
import { mockReceiptReader, transferLog, TX_HASH_1 } from './fixtures.js';
import type { VerifiedReceiptSourceV1 } from '../src/receipts.js';

// ---------------------------------------------------------------------------
// T62 §5 — earn deposit Route Proof reconciliation over the FULL persisted path:
// resolve -> compare -> prepare -> approve -> record submission -> reconcile.
// Every fixture comes from the OFFLINE earn engine + in-memory repo; the only
// injected chain data is a mock receipt reader. No live provider/RPC call.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-07-21T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);
const EVEN_LATER = new Date(NOW.getTime() + 120_000);

interface SeededEarn {
  repo: InMemoryRouteStorageRepository;
  runId: string;
  blueprintId: string;
  approvedCallsHash: `0x${string}`;
  candidate: EarnCandidateV1;
}

/** Runs the real earn execution path up to a SUBMITTED pending Route Proof. */
async function seedSubmittedEarnDeposit(): Promise<SeededEarn> {
  const repo = new InMemoryRouteStorageRepository();
  const resolution = resolveEarnIntentV1({ message: 'Deposit 500 USDC for yield.', tenantId: TENANT, walletAddress: WALLET, now: NOW });
  assert.equal(resolution.status, 'ready');
  if (resolution.status !== 'ready') throw new Error('intent not ready');
  const intent = resolution.intent;
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
  const candidate = comparison.entries.find((entry) => entry.candidate.candidateHash === recommended)!.candidate;

  const prepared = await prepareEarnDepositV1(
    { repository: repo },
    {
      tenantId: TENANT,
      walletAddress: WALLET,
      routeRunId: run.id,
      routeCardHash: comparison.routeCard.routeCardHash,
      selectedCandidateHash: recommended,
      requestId: 'earn-prepare-1',
      now: NOW,
    },
  );
  assert.equal(prepared.outcome, 'prepared');
  if (prepared.outcome !== 'prepared') throw new Error('not prepared');

  const approved = await approveEarnBlueprintV1(
    { repository: repo },
    { tenantId: TENANT, walletAddress: WALLET, routeRunId: run.id, blueprintId: prepared.blueprint.id, blueprintHash: prepared.blueprint.blueprintHash, now: NOW },
  );
  assert.equal(approved.outcome, 'approved');

  await recordBlueprintSubmissionV1(
    { repository: repo },
    {
      tenantId: TENANT,
      walletAddress: WALLET,
      routeRunId: run.id,
      blueprintId: prepared.blueprint.id,
      approvedCallsHash: prepared.blueprint.callsHash,
      status: 'submitted',
      batchId: 'earn-batch-1',
      transactionHashes: [TX_HASH_1],
      now: NOW,
    },
  );

  return { repo, runId: run.id, blueprintId: prepared.blueprint.id, approvedCallsHash: prepared.blueprint.callsHash, candidate };
}

/** A verified success receipt for an earn deposit: USDC leaves the wallet (to
 * the approval spender) and the position token arrives at the wallet (minted
 * from the target market/vault). Set `positionCredit` to 0n to model a receipt
 * that succeeded but produced NO observable position (the §8 unprovable case). */
function earnSuccessReceiptSource(candidate: EarnCandidateV1, input: { usdcDebit: bigint; positionCredit: bigint }): VerifiedReceiptSourceV1 {
  const target = candidate.contracts.target as `0x${string}`;
  const spender = candidate.contracts.approvalSpender as `0x${string}`;
  const logs = [transferLog(CANONICAL_BASE_USDC as `0x${string}`, WALLET, spender, input.usdcDebit)];
  if (input.positionCredit > 0n) {
    logs.push(transferLog(target, target, WALLET, input.positionCredit));
  }
  return {
    transactionHash: TX_HASH_1,
    status: 'success',
    blockNumber: BigInt(33223499),
    gasUsed: BigInt(210000),
    effectiveGasPriceWei: BigInt(1200000000),
    logs,
  };
}

function revertedEarnReceiptSource(): VerifiedReceiptSourceV1 {
  return { transactionHash: TX_HASH_1, status: 'reverted', blockNumber: BigInt(33223500), gasUsed: BigInt(48000), effectiveGasPriceWei: BigInt(1200000000), logs: [] };
}

async function reconcile(seeded: SeededEarn, reader: ReturnType<typeof mockReceiptReader>, now: Date) {
  // The Route Proof id is deterministic from the blueprint id; read it back
  // from the persisted pending proof via the run's blueprint lineage.
  const proofId = await earnProofId(seeded);
  const reconciler = createEarnRouteProofReconciler({ repository: seeded.repo, receiptReader: reader });
  return reconciler.reconcile({ tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.runId, routeProofId: proofId, now });
}

/** route-proof:<hash of {blueprintId}> — mirror of the composer/reconciler id. */
async function earnProofId(seeded: SeededEarn): Promise<string> {
  const { stableHashV1 } = await import('@mioagent/route-domain');
  return `route-proof:${stableHashV1('route-proof-id/v1', { blueprintId: seeded.blueprintId }).slice(2)}`;
}

describe('T62 earn Route Proof reconciliation', () => {
  test('successful deposit with an observable position -> completed + matched, honest actualOutput', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({
      [TX_HASH_1]: earnSuccessReceiptSource(seeded.candidate, { usdcDebit: BigInt('500000000'), positionCredit: BigInt('2450000000000') }),
    });
    const result = await reconcile(seeded, reader, LATER);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.proof.finalStatus, 'completed');
    assert.equal(result.proof.reconciliationState, 'matched');
    // The position CREDIT observed onchain is the proven output amount.
    assert.equal(result.proof.actualOutput, '2450000000000');
    assert.equal(result.lifecycle, 'completed');
  });

  test('receipt success but NO observable position credit -> reconciliation_required (receipt is not proof)', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({
      [TX_HASH_1]: earnSuccessReceiptSource(seeded.candidate, { usdcDebit: BigInt('500000000'), positionCredit: BigInt(0) }),
    });
    const result = await reconcile(seeded, reader, LATER);
    assert.equal(result.outcome, 'reconciliation_required');
    assert.equal(result.proof.finalStatus, 'reconciliation_required');
    assert.equal(result.proof.reconciliationState, 'manual_review');
    assert.equal(result.proof.actualOutput, null);
  });

  test('all-reverted deposit -> failed, no fabricated position', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({ [TX_HASH_1]: revertedEarnReceiptSource() });
    const result = await reconcile(seeded, reader, LATER);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.proof.finalStatus, 'failed');
    assert.equal(result.proof.reconciliationState, 'failed');
    assert.equal(result.proof.actualOutput, null);
  });

  test('reconcile is idempotent once completed (sticky terminal state)', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({
      [TX_HASH_1]: earnSuccessReceiptSource(seeded.candidate, { usdcDebit: BigInt('500000000'), positionCredit: BigInt('2450000000000') }),
    });
    const first = await reconcile(seeded, reader, LATER);
    assert.equal(first.outcome, 'completed');
    const second = await reconcile(seeded, reader, EVEN_LATER);
    assert.equal(second.outcome, 'already_finalized');
    assert.equal(second.proof.finalStatus, 'completed');
  });

  test('the earn reconciler refuses a wrong tenant (cannot even find the earn run)', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({});
    const proofId = await earnProofId(seeded);
    const reconciler = createEarnRouteProofReconciler({ repository: seeded.repo, receiptReader: reader });
    await assert.rejects(
      () => reconciler.reconcile({ tenantId: 'someone-elses-tenant', walletAddress: WALLET, routeRunId: seeded.runId, routeProofId: proofId, now: LATER }),
      (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'route_proof_not_found',
    );
  });

  test('the earn reconciler refuses a wallet mismatch', async () => {
    const seeded = await seedSubmittedEarnDeposit();
    const reader = mockReceiptReader({});
    const proofId = await earnProofId(seeded);
    const reconciler = createEarnRouteProofReconciler({ repository: seeded.repo, receiptReader: reader });
    await assert.rejects(
      () => reconciler.reconcile({ tenantId: TENANT, walletAddress: '0x9999999999999999999999999999999999999999', routeRunId: seeded.runId, routeProofId: proofId, now: LATER }),
      (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'wallet_mismatch',
    );
  });
});
