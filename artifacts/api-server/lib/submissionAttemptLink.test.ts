import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { InMemorySubmissionAttemptRepositoryV1 } from '@mioagent/route-storage';
import { recordAttemptOutcomeV1, verifySubmissionAttemptV1 } from './submissionAttemptLink.js';

// 2026-11-11: fourteen swaps on one wallet had completed and every one still
// stood among "Wallet requests to check". Each was sent in two or three steps;
// the id of such a swap is 258 or 322 characters, the attempt allowed 200, and
// the refusal was swallowed here without a word.

const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = new Date('2026-11-11T20:14:32.000Z');
const SENT = new Date('2026-11-11T20:14:51.000Z');
const CONFIRMED = new Date('2026-11-11T20:14:52.000Z');

/** viem's fallback id of transactions sent one at a time: each hash, the chain id, a marker. */
const stepsId = (steps: number) => `0x${'cd'.repeat(32 * steps)}${'00'.repeat(30)}2105${'5792'.repeat(16)}`;

function repository(): InMemorySubmissionAttemptRepositoryV1 {
  let sequence = 0;
  return new InMemorySubmissionAttemptRepositoryV1(() => {
    sequence += 1;
    return `submission-attempt:${sequence}`;
  });
}

async function opened(repo: InMemorySubmissionAttemptRepositoryV1) {
  return repo.createAttempt({
    tenantId: TENANT,
    walletAddress: WALLET,
    goal: 'swap',
    routeRunId: 'run-1',
    blueprintId: 'blueprint-1',
    approvedCallsHash: HASH,
    proofId: 'proof-1',
    now: NOW,
  });
}

describe('the outcome of a swap sent in steps reaches its attempt', () => {
  for (const steps of [2, 3]) {
    test(`${steps} steps: submitted, then confirmed, and nothing is left to check`, async () => {
      const repo = repository();
      const attempt = await opened(repo);
      const batchId = stepsId(steps);

      const link = await verifySubmissionAttemptV1(repo, {
        attemptId: attempt.id,
        tenantId: TENANT,
        blueprintId: 'blueprint-1',
        approvedCallsHash: HASH,
      });
      assert.equal(link.ok, true);
      if (!link.ok) return;

      await recordAttemptOutcomeV1(repo, {
        attempt: link.attempt,
        tenantId: TENANT,
        submissionStatus: 'submitted',
        proofId: 'proof-1',
        batchId,
        errorCode: null,
        now: SENT,
      });
      const submitted = await repo.getAttempt(attempt.id, TENANT);
      assert.equal(submitted?.status, 'submitted');
      assert.equal(submitted?.batchId, batchId);

      await recordAttemptOutcomeV1(repo, {
        attempt: submitted,
        tenantId: TENANT,
        submissionStatus: 'confirmed',
        proofId: 'proof-1',
        batchId,
        errorCode: null,
        now: CONFIRMED,
      });
      const confirmed = await repo.getAttempt(attempt.id, TENANT);
      assert.equal(confirmed?.status, 'confirmed');
      assert.equal(confirmed?.batchId, batchId);
      // What a page lists as a wallet request to check is every open attempt but the confirmed.
      const toCheck = (await repo.listRecoverable(TENANT, WALLET)).filter((entry) => entry.status !== 'confirmed');
      assert.deepEqual(toCheck, []);
    });
  }

  test('an update the store refuses never reaches the response, and the attempt stays open', async () => {
    const repo = repository();
    const attempt = await opened(repo);
    await assert.doesNotReject(
      recordAttemptOutcomeV1(repo, {
        attempt,
        tenantId: TENANT,
        submissionStatus: 'submitted',
        proofId: 'proof-1',
        // Longer than any attempt may carry.
        batchId: `0x${'c'.repeat(600)}`,
        errorCode: null,
        now: SENT,
      }),
    );
    assert.equal((await repo.getAttempt(attempt.id, TENANT))?.status, 'wallet_pending');
  });
});
