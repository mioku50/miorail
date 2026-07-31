import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouteProofReconciler, type RouteOutcomeProjectorPortV1 } from '../src/reconciler.js';
import {
  NOW,
  TENANT,
  TX_HASH_1,
  WALLET,
  mockReceiptReader,
  revertedReceiptSource,
  seedRouteProofFixture,
  successSwapReceiptSource,
} from './fixtures.js';

// T67C.1 §3 — the projector seam.
//
// What is checked here is the WIRING, not the derivation (that lives in
// @mioagent/route-outcomes): that the projector fires exactly once, only on the
// pass that finalizes, and that its failure cannot reach the caller.

const LATER = new Date(NOW.getTime() + 60_000);

/** The one successful swap receipt every case here reconciles against. */
function swapSuccess() {
  return successSwapReceiptSource({
    transactionHash: TX_HASH_1,
    usdcAmountAtomic: '100000000',
    wethAmountAtomic: '38000000000000000',
  });
}

interface RecordingProjector extends RouteOutcomeProjectorPortV1 {
  calls: Array<{ finalStatus: string; routeRunId: string }>;
}

function recordingProjector(behaviour: 'ok' | 'throws' = 'ok'): RecordingProjector {
  const calls: Array<{ finalStatus: string; routeRunId: string }> = [];
  return {
    calls,
    async projectFinalizedProof(input) {
      calls.push({ finalStatus: input.proof.finalStatus, routeRunId: input.routeRunId });
      if (behaviour === 'throws') throw new Error('outcome store unavailable');
      return { status: 'recorded' };
    },
  };
}

test('a pass that finalizes a proof projects exactly one outcome', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const projector = recordingProjector();
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    receiptReader: mockReceiptReader({ [TX_HASH_1]: swapSuccess() }),
    outcomeProjector: projector,
  });

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(projector.calls, [{ finalStatus: 'completed', routeRunId: seeded.intent.id }]);
});

test('a verified revert also projects — a failure is an outcome', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const projector = recordingProjector();
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    receiptReader: mockReceiptReader({ [TX_HASH_1]: revertedReceiptSource({ transactionHash: TX_HASH_1 }) }),
    outcomeProjector: projector,
  });

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(projector.calls.length, 1);
});

test('reconciling an already-final proof does not project again', async () => {
  // The second call returns `already_finalized` long before any of this, so the
  // guarantee is structural — but a statistic that could be re-derived by
  // polling would inflate a provider's sample by however often the UI refreshes.
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const projector = recordingProjector();
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    receiptReader: mockReceiptReader({ [TX_HASH_1]: swapSuccess() }),
    outcomeProjector: projector,
  });
  const input = {
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  };

  await reconciler.reconcile(input);
  const second = await reconciler.reconcile({ ...input, now: new Date(LATER.getTime() + 1_000) });
  assert.equal(second.outcome, 'already_finalized');
  assert.equal(projector.calls.length, 1);
});

test('a proof that stays pending projects nothing', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const projector = recordingProjector();
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    // No receipt available: the proof stays pending, and a trade nobody has
    // seen finish must not contribute a statistic.
    receiptReader: mockReceiptReader({}),
    outcomeProjector: projector,
  });

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'pending');
  assert.equal(projector.calls.length, 0);
});

test('a projector that throws cannot fail the reconcile', async () => {
  // The proof is already written and its events appended. A statistics table
  // being down is not a reason to fail a response about a settled trade.
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const projector = recordingProjector('throws');
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    receiptReader: mockReceiptReader({ [TX_HASH_1]: swapSuccess() }),
    outcomeProjector: projector,
  });

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(projector.calls.length, 1);
  // And the proof really is terminal in storage, not rolled back.
  const stored = await seeded.repository.getProofProjection(seeded.proof.id, TENANT);
  assert.equal(stored?.finalStatus, 'completed');
});

test('no projector at all is a legal configuration — the flag being off', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reconciler = createRouteProofReconciler({
    repository: seeded.repository,
    receiptReader: mockReceiptReader({ [TX_HASH_1]: swapSuccess() }),
  });

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'completed');
});
