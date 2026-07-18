import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructAssetChangesV1 } from '../src/assetChanges.js';
import { ARBITRARY_TOKEN, ETH_BASE, ROUTER, USDC_BASE, WALLET, WETH_BASE, transferLog } from './fixtures.js';

const EXPECTED_WETH_CHANGES = [
  { asset: USDC_BASE, direction: 'debit' as const, amountAtomic: '100000000', minimumAmountAtomic: '100000000', maximumAmountAtomic: '100000000' },
  { asset: WETH_BASE, direction: 'credit' as const, amountAtomic: '38000000000000000', minimumAmountAtomic: '37810000000000000', maximumAmountAtomic: null },
];

test('assetChanges: reconstructs USDC debit / WETH credit from Transfer logs', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: EXPECTED_WETH_CHANGES,
    successReceiptLogs: [
      transferLog(USDC_BASE.address as `0x${string}`, WALLET, ROUTER, BigInt(100000000)),
      transferLog(WETH_BASE.address as `0x${string}`, ROUTER, WALLET, BigInt(38000000000000000)),
    ],
  });
  assert.equal(outcome.kind, 'reconstructed');
  if (outcome.kind !== 'reconstructed') throw new Error('unreachable');
  assert.equal(outcome.actualResult.outputAmountAtomic, '38000000000000000');
  assert.deepEqual(outcome.actualResult.outputAsset, WETH_BASE);
  const debit = outcome.actualResult.assetChanges.find((c) => c.direction === 'debit')!;
  assert.equal(debit.amountAtomic, '100000000');
});

test('assetChanges: nets multiple transfers to/from the wallet (min 0, never negative)', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: EXPECTED_WETH_CHANGES,
    successReceiptLogs: [
      // Wallet receives WETH twice, then some routes back out through the pool.
      transferLog(WETH_BASE.address as `0x${string}`, ROUTER, WALLET, BigInt(40000000000000000)),
      transferLog(WETH_BASE.address as `0x${string}`, WALLET, ROUTER, BigInt(2000000000000000)),
      transferLog(USDC_BASE.address as `0x${string}`, WALLET, ROUTER, BigInt(100000000)),
    ],
  });
  assert.equal(outcome.kind, 'reconstructed');
  if (outcome.kind !== 'reconstructed') throw new Error('unreachable');
  assert.equal(outcome.actualResult.outputAmountAtomic, '38000000000000000');
});

test('assetChanges: native ETH output is honestly unsupported (no Transfer log exists for it)', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      EXPECTED_WETH_CHANGES[0]!,
      { asset: ETH_BASE, direction: 'credit', amountAtomic: '38000000000000000', minimumAmountAtomic: '37810000000000000', maximumAmountAtomic: null },
    ],
    successReceiptLogs: [],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'native_output_unverifiable' });
});

test('assetChanges: a NATIVE debit leg is unsupported — never a fabricated 0-amount debit (adversary repro)', () => {
  // Expected: pay native ETH, receive WETH. The WETH credit HAS a Transfer
  // log, but the native debit leg emits none — reconstruction must refuse,
  // not report "the wallet paid 0 ETH".
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      { asset: ETH_BASE, direction: 'debit', amountAtomic: '38000000000000000', minimumAmountAtomic: null, maximumAmountAtomic: null },
      EXPECTED_WETH_CHANGES[1]!,
    ],
    successReceiptLogs: [
      transferLog(WETH_BASE.address as `0x${string}`, ROUTER, WALLET, BigInt(38000000000000000)),
    ],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'unsupported_asset' });
});

test('assetChanges: a non-USDC erc20 debit leg is equally unsupported', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      { asset: ARBITRARY_TOKEN, direction: 'debit', amountAtomic: '1000', minimumAmountAtomic: null, maximumAmountAtomic: null },
      EXPECTED_WETH_CHANGES[1]!,
    ],
    successReceiptLogs: [
      transferLog(WETH_BASE.address as `0x${string}`, ROUTER, WALLET, BigInt(38000000000000000)),
    ],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'unsupported_asset' });
});

test('assetChanges: an output asset outside {USDC, WETH} is unsupported', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      EXPECTED_WETH_CHANGES[0]!,
      { asset: ARBITRARY_TOKEN, direction: 'credit', amountAtomic: '1000000000000000000', minimumAmountAtomic: null, maximumAmountAtomic: null },
    ],
    successReceiptLogs: [],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'unsupported_asset' });
});

test('assetChanges: malformed logs are skipped, not thrown, and never fabricate a transfer', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: EXPECTED_WETH_CHANGES,
    successReceiptLogs: [
      { address: WETH_BASE.address as string, topics: ['0xnotatransfer'], data: '0x00' },
      { address: WETH_BASE.address as string, topics: [], data: '0x00' },
    ],
  });
  assert.equal(outcome.kind, 'reconstructed');
  if (outcome.kind !== 'reconstructed') throw new Error('unreachable');
  assert.equal(outcome.actualResult.outputAmountAtomic, '0');
});
