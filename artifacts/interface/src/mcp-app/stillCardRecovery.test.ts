import assert from 'node:assert/strict';
import test from 'node:test';
import { stillCardHandsHashV1, stillCardLooksUpBatchV1 } from './stillCardRecovery';

// Synthetic batch ids and hashes only.
const BATCH = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'cd'.repeat(32)}`;

test('a sent batch is looked up in the wallet before Still has read anything, and not after the review is final', () => {
  assert.equal(stillCardLooksUpBatchV1({ paired: true, batchId: BATCH, executionState: null, found: null }), true);
  for (const state of ['awaiting_wallet', 'submitted', 'unknown']) assert.equal(stillCardLooksUpBatchV1({ paired: true, batchId: BATCH, executionState: state, found: null }), true, state);
  for (const state of ['confirmed', 'failed']) assert.equal(stillCardLooksUpBatchV1({ paired: true, batchId: BATCH, executionState: state, found: null }), false, state);
  assert.equal(stillCardLooksUpBatchV1({ paired: true, batchId: null, executionState: null, found: null }), false);
  assert.equal(stillCardLooksUpBatchV1({ paired: false, batchId: BATCH, executionState: null, found: null }), false);
  assert.equal(stillCardLooksUpBatchV1({ paired: true, batchId: BATCH, executionState: 'unknown', found: HASH }), false);
});

test('a found hash is handed to Still once, however its verification ends', () => {
  const ready = { found: HASH, hint: HASH, checking: false, handed: null };
  assert.equal(stillCardHandsHashV1(ready), true);
  // Handed once: an unresolved, failed or rate-limited check does not send it again.
  assert.equal(stillCardHandsHashV1({ ...ready, handed: HASH }), false);
  assert.equal(stillCardHandsHashV1({ ...ready, checking: true }), false);
  assert.equal(stillCardHandsHashV1({ ...ready, hint: '' }), false);
  assert.equal(stillCardHandsHashV1({ ...ready, found: null }), false);
  // Another hash, for another review, is its own.
  assert.equal(stillCardHandsHashV1({ found: BATCH, hint: BATCH, checking: false, handed: HASH }), true);
});
