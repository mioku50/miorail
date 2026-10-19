import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi, type Hex } from 'viem';
import type { VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { nativeSendCheckV1 } from './nativeSendReconciliation.js';

// An ETH send emits no event of its own. Each case is a way a bundle could
// read as a transfer it is not, or fail to read as one it is.

const WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const BUNDLER = '0x4444444444444444444444444444444444444444';
const ENTRY_POINT_V06 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const AMOUNT = 100_000_000_000_000n; // 0.0001 ETH
const USER_OPERATION_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';

const WALLET_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const HANDLE_OPS_V06 = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
]);
const HANDLE_OPS_V07 = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
]);

/** ERC-8021 schema 0, as Base App appends its Builder Code. */
function attributed(data: Hex, code = 'bc_mnip'): Hex {
  const bytes = Buffer.from(code, 'ascii');
  return `${data}${bytes.toString('hex')}${bytes.length.toString(16).padStart(2, '0')}0080218021802180218021802180218021` as Hex;
}

function batch(calls: { target: string; value: bigint; data?: Hex }[]): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: 'executeBatch',
    args: [calls.map((call) => ({ target: call.target as Hex, value: call.value, data: call.data ?? '0x' }))] });
}

function bundleV06(ops: { sender: string; nonce: bigint; callData: Hex }[]): string {
  return encodeFunctionData({ abi: HANDLE_OPS_V06, functionName: 'handleOps', args: [ops.map((op) => ({
    sender: op.sender as Hex, nonce: op.nonce, initCode: '0x' as Hex, callData: op.callData, callGasLimit: 1n,
    verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
    paymasterAndData: '0x' as Hex, signature: '0x' as Hex,
  })), BUNDLER] });
}

function operationEvent(input: { sender?: string; nonce?: bigint; success?: boolean; address?: string } = {}) {
  return {
    address: input.address ?? ENTRY_POINT_V06,
    topics: [USER_OPERATION_EVENT, pad('0x01'), pad((input.sender ?? WALLET) as Hex), pad('0x00')],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }],
      [input.nonce ?? 7n, input.success ?? true, 1_000n, 90_000n],
    ),
  };
}

function receipt(logs: VerifiedReceiptSourceV1['logs'], status: 'success' | 'reverted' = 'success'): VerifiedReceiptSourceV1 {
  return { transactionHash: `0x${'ab'.repeat(32)}` as VerifiedReceiptSourceV1['transactionHash'], status, blockNumber: 52_000_000n,
    gasUsed: 200_000n, effectiveGasPriceWei: 1n, logs, from: BUNDLER };
}

function check(input: string, logs: VerifiedReceiptSourceV1['logs'], over: { to?: string; from?: string; value?: bigint; status?: 'success' | 'reverted' } = {}) {
  return nativeSendCheckV1({
    walletAddress: WALLET, recipient: RECIPIENT, amountWei: AMOUNT,
    transaction: { from: over.from ?? BUNDLER, to: over.to ?? ENTRY_POINT_V06, value: over.value ?? 0n, input },
    receipt: receipt(logs, over.status),
  });
}

const exactOp = { sender: WALLET, nonce: 7n, callData: batch([{ target: RECIPIENT, value: AMOUNT }]) };

describe('a smart account send, read from its own operation', () => {
  test("the wallet's operation that sent exactly the amount to the recipient, and ran, is matched", () => {
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent()]), { state: 'matched', errorCode: null });
  });

  test('a single execute reads the same as a batch of one', () => {
    const callData = encodeFunctionData({ abi: WALLET_ABI, functionName: 'execute', args: [RECIPIENT, AMOUNT, '0x'] });
    assert.equal(check(bundleV06([{ ...exactOp, callData }]), [operationEvent()]).state, 'matched');
  });

  test("a Builder Code on the call or on the operation is attribution, not the call's data", () => {
    const onCall = batch([{ target: RECIPIENT, value: AMOUNT, data: attributed('0x') }]);
    assert.equal(check(bundleV06([{ ...exactOp, callData: onCall }]), [operationEvent()]).state, 'matched');
    assert.equal(check(bundleV06([{ ...exactOp, callData: attributed(exactOp.callData, 'bc_z2uuo4dt') }]), [operationEvent()]).state, 'matched');
  });

  test('another operation in the same bundle does not stand in for the wallet', () => {
    const theirs = { sender: OTHER, nonce: 7n, callData: exactOp.callData };
    assert.deepEqual(check(bundleV06([theirs]), [operationEvent({ sender: OTHER })]),
      { state: 'mismatched', errorCode: 'base_mcp_transfer_facts_mismatch' });
    assert.equal(check(bundleV06([theirs, exactOp]), [operationEvent({ sender: OTHER }), operationEvent()]).state, 'matched');
  });

  test('a bundle that succeeded around a failed operation is not a send', () => {
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent({ success: false })]),
      { state: 'mismatched', errorCode: 'base_mcp_operation_failed' });
  });

  test('another amount, another recipient, calldata, or the amount twice is not the approved send', () => {
    const mismatch = { state: 'mismatched', errorCode: 'base_mcp_transfer_facts_mismatch' };
    for (const calls of [
      [{ target: RECIPIENT, value: AMOUNT + 1n }],
      [{ target: OTHER, value: AMOUNT }],
      [{ target: RECIPIENT, value: AMOUNT, data: '0xa9059cbb' as Hex }],
      [{ target: RECIPIENT, value: AMOUNT }, { target: RECIPIENT, value: AMOUNT }],
    ]) {
      assert.deepEqual(check(bundleV06([{ ...exactOp, callData: batch(calls) }]), [operationEvent()]), mismatch);
    }
  });

  test('only the EntryPoint the bundle called can say the operation ran, for its own nonce', () => {
    const missing = { state: 'unavailable', errorCode: 'base_mcp_operation_event_missing' };
    assert.deepEqual(check(bundleV06([exactOp]), []), missing);
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent({ address: OTHER })]), missing);
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent({ nonce: 8n })]), missing);
  });

  test('EntryPoint v0.7 packs its gas fields and reads the same', () => {
    const input = encodeFunctionData({ abi: HANDLE_OPS_V07, functionName: 'handleOps', args: [[{
      sender: WALLET, nonce: 7n, initCode: '0x', callData: exactOp.callData, accountGasLimits: pad('0x01'),
      preVerificationGas: 1n, gasFees: pad('0x01'), paymasterAndData: '0x', signature: '0x',
    }], BUNDLER] });
    assert.equal(check(input, [operationEvent({ address: ENTRY_POINT_V07 })], { to: ENTRY_POINT_V07 }).state, 'matched');
  });

  test('a bundle sent anywhere but an EntryPoint, or calldata that is not a bundle, is unreadable, not a mismatch', () => {
    const unreadable = { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' };
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent()], { to: OTHER }), unreadable);
    assert.deepEqual(check('0xdeadbeef', [operationEvent()]), unreadable);
    // An operation whose calldata is not Base Account's execute shape.
    assert.deepEqual(check(bundleV06([{ ...exactOp, callData: '0x12345678' }]), [operationEvent()]), unreadable);
  });

  test('a reverted transaction is never a send', () => {
    assert.deepEqual(check(bundleV06([exactOp]), [operationEvent()], { status: 'reverted' }),
      { state: 'mismatched', errorCode: 'base_mcp_transaction_reverted' });
  });
});

describe('a wallet that sent its own transaction', () => {
  test('is read from the transaction itself', () => {
    assert.equal(check('0x', [], { from: WALLET, to: RECIPIENT, value: AMOUNT }).state, 'matched');
    assert.equal(check('0x', [], { from: WALLET, to: RECIPIENT, value: AMOUNT - 1n }).state, 'mismatched');
    assert.equal(check('0xa9059cbb', [], { from: WALLET, to: RECIPIENT, value: AMOUNT }).state, 'mismatched');
    assert.equal(check('0x', [], { from: WALLET, to: OTHER, value: AMOUNT }).state, 'mismatched');
  });

  test("a call to itself is a delegated account's batch, which is not read here", () => {
    assert.deepEqual(check(exactOp.callData, [], { from: WALLET, to: WALLET }),
      { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' });
  });
});
