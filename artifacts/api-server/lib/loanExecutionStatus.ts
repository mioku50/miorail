import { decodeFunctionData, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { hashApprovedCallsV1, stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { ENTRY_POINT_ADDRESSES_V1, USER_OPERATION_EVENT_TOPIC_V1, type VerifiedReceiptLogV1, type VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { stripErc8021SuffixV1, userOperationCallsV1 } from './sponsoredGas.js';
import { createViemBaseReceiptReader, type BaseChainReaderV1, type BaseTransactionSourceV1 } from './baseReceiptReader.js';
import { readBaseWalletBatchHashesV1 } from './stockExecutionStatus.js';
import { loanExecutionRuntimeV1, type LoanExecutionStoreV1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';

const HANDLE_OPS_ABI = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
]);
const BEFORE_EXECUTION_TOPIC = keccak256(stringToHex('BeforeExecution()'));
const hash = (value: string): value is HashV1 => /^0x[0-9a-f]{64}$/.test(value);
export type LoanTransactionBindingV1 =
  | { state: 'matched'; logs: readonly VerifiedReceiptLogV1[]; operationNonce: string | null }
  | { state: 'failed'; errorCode: 'loan_transaction_reverted' | 'loan_operation_reverted' }
  | { state: 'unknown'; errorCode: string };

function exactCalls(execution: LoanExecutionV1, actual: readonly { to: string; value: bigint | string; data: string }[]): boolean {
  return execution.run.callsHash === hashApprovedCallsV1(execution.run.calls) && actual.length === execution.run.calls.length &&
    actual.every((call, index) => {
      const expected = execution.run.calls[index]!;
      return call.to.toLowerCase() === expected.to.toLowerCase() &&
        (typeof call.value === 'bigint' || /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(call.value)) && BigInt(call.value) === BigInt(expected.valueWei) &&
        stripErc8021SuffixV1(call.data) === stripErc8021SuffixV1(expected.data);
    });
}
const topicAddress = (topic: string | undefined): string | null => topic && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;

/** A wallet batch handle is only a hint. A real transaction must carry every
 * approved call, exactly once and in order. The operation's own EntryPoint
 * event establishes success; neighbouring operations' logs are excluded. */
export function bindLoanTransactionV1(input: {
  execution: LoanExecutionV1;
  transaction: BaseTransactionSourceV1;
  receipt: VerifiedReceiptSourceV1;
}): LoanTransactionBindingV1 {
  const { execution, transaction, receipt } = input;
  const unknown = (errorCode: string): LoanTransactionBindingV1 => ({ state: 'unknown', errorCode });
  const wallet = execution.walletAddress.toLowerCase(), to = transaction.to?.toLowerCase();
  if (receipt.logs.length > 4096 || receipt.blockNumber < 0n || (receipt.from != null && receipt.from.toLowerCase() !== transaction.from.toLowerCase())) return unknown('loan_receipt_binding_unread');
  if (transaction.from.toLowerCase() === wallet) {
    const calls = to === wallet ? userOperationCallsV1(transaction.input)
      : to ? [{ to, value: transaction.value, data: transaction.input }] : null;
    if (!calls || !exactCalls(execution, calls)) return unknown('loan_calls_not_matched');
    return receipt.status === 'success' ? { state: 'matched', logs: receipt.logs, operationNonce: null }
      : { state: 'failed', errorCode: 'loan_transaction_reverted' };
  }
  if (!to || !ENTRY_POINT_ADDRESSES_V1.has(to) || transaction.value !== 0n) return unknown('loan_operation_unreadable');
  let operations: readonly { sender: string; nonce: bigint; callData: string }[];
  try {
    const decoded = decodeFunctionData({ abi: HANDLE_OPS_ABI, data: stripErc8021SuffixV1(transaction.input) as Hex });
    operations = decoded.args[0];
  } catch { return unknown('loan_operation_unreadable'); }
  const matching = operations.filter(op => op.sender.toLowerCase() === wallet && (() => {
    const calls = userOperationCallsV1(op.callData); return calls && exactCalls(execution, calls);
  })());
  if (matching.length !== 1) return unknown('loan_calls_not_matched');
  if (receipt.status !== 'success') return { state: 'failed', errorCode: 'loan_transaction_reverted' };
  const operation = matching[0]!;
  const ownEvents = receipt.logs.flatMap((log, index) => {
    if (log.address.toLowerCase() !== to || log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC_V1 ||
        log.topics.length !== 4 || topicAddress(log.topics[2]) !== wallet || !/^0x[0-9a-fA-F]{256}$/.test(log.data)) return [];
    if (BigInt(`0x${log.data.slice(2, 66)}`) !== operation.nonce) return [];
    const success = BigInt(`0x${log.data.slice(66, 130)}`);
    return success === 0n || success === 1n ? [{ index, success }] : [];
  });
  if (ownEvents.length !== 1) return unknown('loan_operation_event_missing');
  const event = ownEvents[0]!;
  if (event.success === 0n) return { state: 'failed', errorCode: 'loan_operation_reverted' };
  let start = -1;
  for (let i = event.index - 1; i >= 0; i--) {
    const log = receipt.logs[i]!;
    if (log.address.toLowerCase() === to && [USER_OPERATION_EVENT_TOPIC_V1, BEFORE_EXECUTION_TOPIC].includes(log.topics[0]?.toLowerCase() ?? '')) { start = i; break; }
  }
  if (start < 0) return unknown('loan_operation_boundary_missing');
  return { state: 'matched', logs: receipt.logs.slice(start + 1, event.index), operationNonce: operation.nonce.toString() };
}

export type LoanEffectPositionCheckV1 = (input: {
  execution: LoanExecutionV1;
  receipt: VerifiedReceiptSourceV1;
  transaction: BaseTransactionSourceV1;
  logs: readonly VerifiedReceiptLogV1[];
  operationNonce: string | null;
}) => Promise<{ state: 'matched'; proof: Record<string, unknown> } | { state: 'mismatched' | 'unavailable'; errorCode: string }>;
export interface LoanExecutionStatusDepsV1 {
  store: LoanExecutionStoreV1;
  reader: BaseChainReaderV1;
  readBatchHashes: (batchId: string) => Promise<HashV1[] | null>;
  verifyEffectPosition: LoanEffectPositionCheckV1;
  now: () => Date;
}

function receiptFingerprint(receipt: VerifiedReceiptSourceV1): string {
  return stableHashV1('loan-receipt/v1', { transactionHash: receipt.transactionHash.toLowerCase(), blockNumber: receipt.blockNumber.toString(),
    status: receipt.status, logs: receipt.logs.map(log => ({ address: log.address.toLowerCase(), topics: log.topics.map(topic => topic.toLowerCase()), data: log.data.toLowerCase() })) });
}

/** This function is read-only with respect to wallets and chain. It updates
 * only the owned record from independent chain evidence. Neither an SDK status
 * nor a borrowed amount supplied by the browser can produce confirmed. */
export async function refreshLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string; refresh: boolean }, deps: LoanExecutionStatusDepsV1): Promise<LoanExecutionV1 | null> {
  const record = await deps.store.get(input);
  if (!record || !input.refresh || record.state === 'ready' || (record.state === 'awaiting_wallet' && !record.batchId) || record.errorCode === 'conflicting_batch_hints') return record;
  const set = async (state: 'confirmed' | 'failed' | 'unknown', transactionHash: HashV1 | null, proof: Record<string, unknown> | null, errorCode: string | null) => {
    const next = await deps.store.recordVerification({ ...input, expectedVersion: record.version, state, transactionHash, proof, errorCode, now: deps.now() });
    // A conflicting concurrent update must never cause a stale confirmed view.
    return next ?? { ...record, state: 'unknown' as const, errorCode: 'loan_execution_changed_while_reading' };
  };
  const hints = record.transactionHash ? [record.transactionHash] : record.batchId ? await deps.readBatchHashes(record.batchId) : null;
  if (!hints?.length || hints.length > 16 || hints.some(value => !hash(value))) {
    return record.state === 'confirmed' || record.state === 'failed' ? set('unknown', record.transactionHash, null, 'loan_receipt_unavailable') : record;
  }
  const candidates: Array<{ hash: HashV1; receipt: VerifiedReceiptSourceV1; transaction: BaseTransactionSourceV1; binding: Exclude<LoanTransactionBindingV1, { state: 'unknown' }> }> = [];
  for (const txHash of [...new Set(hints)]) {
    let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
    try { [receipt, transaction] = await Promise.all([deps.reader.getTransactionReceipt(txHash), deps.reader.getTransaction(txHash)]); }
    catch { continue; }
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== txHash) continue;
    const fingerprint = receiptFingerprint(receipt);
    if (record.transactionHash === txHash && record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== fingerprint) return set('unknown', txHash, null, 'loan_receipt_changed');
    const binding = bindLoanTransactionV1({ execution: record, receipt, transaction });
    if (binding.state !== 'unknown') candidates.push({ hash: txHash, receipt, transaction, binding });
  }
  if (candidates.length !== 1) return set('unknown', record.transactionHash, null, candidates.length > 1 ? 'loan_multiple_matching_transactions' : 'loan_receipt_not_matched');
  const candidate = candidates[0]!;
  const baseProof = { receiptFingerprint: receiptFingerprint(candidate.receipt), blockNumber: candidate.receipt.blockNumber.toString(), callsHash: record.run.callsHash };
  if (candidate.binding.state === 'failed') return set('failed', candidate.hash, baseProof, candidate.binding.errorCode);
  let effect: Awaited<ReturnType<LoanEffectPositionCheckV1>>;
  try { effect = await deps.verifyEffectPosition({ execution: record, transaction: candidate.transaction, receipt: candidate.receipt,
    logs: candidate.binding.logs, operationNonce: candidate.binding.operationNonce }); }
  catch { return set('unknown', candidate.hash, null, 'loan_effect_read_unavailable'); }
  if (effect.state !== 'matched') return set('unknown', candidate.hash, null, effect.errorCode);
  return set('confirmed', candidate.hash, { ...baseProof, operationNonce: candidate.binding.operationNonce, effect: effect.proof }, null);
}

export function loanExecutionWireV1(record: LoanExecutionV1): Record<string, unknown> {
  return { executionId: record.executionId, draftId: record.draftId, state: record.state, attemptId: record.attemptId, batchId: record.batchId,
    transactionHash: record.transactionHash, errorCode: record.errorCode, updatedAt: record.updatedAt };
}

export const loanExecutionStatusRuntimeV1 = {
  async dependencies(verifyEffectPosition: LoanEffectPositionCheckV1): Promise<LoanExecutionStatusDepsV1> {
    return { store: await loanExecutionRuntimeV1.store(), reader: createViemBaseReceiptReader(), readBatchHashes: readBaseWalletBatchHashesV1,
      verifyEffectPosition, now: () => new Date() };
  },
};
