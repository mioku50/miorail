import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildNftProofEventV1 } from '@mioagent/nft-engine';
import {
  RouteStorageConflictError,
  RouteStorageIntegrityError,
  createMemoryNftStorageRepository,
  nftIdempotencyKeyV1,
} from '../src/index.js';
import {
  NFT_BUYER,
  NFT_COLLECTION,
  NFT_NOW,
  NFT_OTHER_TENANT,
  NFT_TENANT,
  NFT_TOKEN_ID,
  NFT_TX_HASH,
  nftFixtureGraph,
  nftIntentFixture,
  nftProofFixture,
} from './nft-fixture.js';

// ---------------------------------------------------------------------------
// T65.1 §1 — the invariants the durable layer exists for.
// ---------------------------------------------------------------------------

const KEY = nftIdempotencyKeyV1({
  tenantId: NFT_TENANT,
  walletAddress: NFT_BUYER,
  contractAddress: NFT_COLLECTION,
  tokenId: NFT_TOKEN_ID,
  maxSpendWei: '10000000000000000',
  requestId: 'req-1',
});

async function seeded() {
  const repository = createMemoryNftStorageRepository(() => NFT_NOW);
  const graph = nftFixtureGraph();
  await repository.createNftRouteRun(graph.intent, KEY);
  await repository.insertNftCandidate(graph.intent.id, graph.candidate);
  for (const record of graph.evidence) await repository.insertNftEvidence(graph.intent.id, record);
  await repository.insertNftRouteCard(graph.intent.id, graph.card);
  return { repository, graph };
}

async function prepared() {
  const { repository, graph } = await seeded();
  const reserved = await repository.reserveNftPurchaseBlueprint({
    routeRunId: graph.intent.id,
    routeCardId: graph.card.id,
    userId: NFT_TENANT,
    blueprint: graph.blueprint,
  });
  return { repository, graph, blueprintId: reserved.record.id };
}

describe('the run and its parts', () => {
  test('the same request returns the same run instead of a second one', async () => {
    const { repository, graph } = await seeded();
    const again = await repository.createNftRouteRun(graph.intent, KEY);
    assert.equal(again.id, graph.intent.id);
    assert.equal(again.goal, 'nft');
  });

  test('the same key with different content is a conflict, not a silent overwrite', async () => {
    const { repository } = await seeded();
    // A different ceiling is a different purchase. Reusing the key for it would
    // hand back a run that authorizes the wrong amount.
    const other = nftIntentFixture(NFT_TENANT, 'nft-intent:other', '20000000000000000');
    await assert.rejects(
      () => repository.createNftRouteRun(other, KEY),
      RouteStorageConflictError,
    );
  });

  test('requestId keeps two identical goals from colliding', () => {
    const shared = {
      tenantId: NFT_TENANT,
      walletAddress: NFT_BUYER,
      contractAddress: NFT_COLLECTION,
      tokenId: NFT_TOKEN_ID,
      maxSpendWei: '10000000000000000',
    };
    assert.notEqual(
      nftIdempotencyKeyV1({ ...shared, requestId: 'req-1' }),
      nftIdempotencyKeyV1({ ...shared, requestId: 'req-2' }),
    );
  });

  test('another tenant sees nothing', async () => {
    const { repository, graph } = await seeded();
    assert.equal(await repository.getNftRouteRun(graph.intent.id, NFT_OTHER_TENANT), null);
    await assert.rejects(
      () => repository.listNftCandidates(graph.intent.id, NFT_OTHER_TENANT),
      RouteStorageConflictError,
    );
  });

  test('re-comparing the same listing stores one candidate, not two', async () => {
    const { repository, graph } = await seeded();
    await repository.insertNftCandidate(graph.intent.id, graph.candidate);
    assert.equal((await repository.listNftCandidates(graph.intent.id, NFT_TENANT)).length, 1);
  });

  test('evidence cannot be filed against a candidate this run never saw', async () => {
    const { repository, graph } = await seeded();
    // A different ceiling gives a different intentHash, and so a candidate
    // this run genuinely never saw. The intent ID alone would not: it is a
    // lifecycle field and never enters the content hash.
    const foreign = nftFixtureGraph(nftIntentFixture(NFT_TENANT, 'nft-intent:foreign', '9000000000000000'));
    assert.notEqual(foreign.candidate.candidateHash, graph.candidate.candidateHash);
    await assert.rejects(
      () => repository.insertNftEvidence(graph.intent.id, foreign.evidence[0]),
      RouteStorageIntegrityError,
    );
  });

  test('prepare can load the persisted card and candidate by hash', async () => {
    const { repository, graph } = await seeded();
    const card = await repository.getNftRouteCard(graph.intent.id, graph.card.routeCardHash, NFT_TENANT);
    const candidate = await repository.getNftCandidate(
      graph.intent.id,
      graph.candidate.candidateHash,
      NFT_TENANT,
    );
    assert.equal(card?.routeCardHash, graph.card.routeCardHash);
    assert.equal(candidate?.listingPriceWei, graph.candidate.listingPriceWei);
  });
});

describe('one blueprint per Route Card', () => {
  test('a second prepare returns the first, never a second wallet prompt', async () => {
    const { repository, graph, blueprintId } = await prepared();
    const second = await repository.reserveNftPurchaseBlueprint({
      routeRunId: graph.intent.id,
      routeCardId: graph.card.id,
      userId: NFT_TENANT,
      blueprint: graph.blueprint,
    });
    assert.equal(second.outcome, 'existing');
    assert.equal(second.record.id, blueprintId);
  });

  test('a blueprint for an unstored card is refused', async () => {
    const { repository, graph } = await seeded();
    await assert.rejects(
      () =>
        repository.reserveNftPurchaseBlueprint({
          routeRunId: graph.intent.id,
          routeCardId: 'nft-card:never-stored',
          userId: NFT_TENANT,
          blueprint: graph.blueprint,
        }),
      RouteStorageIntegrityError,
    );
  });

  test('a fresh blueprint is unapproved', async () => {
    const { repository, blueprintId } = await prepared();
    const record = await repository.getNftPurchaseBlueprint(blueprintId, NFT_TENANT);
    assert.equal(record?.blueprint.approvedCallsHash, null);
    assert.equal(record?.submittedAt, null);
  });
});

describe('approval is of these calls, or it is nothing', () => {
  test('the stored calls hash is what gets approved', async () => {
    const { repository, graph, blueprintId } = await prepared();
    const approved = await repository.approveNftPurchaseBlueprint({
      blueprintId,
      userId: NFT_TENANT,
      approvedCallsHash: graph.blueprint.callsHash,
    });
    assert.equal(approved.blueprint.approvedCallsHash, graph.blueprint.callsHash);
    assert.equal(approved.blueprint.status, 'approved');
    // The identity of the blueprint did not move: the hash covers the calls,
    // not the lifecycle.
    assert.equal(approved.blueprint.blueprintHash, graph.blueprint.blueprintHash);
    assert.deepEqual(approved.blueprint.calls, graph.blueprint.calls);
  });

  test('approving some other hash is refused', async () => {
    const { repository, blueprintId } = await prepared();
    await assert.rejects(
      () =>
        repository.approveNftPurchaseBlueprint({
          blueprintId,
          userId: NFT_TENANT,
          approvedCallsHash: `0x${'9'.repeat(64)}`,
        }),
      RouteStorageConflictError,
    );
  });

  test("another tenant cannot approve someone else's purchase", async () => {
    const { repository, graph, blueprintId } = await prepared();
    await assert.rejects(
      () =>
        repository.approveNftPurchaseBlueprint({
          blueprintId,
          userId: NFT_OTHER_TENANT,
          approvedCallsHash: graph.blueprint.callsHash,
        }),
      RouteStorageConflictError,
    );
  });

  test('a submission without an approval is refused', async () => {
    const { repository, blueprintId } = await prepared();
    await assert.rejects(
      () =>
        repository.recordNftSubmission({
          status: 'submitted',
          blueprintId,
          userId: NFT_TENANT,
          submissionBatchId: 'batch-1',
          transactionHash: NFT_TX_HASH,
          submittedAt: NFT_NOW.toISOString(),
        }),
      RouteStorageConflictError,
    );
  });
});

describe('a submission is recorded once', () => {
  async function submitted() {
    const { repository, graph, blueprintId } = await prepared();
    await repository.approveNftPurchaseBlueprint({
      blueprintId,
      userId: NFT_TENANT,
      approvedCallsHash: graph.blueprint.callsHash,
    });
    await repository.recordNftSubmission({
      status: 'submitted',
      blueprintId,
      userId: NFT_TENANT,
      submissionBatchId: 'batch-1',
      transactionHash: NFT_TX_HASH,
      submittedAt: NFT_NOW.toISOString(),
    });
    return { repository, graph, blueprintId };
  }

  test('a duplicate POST returns the recorded submission', async () => {
    const { repository, blueprintId } = await submitted();
    const again = await repository.recordNftSubmission({
      status: 'submitted',
      blueprintId,
      userId: NFT_TENANT,
      submissionBatchId: 'batch-1',
      transactionHash: NFT_TX_HASH,
      submittedAt: '2026-07-26T12:05:00.000Z',
    });
    assert.equal(again.submittedTransactionHash, NFT_TX_HASH);
    assert.equal(again.submittedAt, NFT_NOW.toISOString());
  });

  test('a second, different transaction for the same purchase is refused', async () => {
    const { repository, blueprintId } = await submitted();
    await assert.rejects(
      () =>
        repository.recordNftSubmission({
          status: 'submitted',
          blueprintId,
          userId: NFT_TENANT,
          submissionBatchId: 'batch-2',
          transactionHash: `0x${'d'.repeat(64)}`,
          submittedAt: NFT_NOW.toISOString(),
        }),
      RouteStorageConflictError,
    );
  });

  test('a batch that learns its hash later updates the same submission', async () => {
    const { repository, graph, blueprintId } = await prepared();
    await repository.approveNftPurchaseBlueprint({
      blueprintId,
      userId: NFT_TENANT,
      approvedCallsHash: graph.blueprint.callsHash,
    });
    await repository.recordNftSubmission({
      status: 'submitted',
      blueprintId,
      userId: NFT_TENANT,
      submissionBatchId: 'batch-1',
      transactionHash: null,
      submittedAt: NFT_NOW.toISOString(),
    });
    const learned = await repository.recordNftSubmission({
      status: 'submitted',
      blueprintId,
      userId: NFT_TENANT,
      submissionBatchId: 'batch-1',
      transactionHash: NFT_TX_HASH,
      submittedAt: NFT_NOW.toISOString(),
    });
    assert.equal(learned.submittedTransactionHash, NFT_TX_HASH);
    assert.equal(learned.submissionBatchId, 'batch-1');
  });
});

describe('the proof holds one answer', () => {
  async function withProof(stage: 'submitted' | 'completed' | 'reconciliation_required') {
    const { repository, graph, blueprintId } = await prepared();
    const proof = nftProofFixture(graph.blueprint, stage);
    const record = await repository.upsertNftProof({
      routeRunId: graph.intent.id,
      blueprintId,
      userId: NFT_TENANT,
      proof,
    });
    return { repository, graph, blueprintId, record };
  }

  test('a submitted purchase is pending and open, with a hash to watch', async () => {
    const { record } = await withProof('submitted');
    assert.equal(record.proof.finalStatus, 'pending');
    assert.equal(record.proof.status, 'open');
    assert.equal(record.proof.receipt.transactionHash, NFT_TX_HASH);
    // Knowing the transaction is not knowing the outcome.
    assert.equal(record.proof.receipt.blockNumber, null);
    assert.equal(record.proof.ownership.status, 'unverified');
  });

  test('a succeeded transaction with no ownership stays open', async () => {
    const { repository, record } = await withProof('reconciliation_required');
    assert.equal(record.proof.finalStatus, 'reconciliation_required');
    assert.equal(record.proof.status, 'open');
    const open = await repository.listOpenNftProofs(10);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, record.id);
  });

  test('reconciliation may finish an open proof', async () => {
    const { repository, graph, blueprintId, record } = await withProof('reconciliation_required');
    const completed = await repository.upsertNftProof({
      routeRunId: graph.intent.id,
      blueprintId,
      userId: NFT_TENANT,
      proof: nftProofFixture(graph.blueprint, 'completed'),
    });
    assert.equal(completed.id, record.id);
    assert.equal(completed.proof.finalStatus, 'completed');
    assert.equal(completed.proof.status, 'finalized');
    assert.equal(completed.proof.ownership.owner, NFT_BUYER);
    assert.equal((await repository.listOpenNftProofs(10)).length, 0);
  });

  test('a finalized proof cannot be rewritten with a different answer', async () => {
    const { repository, graph, blueprintId } = await withProof('completed');
    await assert.rejects(
      () =>
        repository.upsertNftProof({
          routeRunId: graph.intent.id,
          blueprintId,
          userId: NFT_TENANT,
          proof: nftProofFixture(graph.blueprint, 'reconciliation_required'),
        }),
      RouteStorageConflictError,
    );
  });

  test('a proof for another blueprint is refused', async () => {
    const { repository, graph, blueprintId } = await prepared();
    const foreign = nftFixtureGraph(nftIntentFixture(NFT_TENANT, 'nft-intent:foreign', '9000000000000000'));
    assert.notEqual(foreign.blueprint.blueprintHash, graph.blueprint.blueprintHash);
    await assert.rejects(
      () =>
        repository.upsertNftProof({
          routeRunId: graph.intent.id,
          blueprintId,
          userId: NFT_TENANT,
          proof: nftProofFixture(foreign.blueprint, 'completed'),
        }),
      RouteStorageIntegrityError,
    );
  });
});

describe('the event log only grows', () => {
  test('a claimed sequence cannot be rewritten, but may be retried', async () => {
    const { repository, graph, blueprintId } = await prepared();
    const proof = nftProofFixture(graph.blueprint, 'submitted');
    const record = await repository.upsertNftProof({
      routeRunId: graph.intent.id,
      blueprintId,
      userId: NFT_TENANT,
      proof,
    });
    const event = buildNftProofEventV1({
      proof,
      sequence: 0,
      eventKind: 'submission_recorded',
      detail: null,
      now: NFT_NOW,
    });
    await repository.appendNftProofEvent(record.id, NFT_TENANT, event);
    await repository.appendNftProofEvent(record.id, NFT_TENANT, event);
    assert.equal((await repository.listNftProofEvents(record.id, NFT_TENANT)).length, 1);

    const rewritten = buildNftProofEventV1({
      proof,
      sequence: 0,
      eventKind: 'ownership_read',
      detail: 'different content, same slot',
      now: NFT_NOW,
    });
    await assert.rejects(
      () => repository.appendNftProofEvent(record.id, NFT_TENANT, rewritten),
      RouteStorageConflictError,
    );
  });

  test('an event describing a different proof is refused', async () => {
    const { repository, graph, blueprintId } = await prepared();
    const proof = nftProofFixture(graph.blueprint, 'submitted');
    const record = await repository.upsertNftProof({
      routeRunId: graph.intent.id,
      blueprintId,
      userId: NFT_TENANT,
      proof,
    });
    const other = buildNftProofEventV1({
      proof: nftProofFixture(graph.blueprint, 'completed'),
      sequence: 1,
      eventKind: 'finalized',
      detail: null,
      now: NFT_NOW,
    });
    await assert.rejects(
      () => repository.appendNftProofEvent(record.id, NFT_TENANT, other),
      RouteStorageIntegrityError,
    );
  });
});

describe('history reports what is known', () => {
  test('an unproven purchase is listed without a final status', async () => {
    const { repository } = await prepared();
    const items = await repository.listNftHistory(NFT_TENANT, 10);
    assert.equal(items.length, 1);
    assert.equal(items[0].finalStatus, null);
    assert.equal(items[0].tokenId, NFT_TOKEN_ID);
  });

  test("another tenant's history is empty", async () => {
    const { repository } = await prepared();
    assert.deepEqual(await repository.listNftHistory(NFT_OTHER_TENANT, 10), []);
  });
});
