import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteProofReconciler } from '@mioagent/route-proof';
import { recordBlueprintSubmissionV1 } from '@mioagent/transaction-composer';
import {
  NOW, TENANT, WALLET, ARBITRARY_TOKEN, POOL, USDC_BASE,
  seedRouteProofFixture, mockReceiptReader, transferLog,
} from '../../../lib/route-proof/test/fixtures.js';
import { readBaseWalletBatchHashesV1, refreshStockExecutionV1, withStockExecutionReadV1 } from './stockExecutionStatus.js';

const TX = `0x${'ab'.repeat(32)}` as const;
const BATCH = `0x${'cd'.repeat(64)}`;
const LATER = new Date(NOW.getTime() + 10 * 60_000); // the quote already expired

function batchReply(overrides: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 1, result: { id: BATCH, chainId: '0x2105', status: 200,
    receipts: [{ transactionHash: TX, status: '0x1' }], ...overrides } };
}

test('stock status: the wallet reader sends only a bounded read to the fixed SDK endpoint', async () => {
  const fetcher = (async (url, init) => {
    assert.equal(url, 'https://rpc.wallet.coinbase.com');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      jsonrpc: '2.0', id: 1, method: 'wallet_getCallsStatus', params: [BATCH],
    });
    return Response.json(batchReply());
  }) as typeof fetch;
  assert.deepEqual(await readBaseWalletBatchHashesV1(BATCH, fetcher), [TX]);
});

for (const [label, overrides] of Object.entries({
  pending: { status: 100 }, wrongChain: { chainId: '0x1' }, missingChain: { chainId: undefined },
  wrongId: { id: 'other' }, missingId: { id: undefined }, malformedStatus: { status: '200' },
  missingReceipt: { receipts: [] }, malformedHash: { receipts: [{ transactionHash: 'broken' }] },
  partialMalformed: { receipts: [{ transactionHash: TX }, {}] },
  tooMany: { receipts: Array.from({ length: 17 }, () => ({ transactionHash: TX })) },
})) {
  test(`stock status: ${label} wallet answer never supplies receipt hints`, async () => {
    assert.equal(await readBaseWalletBatchHashesV1(BATCH,
      (async () => Response.json(batchReply(overrides))) as typeof fetch), null);
  });
}

test('stock status: failed batches still need real receipts, and duplicate hashes are read once', async () => {
  assert.deepEqual(await readBaseWalletBatchHashesV1(BATCH,
    (async () => Response.json(batchReply({ status: 500, receipts: [
      { transactionHash: TX, status: '0x0' }, { transactionHash: TX.toUpperCase().replace('0X', '0x') },
    ] }))) as typeof fetch), [TX]);
});

test('stock status: transport, RPC, oversized and non-JSON responses remain unavailable', async () => {
  const fetchers: typeof fetch[] = [
    async () => { throw new Error('private provider detail'); },
    async () => new Response('', { status: 429 }),
    async () => Response.json({ id: 1, error: { code: -1 }, result: batchReply().result }),
    async () => Response.json({ ...batchReply(), id: 2 }),
    async () => new Response('x'.repeat(128 * 1024 + 1)),
    async () => new Response('invalid json'),
  ];
  for (const fetcher of fetchers) assert.equal(await readBaseWalletBatchHashesV1(BATCH, fetcher), null);
});

async function fixture(submitted = true) {
  const seeded = await seedRouteProofFixture({ toAsset: ARBITRARY_TOKEN });
  if (submitted) await recordBlueprintSubmissionV1({ repository: seeded.repository }, {
    tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id,
    blueprintId: seeded.blueprint.id, approvedCallsHash: seeded.proof.approvedCallsHash,
    status: 'submitted', batchId: BATCH, now: NOW,
  });
  const input = { tenantId: TENANT, walletAddress: WALLET, routeRunId: seeded.intent.id,
    blueprintId: seeded.blueprint.id, refresh: true };
  return { ...seeded, input };
}

test('stock status: after quote expiry, resolve the stored batch then verify actual token movements', async () => {
  const f = await fixture();
  let walletReads = 0;
  const receipt = { transactionHash: TX, status: 'success' as const, blockNumber: 33123500n,
    gasUsed: 100000n, effectiveGasPriceWei: 1000000n, logs: [
      transferLog(USDC_BASE.address as `0x${string}`, WALLET, POOL, 100000000n),
      transferLog(ARBITRARY_TOKEN.address as `0x${string}`, POOL, WALLET, 38000000000000000n),
    ] };
  const reconciler = createRouteProofReconciler({ repository: f.repository,
    receiptReader: mockReceiptReader({ [TX]: receipt }) });
  const deps = { repository: f.repository, now: () => LATER,
    readBatchHashes: async (id: string) => { assert.equal(id, BATCH); walletReads++; return [TX]; },
    reconcile: reconciler.reconcile };
  assert.deepEqual(await refreshStockExecutionV1(deps, f.input), { batchId: BATCH });
  const proof = await f.repository.getProofProjection(f.proof.id, TENANT);
  assert.equal(proof?.finalStatus, 'completed');
  assert.equal(proof?.actualResult?.outputAmountAtomic, '38000000000000000');
  assert.deepEqual(proof?.transactionHashes, [TX]);
  const eventsBefore = await f.repository.listProofEvents(f.proof.id, TENANT);
  await refreshStockExecutionV1(deps, f.input);
  assert.deepEqual(await f.repository.listProofEvents(f.proof.id, TENANT), eventsBefore);
  assert.equal(walletReads, 1);
});

test('stock status: wallet success with no real receipt stays pending; retry uses the saved hash', async () => {
  const f = await fixture();
  let walletReads = 0;
  const deps = { repository: f.repository, now: () => LATER,
    readBatchHashes: async () => { walletReads++; return [TX]; },
    reconcile: createRouteProofReconciler({ repository: f.repository, receiptReader: mockReceiptReader({}) }).reconcile };
  await refreshStockExecutionV1(deps, f.input);
  await refreshStockExecutionV1(deps, f.input);
  const proof = await f.repository.getProofProjection(f.proof.id, TENANT);
  assert.equal(proof?.finalStatus, 'pending');
  assert.equal(proof?.actualResult, null);
  assert.equal(proof?.receipts[0]?.status, 'unknown');
  assert.equal(walletReads, 1);
});

for (const status of ['success', 'reverted'] as const) {
  test(`stock status: ${status} receipt without a token receipt never becomes entry success`, async () => {
    const f = await fixture();
    await refreshStockExecutionV1({ repository: f.repository, now: () => LATER,
      readBatchHashes: async () => [TX],
      reconcile: createRouteProofReconciler({ repository: f.repository, receiptReader: mockReceiptReader({
        [TX]: { transactionHash: TX, status, blockNumber: 33123500n, gasUsed: 1n,
          effectiveGasPriceWei: 1n, logs: [] },
      }) }).reconcile }, f.input);
    const proof = await f.repository.getProofProjection(f.proof.id, TENANT);
    assert.equal(proof?.finalStatus, status === 'reverted' ? 'failed' : 'reconciliation_required');
  });
}

test('stock status: missing, foreign and unsubmitted proofs never query the wallet or reconcile', async () => {
  const f = await fixture();
  const deps = { repository: f.repository, now: () => LATER,
    readBatchHashes: async () => { throw new Error('must not query wallet'); },
    reconcile: async () => { throw new Error('must not reconcile'); } };
  for (const input of [
    { ...f.input, tenantId: 'other' },
    { ...f.input, walletAddress: '0x2222222222222222222222222222222222222222' as const },
    { ...f.input, blueprintId: 'missing' }, { ...f.input, routeRunId: 'missing' },
  ]) assert.equal(await refreshStockExecutionV1(deps, input), null);
  assert.deepEqual(await refreshStockExecutionV1(deps, { ...f.input, refresh: false }), { batchId: BATCH });
  const notSubmitted = await fixture(false);
  assert.deepEqual(await refreshStockExecutionV1({ ...deps, repository: notSubmitted.repository },
    notSubmitted.input), { batchId: null });
});

test('stock status: unavailable wallet response preserves submitted proof and event history', async () => {
  const f = await fixture();
  const before = await f.repository.listProofEvents(f.proof.id, TENANT);
  await refreshStockExecutionV1({ repository: f.repository, now: () => LATER,
    readBatchHashes: async () => null, reconcile: async () => { throw new Error('not ready'); } }, f.input);
  assert.deepEqual(await f.repository.listProofEvents(f.proof.id, TENANT), before);
});

test('stock status: simultaneous reads share one operation, and failures are not cached', async () => {
  let calls = 0;
  const read = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return 'answer'; };
  assert.deepEqual(await Promise.all([withStockExecutionReadV1('owned', read),
    withStockExecutionReadV1('owned', read)]), ['answer', 'answer']);
  assert.equal(calls, 1);
  await assert.rejects(withStockExecutionReadV1('failed', async () => { throw new Error('unavailable'); }));
  assert.equal(await withStockExecutionReadV1('failed', read), 'answer');
});
