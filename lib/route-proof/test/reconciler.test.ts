import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRouteProofEventV1 } from '@mioagent/route-domain';
import type { RouteStorageRepository } from '@mioagent/route-storage';
import { RouteProofReconcileBindingError, createRouteProofReconciler } from '../src/reconciler.js';
import {
  ETH_BASE,
  NOW,
  ROUTER,
  TENANT,
  TX_HASH_1,
  TX_HASH_2,
  WALLET,
  mockReceiptReader,
  revertedReceiptSource,
  seedRouteProofFixture,
  successSwapReceiptSource,
  weth9MovementLog,
} from './fixtures.js';

const LATER = new Date(NOW.getTime() + 60_000);
const EVEN_LATER = new Date(NOW.getTime() + 120_000);

function reconcilerFor(seeded: Awaited<ReturnType<typeof seedRouteProofFixture>>, reader: ReturnType<typeof mockReceiptReader>) {
  return createRouteProofReconciler({ repository: seeded.repository, receiptReader: reader });
}

/** Wraps a real repository, delegating every method to it except the ones
 * overridden — used to exercise the reconciler's OWN binding checks with a
 * hand-crafted (individually schema-unconstrained) return value, since the
 * domain's self-verifying hash envelopes make it impossible to persist a
 * genuinely inconsistent Blueprint/Proof pair through the public repository
 * API (any such write is rejected earlier, at the storage layer itself). */
function repositoryWithOverrides(
  base: RouteStorageRepository,
  overrides: Partial<RouteStorageRepository>,
): RouteStorageRepository {
  const bound: Record<string, unknown> = {};
  let prototype: object | null = base as object;
  while (prototype && prototype !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      const value = (base as unknown as Record<string, unknown>)[key];
      if (typeof value === 'function' && !(key in bound)) bound[key] = value.bind(base);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return { ...(bound as unknown as RouteStorageRepository), ...overrides };
}

test('reconcile: no transaction hashes yet -> pending, pure no-op (no new events)', async () => {
  const seeded = await seedRouteProofFixture();
  const reader = mockReceiptReader({});
  const reconciler = reconcilerFor(seeded, reader);
  const eventsBefore = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'pending');
  assert.equal(result.proof.finalStatus, 'pending');
  assert.equal(reader.calls.length, 0);
  const eventsAfter = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(eventsAfter.length, eventsBefore.length);
});

test('reconcile: receipt unavailable onchain -> stays pending, no new events (unknown === unknown)', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({ [TX_HASH_1]: null });
  const reconciler = reconcilerFor(seeded, reader);
  const eventsBefore = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);

  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'pending');
  assert.equal(result.proof.finalStatus, 'pending');
  const eventsAfter = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(eventsAfter.length, eventsBefore.length);
});

test('reconcile: a partially-available batch stays pending but persists what DID verify', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1, TX_HASH_2] });
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: '100000000', wethAmountAtomic: '38000000000000000' }),
    [TX_HASH_2]: null,
  });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.proof.finalStatus, 'pending');
  const receiptStatuses = result.proof.receipts.map((r) => [r.transactionHash, r.status]);
  assert.deepEqual(receiptStatuses.sort(), [[TX_HASH_1, 'success'], [TX_HASH_2, 'unknown']].sort());
  // m2: a partial gas sum over only the receipts that happened to verify must
  // never be persisted while the proof is still pending.
  assert.equal(result.proof.actualGas, null);
  const stored = await seeded.repository.getProofProjection(seeded.proof.id, TENANT);
  assert.equal(stored!.actualGas, null);
  const events = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(events.at(-1)!.eventType, 'receipt_observed');
});

test('reconcile: successful WETH swap -> completed + matched, honest actual result, exact events', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const eventsBefore = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({
      transactionHash: TX_HASH_1,
      usdcAmountAtomic: seeded.intent.amount.amountAtomic,
      wethAmountAtomic: '38000000000000000',
    }),
  });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.proof.finalStatus, 'completed');
  assert.equal(result.proof.reconciliationState, 'matched');
  assert.equal(result.proof.actualOutput, '38000000000000000');
  assert.equal(result.proof.outputDeviationBps, 0);
  assert.equal(result.proof.minimumSatisfied, true);
  assert.ok(result.proof.actualGas);
  assert.equal(result.proof.actualGas!.gasUnits, '185000');
  assert.equal(result.lifecycle, 'completed');

  const events = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(events.length, eventsBefore.length + 3);
  const newTypes = events.slice(eventsBefore.length).map((e) => e.eventType);
  assert.deepEqual(newTypes, ['receipt_observed', 'reconciliation_updated', 'completed']);
});

test('reconcile: all-reverted batch -> failed', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({ [TX_HASH_1]: revertedReceiptSource({ transactionHash: TX_HASH_1 }) });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.proof.finalStatus, 'failed');
  assert.equal(result.proof.reconciliationState, 'failed');
  assert.equal(result.proof.actualOutput, null);
  assert.equal(result.lifecycle, 'failed');
});

test('reconcile: mixed success/reverted batch -> partial_failure', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1, TX_HASH_2] });
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '38000000000000000' }),
    [TX_HASH_2]: revertedReceiptSource({ transactionHash: TX_HASH_2 }),
  });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'partial_failure');
  assert.equal(result.proof.finalStatus, 'partial_failure');
  assert.equal(result.proof.reconciliationState, 'partial');
  const events = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.ok(events.some((e) => e.eventType === 'partial_failure'));
});

test('reconcile: duplicate transaction hash across a batch is treated once, no dup events', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '38000000000000000' }),
  });
  const reconciler = reconcilerFor(seeded, reader);
  const first = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(first.outcome, 'completed');
  const eventsAfterFirst = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);

  // Idempotent replay with identical chain data.
  const second = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: EVEN_LATER,
  });
  assert.equal(second.outcome, 'already_finalized');
  assert.equal(second.proof.finalStatus, 'completed');
  const eventsAfterSecond = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(eventsAfterSecond.length, eventsAfterFirst.length);
});

test('reconcile: idempotent repeat of a finalized proof never re-opens it', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({ [TX_HASH_1]: revertedReceiptSource({ transactionHash: TX_HASH_1 }) });
  const reconciler = reconcilerFor(seeded, reader);
  await reconciler.reconcile({ tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id, routeProofId: seeded.proof.id, now: LATER });
  const result = await reconciler.reconcile({ tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id, routeProofId: seeded.proof.id, now: EVEN_LATER });
  assert.equal(result.outcome, 'already_finalized');
  assert.equal(result.proof.finalStatus, 'failed');
});

test('reconcile: conflict wash (adversary repro) — manual_review is sticky and the verified receipt survives', async () => {
  const args = (seededProofId: string, seededRunId: string, now: Date) => ({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seededRunId,
    routeProofId: seededProofId,
    now,
  });

  // Step 1: TX1 verifies success, TX2 stays unavailable -> non-terminal pending.
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1, TX_HASH_2] });
  const readerRound1 = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '38000000000000000' }),
    [TX_HASH_2]: null,
  });
  const round1 = await createRouteProofReconciler({ repository: seeded.repository, receiptReader: readerRound1 }).reconcile(
    args(seeded.proof.id, seeded.intent.id, LATER),
  );
  assert.equal(round1.outcome, 'pending');

  // Step 2: RPC flap — TX1 now reads reverted (disagrees with the VERIFIED
  // success), TX2 succeeds. Conflict -> manual_review; crucially the
  // projection KEEPS the original verified success for TX1 instead of
  // adopting the disputed fresh read.
  const readerRound2 = mockReceiptReader({
    [TX_HASH_1]: revertedReceiptSource({ transactionHash: TX_HASH_1 }),
    [TX_HASH_2]: successSwapReceiptSource({ transactionHash: TX_HASH_2, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '38000000000000000' }),
  });
  const round2 = await createRouteProofReconciler({ repository: seeded.repository, receiptReader: readerRound2 }).reconcile(
    args(seeded.proof.id, seeded.intent.id, EVEN_LATER),
  );
  assert.equal(round2.outcome, 'reconciliation_required');
  assert.equal(round2.proof.finalStatus, 'reconciliation_required');
  assert.equal(round2.proof.reconciliationState, 'manual_review');
  const tx1Receipt = round2.proof.receipts.find((receipt) => receipt.transactionHash === TX_HASH_1);
  assert.equal(tx1Receipt!.status, 'success', 'the previously VERIFIED receipt must not be overwritten by a disputed read');

  // m1: the reconciliation_updated event must carry BOTH disputed values.
  const eventsAfterConflict = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  const updateEvent = [...eventsAfterConflict].reverse().find((event) => event.eventType === 'reconciliation_updated');
  assert.ok(updateEvent, 'a reconciliation_updated event must record the conflict');
  assert.deepEqual(updateEvent!.payload.receiptConflicts, [
    { transactionHash: TX_HASH_1, previousStatus: 'success', nextStatus: 'reverted' },
  ]);

  // Step 3: the chain reads consistent again (TX1 success, TX2 success) — a
  // pre-fix reconciler would now wash manual_review into completed/matched.
  const readerRound3 = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '38000000000000000' }),
    [TX_HASH_2]: successSwapReceiptSource({ transactionHash: TX_HASH_2, usdcAmountAtomic: '0', wethAmountAtomic: '0' }),
  });
  const round3 = await createRouteProofReconciler({ repository: seeded.repository, receiptReader: readerRound3 }).reconcile(
    args(seeded.proof.id, seeded.intent.id, new Date(EVEN_LATER.getTime() + 60_000)),
  );
  assert.equal(round3.outcome, 'already_finalized', 'manual_review must be a sticky no-op');
  assert.equal(round3.proof.finalStatus, 'reconciliation_required');
  assert.equal(round3.proof.reconciliationState, 'manual_review');

  // Step 4: any further reconcile stays locked; events never grow after the lock.
  const round4 = await createRouteProofReconciler({ repository: seeded.repository, receiptReader: readerRound3 }).reconcile(
    args(seeded.proof.id, seeded.intent.id, new Date(EVEN_LATER.getTime() + 120_000)),
  );
  assert.equal(round4.outcome, 'already_finalized');
  assert.equal(round4.proof.finalStatus, 'reconciliation_required');
  assert.equal(round4.proof.reconciliationState, 'manual_review');
  const eventsAfterLock = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  assert.equal(eventsAfterLock.length, eventsAfterConflict.length, 'no events may be appended after the manual_review lock');
});

test('reconcile: a legacy native-output manual review can be retried when WETH9 evidence appears', async () => {
  const seeded = await seedRouteProofFixture({ toAsset: ETH_BASE, transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '0' }),
  });
  const reconciler = reconcilerFor(seeded, reader);
  const first = await reconciler.reconcile({ tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id, routeProofId: seeded.proof.id, now: LATER });
  assert.equal(first.outcome, 'reconciliation_required');
  const secondReader = mockReceiptReader({
    [TX_HASH_1]: {
      ...successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '0' }),
      logs: [
        ...successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '0' }).logs,
        weth9MovementLog('withdrawal', ROUTER, 38000000000000000n),
      ],
    },
  });
  const second = await createRouteProofReconciler({ repository: seeded.repository, receiptReader: secondReader }).reconcile({ tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id, routeProofId: seeded.proof.id, now: EVEN_LATER });
  assert.equal(second.outcome, 'completed');
  assert.equal(second.proof.finalStatus, 'completed');
  assert.equal(second.proof.reconciliationState, 'matched');
  assert.equal(second.proof.actualOutput, '38000000000000000');
});

test('reconcile: native ETH output is completed from an approved-router WETH9 withdrawal', async () => {
  const seeded = await seedRouteProofFixture({ toAsset: ETH_BASE, transactionHashes: [TX_HASH_1] });
  const baseReceipt = successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: seeded.intent.amount.amountAtomic, wethAmountAtomic: '0' });
  const reader = mockReceiptReader({
    [TX_HASH_1]: { ...baseReceipt, logs: [...baseReceipt.logs, weth9MovementLog('withdrawal', ROUTER, 38000000000000000n)] },
  });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.proof.finalStatus, 'completed');
  assert.equal(result.proof.reconciliationState, 'matched');
  assert.equal(result.proof.actualOutput, '38000000000000000');
});

test('reconcile: actual below minimum -> completed but deviated, minimumSatisfied false', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({
      transactionHash: TX_HASH_1,
      usdcAmountAtomic: seeded.intent.amount.amountAtomic,
      // Below the fixture's minimumOutput (37810000000000000).
      wethAmountAtomic: '37000000000000000',
    }),
  });
  const reconciler = reconcilerFor(seeded, reader);
  const result = await reconciler.reconcile({
    tenantId: TENANT,
    walletAddress: WALLET,
    routeRunId: seeded.intent.id,
    routeProofId: seeded.proof.id,
    now: LATER,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.proof.reconciliationState, 'deviated');
  assert.equal(result.proof.minimumSatisfied, false);
});

test('reconcile: rejects a different tenant (wrong tenant cannot even find the run)', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({});
  const reconciler = reconcilerFor(seeded, reader);
  await assert.rejects(
    () =>
      reconciler.reconcile({
        tenantId: 'someone-elses-tenant',
        walletAddress: WALLET,
        routeRunId: seeded.intent.id,
        routeProofId: seeded.proof.id,
        now: LATER,
      }),
    (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'route_proof_not_found',
  );
});

test('reconcile: rejects a wallet mismatch', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const reader = mockReceiptReader({});
  const reconciler = reconcilerFor(seeded, reader);
  await assert.rejects(
    () =>
      reconciler.reconcile({
        tenantId: TENANT,
        walletAddress: '0x9999999999999999999999999999999999999999',
        routeRunId: seeded.intent.id,
        routeProofId: seeded.proof.id,
        now: LATER,
      }),
    (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'wallet_mismatch',
  );
});

test('reconcile: rejects a corrupted (non-hash-chained) event history', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const events = await seeded.repository.listProofEvents(seeded.proof.id, TENANT);
  // Append a well-formed-but-misdirected event: previousEventHash points at
  // events[0] instead of the real predecessor events[1].
  const broken = buildRouteProofEventV1({
    proof: seeded.proof,
    eventIndex: events.length,
    previousEventHash: events[0]!.eventHash,
    eventType: 'reconciliation_updated',
    payload: { tampered: true },
    now: LATER,
  });
  await seeded.repository.appendProofEvent(seeded.proof.id, broken);

  const reader = mockReceiptReader({});
  const reconciler = reconcilerFor(seeded, reader);
  await assert.rejects(
    () =>
      reconciler.reconcile({
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: seeded.intent.id,
        routeProofId: seeded.proof.id,
        now: LATER,
      }),
    (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'route_proof_conflict',
  );
});

test('reconcile: rejects when the Blueprint approvedCallsHash no longer matches the proof (binding drift)', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const realBlueprints = await seeded.repository.listBlueprints(seeded.intent.id, TENANT);
  const stub = repositoryWithOverrides(seeded.repository, {
    listBlueprints: async () =>
      realBlueprints.map((entry) => ({
        ...entry,
        blueprint: { ...entry.blueprint, approvedCallsHash: `0x${'ee'.repeat(32)}` as `0x${string}` },
      })),
  });
  const reconciler = createRouteProofReconciler({ repository: stub, receiptReader: mockReceiptReader({}) });
  await assert.rejects(
    () =>
      reconciler.reconcile({
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: seeded.intent.id,
        routeProofId: seeded.proof.id,
        now: LATER,
      }),
    (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'route_proof_conflict',
  );
});

test('reconcile: rejects when the proof blueprintHash no longer resolves to any Blueprint on the run', async () => {
  const seeded = await seedRouteProofFixture({ transactionHashes: [TX_HASH_1] });
  const stub = repositoryWithOverrides(seeded.repository, {
    getProofProjection: async () => ({ ...seeded.proof, blueprintHash: `0x${'ff'.repeat(32)}` as `0x${string}` }),
  });
  const reconciler = createRouteProofReconciler({ repository: stub, receiptReader: mockReceiptReader({}) });
  await assert.rejects(
    () =>
      reconciler.reconcile({
        tenantId: TENANT,
        walletAddress: WALLET,
        routeRunId: seeded.intent.id,
        routeProofId: seeded.proof.id,
        now: LATER,
      }),
    (error: unknown) => error instanceof RouteProofReconcileBindingError && error.code === 'route_proof_not_found',
  );
});
