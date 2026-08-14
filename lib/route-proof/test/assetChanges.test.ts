import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructAssetChangesV1 } from '../src/assetChanges.js';
import { ARBITRARY_TOKEN, ETH_BASE, ROUTER, USDC_BASE, WALLET, WETH_BASE, transferLog, weth9MovementLog } from './fixtures.js';

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

test('assetChanges: native ETH output without a router-bound WETH9 event is honestly unsupported', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      EXPECTED_WETH_CHANGES[0]!,
      { asset: ETH_BASE, direction: 'credit', amountAtomic: '38000000000000000', minimumAmountAtomic: '37810000000000000', maximumAmountAtomic: null },
    ],
    successReceiptLogs: [],
    approvedCallTargets: [ROUTER],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'native_output_unverifiable' });
});

test('assetChanges: a native debit with no router-bound WETH9 event is unsupported — never a fabricated zero', () => {
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
    approvedCallTargets: [ROUTER],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'native_output_unverifiable' });
});

test('assetChanges: reconstructs USDC debit / native ETH credit from a router-bound WETH9 Withdrawal', () => {
  const output = 38000000000000000n;
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      EXPECTED_WETH_CHANGES[0]!,
      { asset: ETH_BASE, direction: 'credit', amountAtomic: output.toString(), minimumAmountAtomic: '37810000000000000', maximumAmountAtomic: null },
    ],
    successReceiptLogs: [
      transferLog(USDC_BASE.address as `0x${string}`, WALLET, ROUTER, 100000000n),
      weth9MovementLog('withdrawal', ROUTER, output),
    ],
    approvedCallTargets: [ROUTER],
  });
  assert.equal(outcome.kind, 'reconstructed');
  if (outcome.kind !== 'reconstructed') throw new Error('unreachable');
  assert.equal(outcome.actualResult.outputAmountAtomic, output.toString());
  assert.equal(outcome.actualResult.outputAsset?.kind, 'native');
});

test('assetChanges: reconstructs native ETH debit / USDC credit from a router-bound WETH9 Deposit', () => {
  const input = 100000000000000n;
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      { asset: ETH_BASE, direction: 'debit', amountAtomic: input.toString(), minimumAmountAtomic: input.toString(), maximumAmountAtomic: input.toString() },
      { asset: USDC_BASE, direction: 'credit', amountAtomic: '191116', minimumAmountAtomic: '190160', maximumAmountAtomic: null },
    ],
    successReceiptLogs: [
      weth9MovementLog('deposit', ROUTER, input),
      transferLog(USDC_BASE.address as `0x${string}`, ROUTER, WALLET, 191116n),
    ],
    approvedCallTargets: [ROUTER],
  });
  assert.equal(outcome.kind, 'reconstructed');
  if (outcome.kind !== 'reconstructed') throw new Error('unreachable');
  assert.equal(outcome.actualResult.outputAmountAtomic, '191116');
  assert.equal(outcome.actualResult.assetChanges[0]?.amountAtomic, input.toString());
});

test('assetChanges: ignores a WETH9 movement whose actor was not an approved call target', () => {
  const outcome = reconstructAssetChangesV1({
    walletAddress: WALLET,
    expectedAssetChanges: [
      EXPECTED_WETH_CHANGES[0]!,
      { asset: ETH_BASE, direction: 'credit', amountAtomic: '1', minimumAmountAtomic: '1', maximumAmountAtomic: null },
    ],
    successReceiptLogs: [weth9MovementLog('withdrawal', WALLET, 1n)],
    approvedCallTargets: [ROUTER],
  });
  assert.deepEqual(outcome, { kind: 'unsupported', reason: 'native_output_unverifiable' });
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

test('assetChanges: an output asset outside {USDC, WETH,native ETH} is unsupported', () => {
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
