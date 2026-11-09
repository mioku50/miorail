import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import type { VerifiedReceiptSourceV1, VerifiedReceiptLogV1 } from '@mioagent/route-proof';
import type { BaseTransactionSourceV1 } from './baseReceiptReader.js';
import { MemoryLoanExecutionStoreV1, type LoanExecutionV1 } from './loanExecutionStore.js';
import { bindLoanTransactionV1, delegatedAccountCallsV1, refreshLoanExecutionV1, type LoanExecutionStatusDepsV1 } from './loanExecutionStatus.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_WALLET_FIXTURE as WALLET, LOAN_OTHER_WALLET_FIXTURE as OTHER, LOAN_NOW_FIXTURE as NOW, LOAN_TX_FIXTURE as TX, LOAN_TARGET_FIXTURE as TARGET } from './loanExecutionTestFixtures.js';

const BUNDLER = `0x${'a'.repeat(40)}` as Address, ENTRY = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const USER_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const BEFORE: VerifiedReceiptLogV1 = { address: ENTRY, topics: [keccak256(stringToHex('BeforeExecution()'))], data: '0x' };
const OWN_EFFECT: VerifiedReceiptLogV1 = { address: TARGET, topics: [`0x${'7'.repeat(64)}`], data: '0x' };
const FOREIGN_EFFECT: VerifiedReceiptLogV1 = { address: OTHER, topics: [`0x${'8'.repeat(64)}`], data: '0x' };
const WALLET_ABI = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);
const OPS_ABI = parseAbi(['function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)']);
const OPS_ABI_V07 = parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']);
function event(patch: { sender?: string; nonce?: bigint; success?: boolean; address?: string } = {}): VerifiedReceiptLogV1 {
  return { address: patch.address ?? ENTRY, topics: [USER_EVENT, `0x${'6'.repeat(64)}`, pad((patch.sender ?? WALLET) as Hex, { size: 32 }), pad('0x00', { size: 32 })],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [patch.nonce ?? 7n, patch.success ?? true, 1n, 1n]) };
}
function batch(calls = loanReadyFixture().calls): Hex {
  return encodeFunctionData({ abi: WALLET_ABI, functionName: 'executeBatch', args: [calls.map(call => ({ target: call.to as Address, value: BigInt(call.valueWei), data: call.data as Hex }))] });
}
function bundle(ops = [{ sender: WALLET, nonce: 7n, callData: batch() }]): Hex {
  return encodeFunctionData({ abi: OPS_ABI, functionName: 'handleOps', args: [ops.map(op => ({ ...op, sender: op.sender as Address, initCode: '0x' as Hex, callGasLimit: 1n, verificationGasLimit: 1n,
    preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: '0x' as Hex, signature: '0x' as Hex })), BUNDLER] });
}
function receipt(logs: readonly VerifiedReceiptLogV1[] = [BEFORE, OWN_EFFECT, event()]): VerifiedReceiptSourceV1 {
  return { transactionHash: TX, status: 'success', blockNumber: 53000001n, gasUsed: 1n, effectiveGasPriceWei: 1n, logs, from: BUNDLER };
}
const transaction = (input = bundle()): BaseTransactionSourceV1 => ({ from: BUNDLER, to: ENTRY, value: 0n, input });
async function setup() {
  const store = new MemoryLoanExecutionStoreV1();
  const record = await store.putReady({ owner: OWNER, draftId: 'fixture-status-draft', run: loanReadyFixture(), now: NOW });
  const armed = await store.arm({ owner: OWNER, executionId: record.executionId, callsHash: record.run.callsHash, signingTermsHash: record.run.signingTermsHash, now: NOW }); assert(armed.ok);
  const submitted = await store.recordSubmission({ owner: OWNER, executionId: record.executionId, attemptId: armed.attemptId, outcome: 'submitted', batchId: 'synthetic-batch-hint', now: NOW }); assert(submitted);
  return { store, record: submitted };
}
function attributed(data: string): Hex {
  const codes = Buffer.from('bc_fixture').toString('hex');
  return `${data}${codes}${(codes.length / 2).toString(16).padStart(2, '0')}0080218021802180218021802180218021` as Hex;
}

describe('lending chain binding uses the exact own operation', () => {
  it('isolates own protocol logs from a neighbouring operation', async () => {
    const { record } = await setup();
    const result = bindLoanTransactionV1({ execution: record, transaction: transaction(bundle([{ sender: OTHER, nonce: 2n, callData: batch() }, { sender: WALLET, nonce: 7n, callData: batch() }])),
      receipt: receipt([BEFORE, FOREIGN_EFFECT, event({ sender: OTHER, nonce: 2n }), OWN_EFFECT, event()]) });
    assert.deepEqual(result, { state: 'matched', logs: [OWN_EFFECT], operationNonce: '7' });
  });
  it('accepts only an ERC8021 suffix on an otherwise byte-identical approved call', async () => {
    const { record } = await setup(); const calls = record.run.calls.map(call => ({ ...call, data: attributed(call.data) }));
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: transaction(bundle([{ sender: WALLET, nonce: 7n, callData: attributed(batch(calls)) }])), receipt: receipt() }).state, 'matched');
    calls[0]!.data = `${record.run.calls[0]!.data}00`;
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: transaction(bundle([{ sender: WALLET, nonce: 7n, callData: batch(calls) }])), receipt: receipt() }).state, 'unknown');
  });
  it('rejects changed call target, value, calldata, order, added call and an approval-only leg', async () => {
    const { record } = await setup(); const calls = record.run.calls;
    for (const changed of [calls.map((call, i) => i ? call : { ...call, to: OTHER }), calls.map((call, i) => i ? call : { ...call, valueWei: '1' }),
      calls.map((call, i) => i ? call : { ...call, data: '0x99999999' as Hex }), [...calls].reverse(), [...calls, calls[0]!], calls.slice(0, 1)]) {
      assert.equal(bindLoanTransactionV1({ execution: record, transaction: transaction(bundle([{ sender: WALLET, nonce: 7n, callData: batch(changed) }])), receipt: receipt() }).state, 'unknown');
    }
  });
  it('does not let a successful bundle conceal the failed own user operation', async () => {
    const { record } = await setup();
    assert.deepEqual(bindLoanTransactionV1({ execution: record, transaction: transaction(), receipt: receipt([BEFORE, event({ success: false })]) }), { state: 'failed', errorCode: 'loan_operation_reverted' });
  });
  it('requires the called EntryPoint, own sender and nonce, and an execution log boundary', async () => {
    const { record } = await setup();
    for (const logs of [[], [OWN_EFFECT, event()], [BEFORE, event({ nonce: 8n })], [BEFORE, event({ sender: OTHER })], [BEFORE, event({ address: OTHER })]]) {
      assert.equal(bindLoanTransactionV1({ execution: record, transaction: transaction(), receipt: receipt(logs) }).state, 'unknown');
    }
  });
  it('reads the packed v0.7 operation and requires its own EntryPoint event', async () => {
    const { record } = await setup(); const entry = '0x0000000071727de22e5e9d8baf0edac6f37da032';
    const input = encodeFunctionData({ abi: OPS_ABI_V07, functionName: 'handleOps', args: [[{ sender: WALLET as Address, nonce: 7n, initCode: '0x', callData: batch(),
      accountGasLimits: pad('0x01', { size: 32 }), preVerificationGas: 1n, gasFees: pad('0x01', { size: 32 }), paymasterAndData: '0x', signature: '0x' }], BUNDLER] });
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: { ...transaction(input), to: entry },
      receipt: receipt([{ ...BEFORE, address: entry }, OWN_EFFECT, event({ address: entry })]) }).state, 'matched');
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: { ...transaction(input), to: entry }, receipt: receipt() }).state, 'unknown');
  });
  it('refuses two matching own operations, rather than confirming an action sent twice', async () => {
    const { record } = await setup(); const ops = [{ sender: WALLET, nonce: 7n, callData: batch() }, { sender: WALLET, nonce: 8n, callData: batch() }];
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: transaction(bundle(ops)), receipt: receipt([BEFORE, OWN_EFFECT, event(), OWN_EFFECT, event({ nonce: 8n })]) }).state, 'unknown');
  });
  it('can bind a direct owner transaction only when the complete approved call list has one call', async () => {
    const { record } = await setup(); const first = record.run.calls[0]!;
    const tx = { from: WALLET, to: first.to, value: 0n, input: first.data };
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: tx, receipt: { ...receipt(), from: WALLET } }).state, 'unknown');
  });
});

describe('lending completion is chain evidence, not SDK status', () => {
  const input = (record: LoanExecutionV1) => ({ owner: OWNER, executionId: record.executionId, refresh: true });
  function dependencies(store: MemoryLoanExecutionStoreV1, patch: Partial<LoanExecutionStatusDepsV1> = {}): LoanExecutionStatusDepsV1 {
    return { store, reader: { getTransaction: async () => transaction(), getTransactionReceipt: async () => receipt() }, readBatchHashes: async () => [TX],
      verifyEffectPosition: async () => ({ state: 'matched', proof: { exactProtocolEffectsAndPinnedPosition: true } }), now: () => NOW, ...patch };
  }
  it('confirms only after exact operation binding and the effect/position verifier', async () => {
    const { store, record } = await setup(); let checked = 0;
    const result = await refreshLoanExecutionV1(input(record), dependencies(store, { verifyEffectPosition: async ({ logs, operationNonce }) => {
      checked++; assert.deepEqual(logs, [OWN_EFFECT]); assert.equal(operationNonce, '7'); return { state: 'matched', proof: { exactProtocolEffectsAndPinnedPosition: true } };
    } }));
    assert.equal(result!.state, 'confirmed'); assert.equal(checked, 1); assert.equal(result!.transactionHash, TX); assert.equal(typeof result!.verification!.receiptFingerprint, 'string');
  });
  it('does not interpret the batch id or receipt success as debt reduction', async () => {
    const { store, record } = await setup();
    const result = await refreshLoanExecutionV1(input(record), dependencies(store, { verifyEffectPosition: async () => ({ state: 'unavailable', errorCode: 'position_not_read' }) }));
    assert.equal(result!.state, 'unknown'); assert.equal(result!.errorCode, 'position_not_read');
  });
  it('keeps a protocol or foreign-market effect mismatch unknown, without releasing its scope lock', async () => {
    const { store, record } = await setup();
    const result = await refreshLoanExecutionV1(input(record), dependencies(store, { verifyEffectPosition: async () => ({ state: 'mismatched', errorCode: 'loan_protocol_event_mismatch' }) }));
    assert.equal(result!.state, 'unknown');
    const next = await store.putReady({ owner: OWNER, draftId: 'another-foreign-market', run: loanReadyFixture(), now: NOW });
    assert.equal((await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: next.run.callsHash, signingTermsHash: next.run.signingTermsHash, now: NOW })).ok, false);
  });
  it('does not unlock a different or approval-only receipt as a failed loan', async () => {
    const { store, record } = await setup(); let checked = 0;
    const result = await refreshLoanExecutionV1(input(record), dependencies(store, { reader: { getTransaction: async () => transaction(bundle([{ sender: WALLET, nonce: 7n, callData: batch(record.run.calls.slice(0, 1)) }])), getTransactionReceipt: async () => receipt() },
      verifyEffectPosition: async () => { checked++; return { state: 'matched', proof: {} }; } }));
    assert.equal(result!.state, 'unknown'); assert.equal(checked, 0);
    const next = await store.putReady({ owner: OWNER, draftId: 'another-status-draft', run: loanReadyFixture(), now: NOW });
    assert.equal((await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: next.run.callsHash, signingTermsHash: next.run.signingTermsHash, now: NOW })).ok, false);
  });
  it('marks failed only when the exact approved operation actually reverted', async () => {
    const { store, record } = await setup();
    const result = await refreshLoanExecutionV1(input(record), dependencies(store, { reader: { getTransaction: async () => transaction(), getTransactionReceipt: async () => receipt([BEFORE, event({ success: false })]) } }));
    assert.equal(result!.state, 'failed'); assert.equal(result!.errorCode, 'loan_operation_reverted');
  });
  it('removes confirmed from the response after a missing or changed receipt', async () => {
    for (const missing of [true, false]) {
      const { store, record } = await setup(); const deps = dependencies(store);
      assert.equal((await refreshLoanExecutionV1(input(record), deps))!.state, 'confirmed');
      deps.reader = { getTransaction: async () => transaction(), getTransactionReceipt: async () => missing ? null : { ...receipt(), blockNumber: 53000002n } };
      const result = await refreshLoanExecutionV1(input(record), deps);
      assert.equal(result!.state, 'unknown'); assert.match(result!.errorCode!, missing ? /not_matched/ : /receipt_changed/);
    }
  });
  it('does not pass another tenant through to any chain reader', async () => {
    const { store, record } = await setup(); let reads = 0;
    const result = await refreshLoanExecutionV1({ ...input(record), owner: { walletAddress: OTHER, tenantId: `eip155:8453:${OTHER}` } }, dependencies(store, { readBatchHashes: async () => { reads++; return [TX]; } }));
    assert.equal(result, null); assert.equal(reads, 0);
  });
  it('does not present a stale confirmed result if the execution changed during verification', async () => {
    const { store, record } = await setup(); const deps = dependencies(store);
    const actual = store.recordVerification.bind(store); store.recordVerification = async () => null;
    assert.equal((await refreshLoanExecutionV1(input(record), deps))!.state, 'unknown'); store.recordVerification = actual;
  });
});

// 2026-11-09: a MetaMask loan landed in 12 s as the wallet's own transaction to itself, through its EIP-7702
// delegate's `execute(bytes32, bytes)`, and stayed "sent": Still could neither name its hash nor read its calls.
describe('a batch the wallet sent itself, through its EIP-7702 delegate', () => {
  const DELEGATED_ABI = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
  const BATCH_MODE = `0x01${'0'.repeat(62)}` as Hex, SINGLE_MODE = `0x00${'0'.repeat(62)}` as Hex;
  const EXECUTIONS = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;
  const execute = (mode: Hex = BATCH_MODE, calls = loanReadyFixture().calls) => encodeFunctionData({ abi: DELEGATED_ABI, functionName: 'execute',
    args: [mode, encodeAbiParameters(EXECUTIONS, [calls.map(call => ({ target: call.to as Address, value: BigInt(call.valueWei), callData: call.data as Hex }))])] });
  const own = (input: Hex): BaseTransactionSourceV1 => ({ from: WALLET, to: WALLET, value: 0n, input });
  const ownReceipt = (status: 'success' | 'reverted' = 'success'): VerifiedReceiptSourceV1 => ({ ...receipt([OWN_EFFECT]), status, from: WALLET });
  const input = (record: LoanExecutionV1) => ({ owner: OWNER, executionId: record.executionId, refresh: true });
  const deps = (store: MemoryLoanExecutionStoreV1, reader: LoanExecutionStatusDepsV1['reader']): LoanExecutionStatusDepsV1 => ({ store, reader, readBatchHashes: async () => null,
    verifyEffectPosition: async () => ({ state: 'matched', proof: { exactProtocolEffectsAndPinnedPosition: true } }), now: () => NOW });

  it('binds exactly the approved calls in the default batch mode, and a revert as a failure', async () => {
    const { record } = await setup();
    assert.deepEqual(bindLoanTransactionV1({ execution: record, transaction: own(execute()), receipt: ownReceipt() }), { state: 'matched', logs: [OWN_EFFECT], operationNonce: null });
    assert.deepEqual(bindLoanTransactionV1({ execution: record, transaction: own(execute()), receipt: ownReceipt('reverted') }), { state: 'failed', errorCode: 'loan_transaction_reverted' });
  });
  it('binds nothing a successful receipt would not prove: try mode, delegatecall, a mode with a selector, other calls, another sender', async () => {
    const { record } = await setup(); const calls = record.run.calls;
    for (const changed of [execute(`0x0101${'0'.repeat(60)}` as Hex), execute(`0xff00${'0'.repeat(60)}` as Hex), execute(`0x01000000000078210001${'0'.repeat(44)}` as Hex),
      execute(BATCH_MODE, [...calls, calls[0]!]), execute(BATCH_MODE, calls.map((call, i) => i ? call : { ...call, to: OTHER as Address })), execute(BATCH_MODE, [...calls].reverse())]) {
      assert.equal(bindLoanTransactionV1({ execution: record, transaction: own(changed), receipt: ownReceipt() }).state, 'unknown');
    }
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: { ...own(execute()), from: OTHER }, receipt: { ...ownReceipt(), from: OTHER } }).state, 'unknown');
  });
  it('binds the calls carrying the code after the zeros that end each on a word, as Still sends a wallet that drops dataSuffix', async () => {
    const { record } = await setup(); const code = attributed('0x').slice(2);
    const aligned = record.run.calls.map(call => { const bytes = (call.data.length - 2) / 2, fill = (32 - ((bytes + code.length / 2) % 32)) % 32;
      return { ...call, data: `${call.data}${'00'.repeat(fill)}${code}` as Hex }; });
    const input = execute(BATCH_MODE, aligned);
    assert.ok(input.endsWith(code), 'the transaction ends with the code');
    assert.deepEqual(bindLoanTransactionV1({ execution: record, transaction: own(input), receipt: ownReceipt() }), { state: 'matched', logs: [OWN_EFFECT], operationNonce: null });
    // One zero more than ends the call on a word is not the approved call.
    const long = aligned.map((call, i) => i ? call : { ...call, data: call.data.replace(code, `00${code}`) as Hex });
    assert.equal(bindLoanTransactionV1({ execution: record, transaction: own(execute(BATCH_MODE, long)), receipt: ownReceipt() }).state, 'unknown');
  });
  it('reads one call packed in the single mode, with the Builder Code wherever the wallet put it', () => {
    const call = loanReadyFixture().calls[0]!;
    const packed = `0x${call.to.slice(2)}${BigInt(call.valueWei).toString(16).padStart(64, '0')}${call.data.slice(2)}`.toLowerCase() as Hex;
    const single = encodeFunctionData({ abi: DELEGATED_ABI, functionName: 'execute', args: [SINGLE_MODE, packed] });
    assert.deepEqual(delegatedAccountCallsV1(single), [{ to: call.to.toLowerCase(), value: BigInt(call.valueWei), data: call.data.toLowerCase() }]);
    assert.deepEqual(delegatedAccountCallsV1(attributed(single)), delegatedAccountCallsV1(single));
    assert.equal(delegatedAccountCallsV1('0x12345678'), null);
    assert.equal(delegatedAccountCallsV1(batch()), null, 'Coinbase’s shape is read by its own decoder');
  });
  it('is found by the wallet’s own count after the review when only the wallet can name its handle, and confirmed', async () => {
    const { store, record } = await setup(); const asked: Array<[string, bigint]> = [];
    const result = await refreshLoanExecutionV1(input(record), deps(store, { getTransaction: async () => own(execute()), getTransactionReceipt: async () => ownReceipt(),
      findOwnTransactionsAfter: async (address, afterBlock) => { asked.push([address, afterBlock]); return [TX]; } }));
    assert.equal(result!.state, 'confirmed'); assert.equal(result!.transactionHash, TX);
    assert.deepEqual(asked, [[WALLET, BigInt(record.run.measured.blockNumber)]]);
  });
  it('leaves it sent when the wallet’s later transaction is another one, or nothing landed yet', async () => {
    const { store, record } = await setup();
    const other = await refreshLoanExecutionV1(input(record), deps(store, { getTransaction: async () => ({ from: WALLET, to: OTHER, value: 0n, input: '0x' }),
      getTransactionReceipt: async () => ownReceipt(), findOwnTransactionsAfter: async () => [TX] }));
    assert.equal(other!.state, 'submitted'); assert.equal(other!.transactionHash, null); assert.equal(other!.errorCode, null);
    const none = await refreshLoanExecutionV1(input(record), deps(store, { getTransaction: async () => null, getTransactionReceipt: async () => null, findOwnTransactionsAfter: async () => [] }));
    assert.equal(none!.state, 'submitted');
  });
});
