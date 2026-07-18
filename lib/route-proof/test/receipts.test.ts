import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteProofReceiptIntegrityError, verifyTransactionReceiptsV1 } from '../src/receipts.js';
import { TX_HASH_1, TX_HASH_2, mockReceiptReader, revertedReceiptSource, successSwapReceiptSource } from './fixtures.js';

test('receipts: unavailable receipt maps to an honest unknown placeholder', async () => {
  const reader = mockReceiptReader({ [TX_HASH_1]: null });
  const results = await verifyTransactionReceiptsV1({
    transactionHashes: [TX_HASH_1],
    existingReceipts: [],
    reader,
  });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.receipt, { transactionHash: TX_HASH_1, status: 'unknown', blockNumber: null, gasUsed: null });
  assert.equal(results[0]!.source, null);
  assert.equal(results[0]!.conflict, null);
});

test('receipts: verified success/reverted map to strict TransactionReceiptV1', async () => {
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: '100000000', wethAmountAtomic: '38000000000000000' }),
    [TX_HASH_2]: revertedReceiptSource({ transactionHash: TX_HASH_2 }),
  });
  const results = await verifyTransactionReceiptsV1({
    transactionHashes: [TX_HASH_1, TX_HASH_2],
    existingReceipts: [],
    reader,
  });
  assert.equal(results[0]!.receipt.status, 'success');
  assert.equal(results[1]!.receipt.status, 'reverted');
  assert.ok(results[0]!.source);
  assert.ok(results[1]!.source);
});

test('receipts: no conflict when the existing receipt was only an unknown wallet-hint placeholder', async () => {
  const reader = mockReceiptReader({
    [TX_HASH_1]: successSwapReceiptSource({ transactionHash: TX_HASH_1, usdcAmountAtomic: '100000000', wethAmountAtomic: '38000000000000000' }),
  });
  const results = await verifyTransactionReceiptsV1({
    transactionHashes: [TX_HASH_1],
    existingReceipts: [{ transactionHash: TX_HASH_1, status: 'unknown', blockNumber: null, gasUsed: null }],
    reader,
  });
  assert.equal(results[0]!.conflict, null);
});

test('receipts: conflict when a PREVIOUSLY VERIFIED receipt disagrees with a fresh read', async () => {
  const reader = mockReceiptReader({
    [TX_HASH_1]: revertedReceiptSource({ transactionHash: TX_HASH_1 }),
  });
  const results = await verifyTransactionReceiptsV1({
    transactionHashes: [TX_HASH_1],
    existingReceipts: [{ transactionHash: TX_HASH_1, status: 'success', blockNumber: '1', gasUsed: '1' }],
    reader,
  });
  assert.deepEqual(results[0]!.conflict, { previousStatus: 'success', nextStatus: 'reverted' });
});

test('receipts: throws a typed integrity error when the reader returns a mismatched hash', async () => {
  const reader = {
    async getTransactionReceipt() {
      return successSwapReceiptSource({ transactionHash: TX_HASH_2, usdcAmountAtomic: '1', wethAmountAtomic: '1' });
    },
  };
  await assert.rejects(
    () => verifyTransactionReceiptsV1({ transactionHashes: [TX_HASH_1], existingReceipts: [], reader }),
    RouteProofReceiptIntegrityError,
  );
});

test('receipts: never fabricates success from an unavailable receipt', async () => {
  const reader = mockReceiptReader({});
  const results = await verifyTransactionReceiptsV1({
    transactionHashes: [TX_HASH_1],
    existingReceipts: [],
    reader,
  });
  assert.notEqual(results[0]!.receipt.status, 'success');
  assert.equal(results[0]!.receipt.status, 'unknown');
});
