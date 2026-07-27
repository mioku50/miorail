import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { RouteStorageConflictError, RouteStorageIntegrityError } from '../src/types.js';
import { InMemorySubmissionAttemptRepositoryV1 } from '../src/submissionAttemptsMemory.js';
import {
  applySubmissionAttemptUpdateV1,
  attemptStatusFromSubmissionV1,
  newSubmissionAttemptV1,
  submissionAttemptBatchEffectV1,
  submissionAttemptCreateEffectV1,
  type CreateSubmissionAttemptInputV1,
} from '../src/submissionAttempts.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const LATER = new Date('2026-07-27T12:05:00.000Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;

function input(overrides: Partial<CreateSubmissionAttemptInputV1> = {}): CreateSubmissionAttemptInputV1 {
  return {
    tenantId: 'tenant-1',
    walletAddress: WALLET,
    goal: 'swap',
    routeRunId: 'run-1',
    blueprintId: 'blueprint-1',
    approvedCallsHash: HASH,
    proofId: 'proof-1',
    now: NOW,
    ...overrides,
  };
}

function repository(): InMemorySubmissionAttemptRepositoryV1 {
  let sequence = 0;
  return new InMemorySubmissionAttemptRepositoryV1(() => {
    sequence += 1;
    return `submission-attempt:${sequence}`;
  });
}

describe('creating an attempt', () => {
  test('a repeat of the same request returns the same attempt', async () => {
    const repo = repository();
    const first = await repo.createAttempt(input());
    const second = await repo.createAttempt(input({ now: LATER }));
    assert.equal(first.id, second.id, 'a double-click must not open a second attempt');
    assert.equal(second.status, 'wallet_pending');
  });

  test('an open attempt bound to different approved calls is a conflict, not a reuse', async () => {
    // Reusing it would attach the next wallet batch to the wrong transaction.
    const repo = repository();
    await repo.createAttempt(input());
    await assert.rejects(
      repo.createAttempt(input({ approvedCallsHash: `0x${'cd'.repeat(32)}` })),
      RouteStorageConflictError,
    );
  });

  test('a terminal attempt frees the blueprint for a genuinely new one', async () => {
    const repo = repository();
    const first = await repo.createAttempt(input());
    await repo.updateAttempt({ attemptId: first.id, tenantId: 'tenant-1', status: 'cancelled', now: LATER });
    const second = await repo.createAttempt(input({ now: LATER }));
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'wallet_pending');
  });

  test('a new attempt carries no batch and no completion time', async () => {
    const attempt = newSubmissionAttemptV1('submission-attempt:x', input());
    assert.equal(attempt.batchId, null);
    assert.equal(attempt.completedAt, null);
    assert.equal(attempt.walletAddress, WALLET.toLowerCase());
  });
});

describe('binding a batch', () => {
  test('the same batch twice is idempotent', async () => {
    const repo = repository();
    const created = await repo.createAttempt(input());
    const first = await repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER });
    const second = await repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER });
    assert.equal(first?.batchId, 'batch-1');
    assert.equal(first?.status, 'batch_observed');
    assert.equal(second?.batchId, 'batch-1');
  });

  test('a different batch is a conflict and never an overwrite', async () => {
    // Two batches against one approved blueprint means one is a duplicate
    // spend. Replacing the field would erase the evidence of which.
    const repo = repository();
    const created = await repo.createAttempt(input());
    await repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER });
    await assert.rejects(
      repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-1', batchId: 'batch-2', now: LATER }),
      RouteStorageConflictError,
    );
    const stored = await repo.getAttempt(created.id, 'tenant-1');
    assert.equal(stored?.batchId, 'batch-1', 'the first batch survives');
  });

  test('one wallet batch cannot belong to two attempts', async () => {
    const repo = repository();
    const first = await repo.createAttempt(input());
    await repo.bindBatch({ attemptId: first.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER });
    await repo.updateAttempt({ attemptId: first.id, tenantId: 'tenant-1', status: 'cancelled', now: LATER });
    const second = await repo.createAttempt(input({ now: LATER }));
    await assert.rejects(
      repo.bindBatch({ attemptId: second.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER }),
      RouteStorageConflictError,
    );
  });

  test('another tenant gets null, which the route turns into a 404', async () => {
    const repo = repository();
    const created = await repo.createAttempt(input());
    assert.equal(await repo.getAttempt(created.id, 'tenant-2'), null);
    assert.equal(
      await repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-2', batchId: 'batch-1', now: LATER }),
      null,
    );
  });
});

describe('what is recoverable', () => {
  test('submitted_unknown stays recoverable, because nobody knows yet', async () => {
    const repo = repository();
    const created = await repo.createAttempt(input());
    await repo.bindBatch({ attemptId: created.id, tenantId: 'tenant-1', batchId: 'batch-1', now: LATER });
    await repo.updateAttempt({
      attemptId: created.id,
      tenantId: 'tenant-1',
      status: 'submitted_unknown',
      now: LATER,
    });
    const open = await repo.listRecoverable('tenant-1', WALLET);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.status, 'submitted_unknown');
  });

  test('abandoned and failed attempts stop being offered', async () => {
    const repo = repository();
    const created = await repo.createAttempt(input());
    await repo.updateAttempt({ attemptId: created.id, tenantId: 'tenant-1', status: 'abandoned', now: LATER });
    assert.deepEqual(await repo.listRecoverable('tenant-1', WALLET), []);
  });

  test('another wallet on the same tenant sees nothing', async () => {
    const repo = repository();
    await repo.createAttempt(input());
    assert.deepEqual(
      await repo.listRecoverable('tenant-1', '0x2222222222222222222222222222222222222222'),
      [],
    );
  });
});

describe('the schema is the guard, not the caller', () => {
  test('a batch-bound status without a batch id is refused', () => {
    const attempt = newSubmissionAttemptV1('submission-attempt:x', input());
    assert.throws(
      () =>
        applySubmissionAttemptUpdateV1(attempt, {
          attemptId: attempt.id,
          tenantId: 'tenant-1',
          status: 'submitted',
          now: LATER,
        }),
      RouteStorageIntegrityError,
    );
  });

  test('a terminal attempt records when it finished', () => {
    const attempt = newSubmissionAttemptV1('submission-attempt:x', input());
    const cancelled = applySubmissionAttemptUpdateV1(attempt, {
      attemptId: attempt.id,
      tenantId: 'tenant-1',
      status: 'cancelled',
      now: LATER,
    });
    assert.equal(cancelled.completedAt, LATER.toISOString());
  });

  test('the write decision is shared, so the fake cannot be kinder than Postgres', () => {
    const existing = newSubmissionAttemptV1('submission-attempt:x', input());
    assert.deepEqual(submissionAttemptCreateEffectV1(null, input()), { effect: 'insert' });
    assert.deepEqual(submissionAttemptCreateEffectV1(existing, input()), { effect: 'return_existing' });
    assert.equal(
      submissionAttemptCreateEffectV1(existing, input({ routeRunId: 'run-2' })).effect,
      'conflict',
    );
    assert.deepEqual(submissionAttemptBatchEffectV1(existing, 'batch-1'), { effect: 'insert' });
    assert.equal(submissionAttemptBatchEffectV1({ ...existing, batchId: 'batch-1' }, 'batch-2').effect, 'conflict');
  });

  test('an attempt status exists for every submission status the wallet can report', () => {
    for (const status of ['submitted', 'submitted_unknown', 'confirmed', 'failed', 'cancelled']) {
      assert.ok(attemptStatusFromSubmissionV1(status), `${status} must map to an attempt status`);
    }
    assert.equal(attemptStatusFromSubmissionV1('made_up'), null);
  });
});
