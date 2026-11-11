import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { hashApprovedCallsV1, stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { ENTRY_POINT_ADDRESSES_V1, USER_OPERATION_EVENT_TOPIC_V1, type VerifiedReceiptLogV1, type VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { sameCallDataV1, stripErc8021SuffixV1, userOperationCallsV1 } from './sponsoredGas.js';
import { createViemBaseReceiptReader, type BaseChainReaderV1, type BaseTransactionSourceV1 } from './baseReceiptReader.js';
import { readBaseWalletBatchHashesV1 } from './stockExecutionStatus.js';
import { LOAN_WALLET_SENT_NOTHING_V1, loanExecutionRuntimeV1, settledFingerprintV1, type LoanExecutionStoreV1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';
import { refreshSequentialLoanExecutionV1 } from './lendingSteps.js';

const HANDLE_OPS_ABI = parseAbi([
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
]);
const BEFORE_EXECUTION_TOPIC = keccak256(stringToHex('BeforeExecution()'));
// ERC-7579 / ERC-7821 `execute(bytes32 mode, bytes executionData)`: what an EIP-7702 account runs when
// the wallet sends a batch as its own transaction, to itself (MetaMask's EIP7702StatelessDeleGator,
// 2026-11-09).
const DELEGATED_EXECUTE_ABI = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const EXECUTIONS_V1 = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;
// Only the default execution type, which reverts the whole transaction when any call fails, so a
// successful receipt means every call ran. "Try" (0x01), delegatecall (0xff) and any mode with a
// selector or payload are not what Still approved.
const SINGLE_DEFAULT_MODE_V1 = `0x00${'0'.repeat(62)}`, BATCH_DEFAULT_MODE_V1 = `0x01${'0'.repeat(62)}`;

/** The calls an EIP-7702 account's `execute` runs, each call's data as sent (its own code kept, for
 * `sameCallDataV1`), or null for anything else. */
export function delegatedAccountCallsV1(input: string): { to: string; value: bigint; data: string }[] | null {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]*$/.test(input)) return null;
  // As sent first: the last call's own code may be the end of the whole input (attributedCallsV1), and
  // cutting it there would cut that call. Then without a code a wallet appended to the whole input.
  return delegatedCallsOfV1(input) ?? delegatedCallsOfV1(stripErc8021SuffixV1(input));
}
function delegatedCallsOfV1(input: string): { to: string; value: bigint; data: string }[] | null {
  try {
    const decoded = decodeFunctionData({ abi: DELEGATED_EXECUTE_ABI, data: input as Hex });
    const mode = decoded.args[0].toLowerCase(), data = decoded.args[1].toLowerCase();
    if (mode === BATCH_DEFAULT_MODE_V1) {
      const [executions] = decodeAbiParameters(EXECUTIONS_V1, data as Hex);
      return executions.map(call => ({ to: call.target.toLowerCase(), value: call.value, data: call.callData.toLowerCase() }));
    }
    // One call is packed: the target's 20 bytes, the value's 32, then the calldata.
    if (mode === SINGLE_DEFAULT_MODE_V1 && data.length >= 2 + 104) {
      return [{ to: `0x${data.slice(2, 42)}`, value: BigInt(`0x${data.slice(42, 106)}`), data: `0x${data.slice(106)}` }];
    }
    return null;
  } catch { return null; }
}
const hash = (value: string): value is HashV1 => /^0x[0-9a-f]{64}$/.test(value);
export type LoanTransactionBindingV1 =
  | { state: 'matched'; logs: readonly VerifiedReceiptLogV1[]; operationNonce: string | null }
  | { state: 'failed'; errorCode: 'loan_transaction_reverted' | 'loan_operation_reverted' }
  | { state: 'unknown'; errorCode: string };

/** What binding reads of an execution: its wallet and the calls it approved. A Spend payment from the
 * wallet's own USDC is bound the same way (stillSpendWallet). */
export type BindableExecutionV1 = Pick<LoanExecutionV1, 'walletAddress'> & { run: Pick<LoanExecutionV1['run'], 'calls' | 'callsHash'> };
function exactCalls(execution: BindableExecutionV1, actual: readonly { to: string; value: bigint | string; data: string }[]): boolean {
  return execution.run.callsHash === hashApprovedCallsV1(execution.run.calls) && actual.length === execution.run.calls.length &&
    actual.every((call, index) => {
      const expected = execution.run.calls[index]!;
      return call.to.toLowerCase() === expected.to.toLowerCase() &&
        (typeof call.value === 'bigint' || /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i.test(call.value)) && BigInt(call.value) === BigInt(expected.valueWei) &&
        sameCallDataV1(call.data, expected.data);
    });
}
const topicAddress = (topic: string | undefined): string | null => topic && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;

/** A wallet batch handle is only a hint. A real transaction must carry every
 * approved call, exactly once and in order. The operation's own EntryPoint
 * event establishes success; neighbouring operations' logs are excluded. */
export function bindLoanTransactionV1(input: {
  execution: BindableExecutionV1;
  transaction: BaseTransactionSourceV1;
  receipt: VerifiedReceiptSourceV1;
}): LoanTransactionBindingV1 {
  const { execution, transaction, receipt } = input;
  const unknown = (errorCode: string): LoanTransactionBindingV1 => ({ state: 'unknown', errorCode });
  const wallet = execution.walletAddress.toLowerCase(), to = transaction.to?.toLowerCase();
  if (receipt.logs.length > 4096 || receipt.blockNumber < 0n || (receipt.from != null && receipt.from.toLowerCase() !== transaction.from.toLowerCase())) return unknown('loan_receipt_binding_unread');
  if (transaction.from.toLowerCase() === wallet) {
    // To itself: a wallet that sends its own batch through its EIP-7702 delegate, in Coinbase's smart
    // wallet shape or the standard `execute(bytes32, bytes)` MetaMask's delegate runs.
    const calls = to === wallet ? userOperationCallsV1(transaction.input, { keepCallCodes: true }) ?? delegatedAccountCallsV1(transaction.input)
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
    const calls = userOperationCallsV1(op.callData, { keepCallCodes: true }); return calls && exactCalls(execution, calls);
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

export function receiptFingerprintV1(receipt: VerifiedReceiptSourceV1): string {
  return stableHashV1('loan-receipt/v1', { transactionHash: receipt.transactionHash.toLowerCase(), blockNumber: receipt.blockNumber.toString(),
    status: receipt.status, logs: receipt.logs.map(log => ({ address: log.address.toLowerCase(), topics: log.topics.map(topic => topic.toLowerCase()), data: log.data.toLowerCase() })) });
}

/** This function is read-only with respect to wallets and chain. It updates
 * only the owned record from independent chain evidence. Neither an SDK status
 * nor a borrowed amount supplied by the browser can produce confirmed. */
export async function refreshLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string; refresh: boolean }, deps: LoanExecutionStatusDepsV1): Promise<LoanExecutionV1 | null> {
  const record = await deps.store.get(input);
  if (!record || !input.refresh || record.state === 'ready' || record.errorCode === 'conflicting_batch_hints') return record;
  // Released by its owner as never sent (lib/loanRelease.ts): there is no transaction to read, and a
  // reading that finds none must not hold the market again. One that landed after all comes back by its hash.
  if (record.state === 'failed' && record.errorCode === LOAN_WALLET_SENT_NOTHING_V1) return record;
  // A loan in steps is read step by step, and not while its steps are still being sent.
  if (record.run.delivery === 'sequential') return refreshSequentialLoanExecutionV1(input, record, deps);
  // A result already read from Base is not read into doubt (audit LEND-4, 2026-11-10). Every view read a
  // confirmed loan again from nothing, and one answer the RPC did not give turned it back into "unknown",
  // which holds its market against the repayment. The receipt is the evidence, and its fingerprint is kept:
  // only a receipt that reads differently now unsettles the result. One that cannot be read changes nothing.
  const settled = settledFingerprintV1(record);
  if (settled) {
    let receipt: VerifiedReceiptSourceV1 | null;
    try { receipt = await deps.reader.getTransactionReceipt(settled.hash); } catch { return record; }
    if (!receipt || receipt.transactionHash.toLowerCase() !== settled.hash || receiptFingerprintV1(receipt) === settled.fingerprint) return record;
    return await deps.store.recordVerification({ ...input, expectedVersion: record.version, state: 'unknown', transactionHash: settled.hash, proof: null,
      errorCode: 'loan_receipt_changed', now: deps.now() }) ?? record;
  }
  if (record.state === 'awaiting_wallet' && !record.batchId) return record;
  const set = async (state: 'confirmed' | 'failed' | 'unknown', transactionHash: HashV1 | null, proof: Record<string, unknown> | null, errorCode: string | null) => {
    const next = await deps.store.recordVerification({ ...input, expectedVersion: record.version, state, transactionHash, proof, errorCode, now: deps.now() });
    // A conflicting concurrent update must never cause a stale confirmed view.
    return next ?? { ...record, state: 'unknown' as const, errorCode: 'loan_execution_changed_while_reading' };
  };
  let hints = record.transactionHash ? [record.transactionHash] : record.batchId ? await deps.readBatchHashes(record.batchId) : null;
  // A batch the wallet sent as its own transaction has a handle only that wallet can name (MetaMask,
  // 2026-11-09: a loan landed in 12 s and stayed "sent", and held its market against the repayment). It
  // is found by the account's own transaction count after the review, and bound like any other.
  let ownSearch = false;
  if (!hints?.length && record.batchId && deps.reader.findOwnTransactionsAfter) {
    hints = await deps.reader.findOwnTransactionsAfter(record.walletAddress, BigInt(record.run.measured.blockNumber)).catch(() => null);
    ownSearch = true;
  }
  if (!hints?.length || hints.length > 16 || hints.some(value => !hash(value))) {
    return record.state === 'confirmed' || record.state === 'failed' ? set('unknown', record.transactionHash, null, 'loan_receipt_unavailable') : record;
  }
  const candidates: Array<{ hash: HashV1; receipt: VerifiedReceiptSourceV1; transaction: BaseTransactionSourceV1; binding: Exclude<LoanTransactionBindingV1, { state: 'unknown' }> }> = [];
  for (const txHash of [...new Set(hints)]) {
    let receipt: VerifiedReceiptSourceV1 | null, transaction: BaseTransactionSourceV1 | null;
    try { [receipt, transaction] = await Promise.all([deps.reader.getTransactionReceipt(txHash), deps.reader.getTransaction(txHash)]); }
    catch { continue; }
    if (!receipt || !transaction || receipt.transactionHash.toLowerCase() !== txHash) continue;
    const fingerprint = receiptFingerprintV1(receipt);
    if (record.transactionHash === txHash && record.verification?.receiptFingerprint && record.verification.receiptFingerprint !== fingerprint) return set('unknown', txHash, null, 'loan_receipt_changed');
    const binding = bindLoanTransactionV1({ execution: record, receipt, transaction });
    if (binding.state !== 'unknown') candidates.push({ hash: txHash, receipt, transaction, binding });
  }
  // The account's later transactions that are not this batch say nothing about it: it may not have landed yet.
  if (ownSearch && candidates.length === 0) return record;
  if (candidates.length !== 1) return set('unknown', record.transactionHash, null, candidates.length > 1 ? 'loan_multiple_matching_transactions' : 'loan_receipt_not_matched');
  const candidate = candidates[0]!;
  const baseProof = { receiptFingerprint: receiptFingerprintV1(candidate.receipt), blockNumber: candidate.receipt.blockNumber.toString(), callsHash: record.run.callsHash };
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

// ---------------------------------------------------------------------------
// A review is true of the block it was read at (audit LEND-3, 2026-11-10).
//
// Still's own limit is checked when a review is prepared. Two reviews prepared
// together (two tabs, or the assistant's card beside the page), each for all
// the room there was, could both be sent: the first landed, stopped holding
// the market, and the second, still inside its thirty seconds, was armed on
// numbers the first had just made untrue. The debt then stood at twice what
// either review showed.
//
// So a new loan is not armed when another attempt of the same wallet in the
// same market (on Aave V4, its whole spoke) landed a transaction after the
// block this review was read at. The page prepares the review again, on the
// position as it is now. A repayment is never refused this way: paying back
// is right whatever else landed, and the chain bounds it.
// ---------------------------------------------------------------------------
export function positionMovedSinceReviewV1(review: LoanExecutionV1, landed: readonly LoanExecutionV1[]): boolean {
  let reviewBlock: bigint;
  try { reviewBlock = BigInt(review.run.measured.blockNumber); } catch { return true; }
  return landed.some((other) => {
    if (other.executionId === review.executionId || other.transactionHash === null || (other.state !== 'confirmed' && other.state !== 'failed')) return false;
    const block = other.verification?.blockNumber;
    if (typeof block === 'string' && /^[1-9][0-9]{0,18}$/.test(block)) return BigInt(block) > reviewBlock;
    // An older record of a loan stopped part way names no block: by when it was last written instead.
    return Date.parse(other.updatedAt) > Date.parse(review.createdAt);
  });
}
