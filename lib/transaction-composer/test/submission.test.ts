import assert from 'node:assert/strict';
import test from 'node:test';
import { TransactionComposerBindingError } from '../src/coordinator.js';
import { approveExecutionBlueprintV1, routeProofIdV1 } from '../src/approval.js';
import {
  BlueprintSubmissionConflictError,
  recordBlueprintSubmissionV1,
  type RecordBlueprintSubmissionInput,
} from '../src/submission.js';
import { NOW, TENANT, WALLET, passingContractSecurity } from './fixtures.js';
import { approveInput, seededBlueprint, type SeededBlueprint } from './t57-fixtures.js';

const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const LATER = new Date(NOW.getTime() + 60_000);

async function approvedSeed(
  overrides: Parameters<typeof seededBlueprint>[0] = {},
): Promise<SeededBlueprint & { approvedCallsHash: `0x${string}` }> {
  const seeded = await seededBlueprint(overrides);
  const result = await approveExecutionBlueprintV1(
    { repository: seeded.repository, contractSecurity: passingContractSecurity() },
    approveInput(seeded),
  );
  assert.equal(result.outcome, 'approved');
  if (result.outcome !== 'approved') throw new Error('unreachable');
  return { ...seeded, approvedCallsHash: result.payload.approvedCallsHash };
}

function submissionInput(
  seeded: SeededBlueprint & { approvedCallsHash: `0x${string}` },
  overrides: Partial<RecordBlueprintSubmissionInput> = {},
): RecordBlueprintSubmissionInput {
  return {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.scenario.intent.id,
    blueprintId: seeded.blueprint.id,
    approvedCallsHash: seeded.approvedCallsHash,
    status: 'submitted',
    batchId: 'batch-1',
    now: LATER,
    ...overrides,
  };
}

test('submission: records a submitted batch as a pending proof with a submitted event', async () => {
  const seeded = await approvedSeed();
  const result = await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  assert.deepEqual(result, {
    outcome: 'recorded',
    lifecycle: 'submitted',
    proofId: routeProofIdV1(seeded.blueprint.id),
    finalStatus: 'pending',
  });

  const proof = await seeded.repository.getProofProjection(result.proofId, TENANT);
  assert.equal(proof!.finalStatus, 'pending');
  assert.deepEqual(proof!.transactionHashes, []);

  const events = await seeded.repository.listProofEvents(result.proofId, TENANT);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.eventType, 'submitted');
  assert.equal(events[1]!.eventIndex, 1);
  assert.equal(events[1]!.previousEventHash, events[0]!.eventHash);
  assert.deepEqual(events[1]!.payload, { batchId: 'batch-1', status: 'submitted' });
});

test('submission: confirmed with transaction hashes appends receipt_observed and keeps finalStatus pending', async () => {
  const seeded = await approvedSeed();
  await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, {
      status: 'confirmed',
      transactionHashes: [TX_HASH],
      receipts: [{ transactionHash: TX_HASH, status: 'success', blockNumber: '33123499', gasUsed: '185000' }],
      now: new Date(NOW.getTime() + 120_000),
    }),
  );
  assert.equal(result.outcome, 'recorded');
  assert.equal(result.finalStatus, 'pending');
  assert.equal(result.lifecycle, 'confirmed');

  const proof = await seeded.repository.getProofProjection(result.proofId, TENANT);
  assert.deepEqual(proof!.transactionHashes, [TX_HASH]);
  assert.equal(proof!.receipts.length, 1);
  assert.equal(proof!.receipts[0]!.status, 'success');
  // T57 never completes the proof; reconciliation belongs to T58.
  assert.equal(proof!.finalStatus, 'pending');
  assert.equal(proof!.reconciliationState, 'pending');

  const events = await seeded.repository.listProofEvents(result.proofId, TENANT);
  assert.equal(events.length, 3);
  assert.equal(events[2]!.eventType, 'receipt_observed');
  assert.equal(events[2]!.payload.batchId, 'batch-1');
  assert.deepEqual(events[2]!.payload.transactionHashes, [TX_HASH]);
  assert.ok(Array.isArray(events[2]!.payload.receiptsRaw));
});

test('submission: a wallet rejection records finalStatus cancelled', async () => {
  const seeded = await approvedSeed();
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'cancelled', batchId: undefined, error: 'User rejected the request' }),
  );
  assert.equal(result.finalStatus, 'cancelled');
  assert.equal(result.lifecycle, 'cancelled');
  const proof = await seeded.repository.getProofProjection(result.proofId, TENANT);
  assert.equal(proof!.finalStatus, 'cancelled');
  // No batch id was ever assigned, so no submitted event exists.
  const events = await seeded.repository.listProofEvents(result.proofId, TENANT);
  assert.equal(events.length, 1);
});

test('submission: a transport failure before a batch id records finalStatus failed', async () => {
  const seeded = await approvedSeed();
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'failed', batchId: undefined, error: 'network failure before batch id' }),
  );
  assert.equal(result.finalStatus, 'failed');
  assert.equal(result.lifecycle, 'failed');
});

test('submission: submitted_unknown keeps the proof pending and surfaces in the lifecycle', async () => {
  const seeded = await approvedSeed();
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'submitted_unknown' }),
  );
  assert.equal(result.finalStatus, 'pending');
  assert.equal(result.lifecycle, 'submitted_unknown');
});

test('submission: an identical retry is a no-op returning the same response', async () => {
  const seeded = await approvedSeed();
  const first = await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  const second = await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  assert.deepEqual(second, first);
  const events = await seeded.repository.listProofEvents(first.proofId, TENANT);
  assert.equal(events.length, 2);
});

test('submission: a second different batch conflicts while the first is not failed or cancelled', async () => {
  const seeded = await approvedSeed();
  await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  await assert.rejects(
    recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded, { batchId: 'batch-2' })),
    BlueprintSubmissionConflictError,
  );
});

test('submission: confirmed after cancelled conflicts, and cancelled after confirmed conflicts', async () => {
  const seeded = await approvedSeed();
  await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'cancelled', batchId: undefined }),
  );
  await assert.rejects(
    recordBlueprintSubmissionV1(
      { repository: seeded.repository },
      submissionInput(seeded, { status: 'confirmed', batchId: undefined, transactionHashes: [TX_HASH] }),
    ),
    BlueprintSubmissionConflictError,
  );

  const confirmedSeed = await approvedSeed();
  await recordBlueprintSubmissionV1({ repository: confirmedSeed.repository }, submissionInput(confirmedSeed));
  await recordBlueprintSubmissionV1(
    { repository: confirmedSeed.repository },
    submissionInput(confirmedSeed, {
      status: 'confirmed',
      transactionHashes: [TX_HASH],
      // A genuine confirmation carries a success receipt — only that blocks a
      // later cancelled/failed correction.
      receipts: [{ transactionHash: TX_HASH, status: 'success', blockNumber: '33123499', gasUsed: '185000' }],
    }),
  );
  await assert.rejects(
    recordBlueprintSubmissionV1(
      { repository: confirmedSeed.repository },
      submissionInput(confirmedSeed, { status: 'cancelled' }),
    ),
    BlueprintSubmissionConflictError,
  );
});

test('submission: a reverted receipt reads as failed and is not confirmed', async () => {
  const seeded = await approvedSeed();
  await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, {
      status: 'confirmed',
      transactionHashes: [TX_HASH],
      receipts: [{ transactionHash: TX_HASH, status: 'reverted', blockNumber: '33123499', gasUsed: '185000' }],
    }),
  );
  // The client reported 'confirmed', but the receipt reverted onchain — the
  // lifecycle must never claim 'confirmed'.
  assert.equal(result.lifecycle, 'failed');
  const proof = await seeded.repository.getProofProjection(result.proofId, TENANT);
  assert.equal(proof!.receipts[0]!.status, 'reverted');
});

test('submission: an unknown-only receipt never reads as confirmed', async () => {
  const seeded = await approvedSeed();
  await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  // A hash observed without a parseable receipt becomes an honest `unknown`
  // placeholder — it must NOT surface as 'confirmed'.
  const result = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'confirmed', transactionHashes: [TX_HASH] }),
  );
  assert.notEqual(result.lifecycle, 'confirmed');
  const proof = await seeded.repository.getProofProjection(result.proofId, TENANT);
  assert.equal(proof!.receipts[0]!.status, 'unknown');
});

test('submission: proof onchain facts never mutate without a paired event', async () => {
  const seeded = await approvedSeed();
  // First record: submitted with a batch id but no hashes/receipts — the proof
  // keeps empty tx hashes and only a submitted event is appended.
  const first = await recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded));
  let proof = await seeded.repository.getProofProjection(first.proofId, TENANT);
  assert.deepEqual(proof!.transactionHashes, []);
  let events = await seeded.repository.listProofEvents(first.proofId, TENANT);
  assert.equal(events.filter((event) => event.eventType === 'receipt_observed').length, 0);

  // Second record carries hashes/receipts — the mutation MUST be accompanied by
  // a receipt_observed event.
  const second = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, {
      status: 'confirmed',
      transactionHashes: [TX_HASH],
      receipts: [{ transactionHash: TX_HASH, status: 'success', blockNumber: '1', gasUsed: '1' }],
    }),
  );
  proof = await seeded.repository.getProofProjection(second.proofId, TENANT);
  events = await seeded.repository.listProofEvents(second.proofId, TENANT);
  assert.deepEqual(proof!.transactionHashes, [TX_HASH]);
  assert.equal(events.filter((event) => event.eventType === 'receipt_observed').length, 1);
});

test('submission: rejects an unapproved blueprint and an altered approvedCallsHash', async () => {
  const unapproved = await seededBlueprint();
  await assert.rejects(
    recordBlueprintSubmissionV1(
      { repository: unapproved.repository },
      {
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: unapproved.scenario.intent.id,
        blueprintId: unapproved.blueprint.id,
        approvedCallsHash: unapproved.blueprint.callsHash,
        status: 'submitted',
        batchId: 'batch-1',
        now: LATER,
      },
    ),
    TransactionComposerBindingError,
  );

  const seeded = await approvedSeed();
  await assert.rejects(
    recordBlueprintSubmissionV1(
      { repository: seeded.repository },
      submissionInput(seeded, { approvedCallsHash: `0x${'9'.repeat(64)}` }),
    ),
    TransactionComposerBindingError,
  );
});

test('submission: a NEW submitted record is refused after quote expiry, but a terminal record is accepted', async () => {
  const seeded = await approvedSeed();
  const afterExpiry = new Date(Date.parse(seeded.blueprint.quoteExpiry) + 1_000);
  await assert.rejects(
    recordBlueprintSubmissionV1({ repository: seeded.repository }, submissionInput(seeded, { now: afterExpiry })),
    TransactionComposerBindingError,
  );
  // The wallet already sent the batch before expiry — recording that honest
  // terminal fact must still be possible.
  const recorded = await recordBlueprintSubmissionV1(
    { repository: seeded.repository },
    submissionInput(seeded, { status: 'cancelled', batchId: undefined, now: afterExpiry }),
  );
  assert.equal(recorded.finalStatus, 'cancelled');
});

test('submission: tenant isolation refuses a foreign tenant', async () => {
  const seeded = await approvedSeed();
  await assert.rejects(
    recordBlueprintSubmissionV1(
      { repository: seeded.repository },
      submissionInput(seeded, { tenantId: 'other-tenant' }),
    ),
    TransactionComposerBindingError,
  );
});
