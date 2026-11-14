import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { hashApprovedCallsV1, stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { ENTRY_POINT_ADDRESSES_V1, USER_OPERATION_EVENT_TOPIC_V1, type VerifiedReceiptLogV1, type VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { sameCallDataV1, stripErc8021SuffixV1, userOperationCallsV1 } from './sponsoredGas.js';
import { createViemBaseReceiptReader, type BaseChainReaderV1, type BaseTransactionSourceV1 } from './baseReceiptReader.js';
import { readBaseWalletBatchHashesV1 } from './stockExecutionStatus.js';
import { LOAN_WALLET_SENT_NOTHING_V1, loanExecutionRuntimeV1, settledFingerprintV1, type LoanExecutionStoreV1, type LoanExecutionV1, type LoanOwnerV1 } from './loanExecutionStore.js';
import { LOAN_WALLET_SEARCH_LIMIT_V1, bindLoanStepV1, refreshSequentialLoanExecutionV1, sequentialHashesV1 } from './lendingSteps.js';

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


// ---------------------------------------------------------------------------
// What Base shows of an attempt since a block, transaction by transaction
// (audit LL-2, 2026-11-14). A count that moved said only that the wallet sent
// something; a release then refused for ever, though the swap or the repayment
// made on the protocol's own site was not this review. Each later transaction
// or operation is read and bound against the attempt's own calls instead.
// ---------------------------------------------------------------------------
/** The most later transactions or operations of the wallet one search reads one by one. */
export const LOAN_RELEASE_SEARCH_LIMIT_V1 = LOAN_WALLET_SEARCH_LIMIT_V1;
type ReadV1<T> = T | 'unread';
async function readBoth(reader: BaseChainReaderV1, hash: HashV1) {
  try {
    const [receipt, transaction] = await Promise.all([reader.getTransactionReceipt(hash), reader.getTransaction(hash)]);
    return receipt && transaction && receipt.transactionHash.toLowerCase() === hash ? { receipt, transaction } : null;
  } catch { return null; }
}
/** Whether a landed transaction is this attempt's: its batch, or, for a loan in steps, step `index`. */
async function carriesAttemptV1(record: LoanExecutionV1, hash: HashV1, reader: BaseChainReaderV1, stepIndex: number | null): Promise<ReadV1<boolean>> {
  const read = await readBoth(reader, hash);
  if (!read) return 'unread';
  if (stepIndex !== null) return bindLoanStepV1({ execution: record, index: stepIndex, transaction: read.transaction, receipt: read.receipt }).state !== 'unknown';
  return bindLoanTransactionV1({ execution: record, receipt: read.receipt, transaction: read.transaction }).state !== 'unknown';
}

/** What Base shows of an attempt since a block: one of the wallet's transactions carries it (`found`);
 * none of them does (`nothing`, with what the reading was, for a second one to equal); there were more than
 * Still reads (`busy`); or it cannot be said. For a loan in steps the transaction looked for is step
 * `stepIndex`; for a batch, the batch. */
export async function attemptOnBaseSinceV1(record: LoanExecutionV1, reader: BaseChainReaderV1, input: { afterBlock: bigint; stepIndex: number | null; exclude?: ReadonlySet<string> }):
  Promise<{ state: 'found'; hash: HashV1 } | { state: 'nothing'; reading: string; proof: Record<string, unknown> } | { state: 'busy' } | { state: 'pending' } | { state: 'unread' }> {
  const unread = { state: 'unread' as const };
  const wallet = record.walletAddress, block = input.afterBlock;
  const kind = reader.getAccountKind ? await reader.getAccountKind(wallet) : null;
  if (kind === null) return unread;
  const others: HashV1[] = [];
  // Each later transaction, read and bound against this attempt's own calls.
  const sift = async (listed: { hashes: HashV1[]; complete: boolean } | null): Promise<{ state: 'found'; hash: HashV1 } | { state: 'busy' } | { state: 'unread' } | null> => {
    if (!listed) return unread;
    for (const hash of listed.hashes) {
      // A transaction already recorded for another attempt of this wallet is that attempt's, even with the same calls (audit LL-1).
      if (others.includes(hash)) continue;
      if (input.exclude?.has(hash)) { others.push(hash); continue; }
      const carries = await carriesAttemptV1(record, hash, reader, input.stepIndex);
      if (carries === 'unread') return unread;
      if (carries) return { state: 'found', hash };
      others.push(hash);
    }
    if (!listed.complete) return listed.hashes.length >= LOAN_RELEASE_SEARCH_LIMIT_V1 ? { state: 'busy' } : unread;
    return null;
  };
  if (kind === 'contract') {
    if (!reader.getEntryPointNonce || !reader.listOwnOperationsAfter) return unread;
    const nonces: Array<{ entryPoint: string; nonce: string; nonceNow: string }> = [];
    for (const entryPoint of ENTRY_POINT_ADDRESSES_V1) {
      const [then, now] = await Promise.all([reader.getEntryPointNonce(entryPoint, wallet, block), reader.getEntryPointNonce(entryPoint, wallet, 'latest')]);
      if (then === null || now === null || now < then) return unread;
      if (now > then) {
        const settled = await sift(await reader.listOwnOperationsAfter(entryPoint, wallet, block, LOAN_RELEASE_SEARCH_LIMIT_V1));
        if (settled) return settled;
      }
      nonces.push({ entryPoint, nonce: then.toString(), nonceNow: now.toString() });
    }
    return { state: 'nothing', reading: nonces.map(row => `${row.entryPoint}:${row.nonceNow}`).join('|'),
      proof: { account: kind, operationNonces: nonces.map(({ entryPoint, nonce }) => ({ entryPoint, nonce })),
        ...(nonces.some(row => row.nonceNow !== row.nonce) ? { operationNoncesNow: nonces.map(({ entryPoint, nonceNow }) => ({ entryPoint, nonce: nonceNow })) } : {}),
        ...(others.length ? { otherTransactions: others } : {}) } };
  }
  if (!reader.getTransactionCountAt || !reader.getTransactionCount) return unread;
  const [then, latest, pending] = await Promise.all([reader.getTransactionCountAt(wallet, block), reader.getTransactionCount(wallet, 'latest'), reader.getTransactionCount(wallet, 'pending')]);
  if (then === null || latest === null || pending === null || latest < then || pending < latest) return unread;
  // A node that does hold a pending transaction of this wallet says so; since Denim most answer with the
  // latest block, which is why a second reading follows a minute later.
  if (pending > latest) return { state: 'pending' };
  if (latest > then) {
    if (!reader.listOwnTransactionsAfter) return unread;
    const settled = await sift(await reader.listOwnTransactionsAfter(wallet, block, LOAN_RELEASE_SEARCH_LIMIT_V1));
    if (settled) return settled;
  }
  return { state: 'nothing', reading: `count:${latest}`,
    proof: { account: kind, transactionCount: then, ...(latest !== then ? { transactionCountNow: latest } : {}), ...(others.length ? { otherTransactions: others } : {}) } };
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
/** A released attempt is still read from Base this long after its release (audit LL-1). */
export const LOAN_RELEASED_WATCH_MS_V1 = 24 * 60 * 60_000;

/** The transactions already recorded for this wallet's other attempts in the same market: theirs, even
 * when their calls are the same as this one's (audit LL-1). */
async function takenByOthersV1(store: LoanExecutionStoreV1, input: { owner: LoanOwnerV1; executionId: string }): Promise<Set<string>> {
  const [landed, active] = await Promise.all([store.listLandedInScope(input), store.listActiveInScope(input)]);
  return new Set([...landed, ...active].flatMap(row => [...(row.transactionHash ? [row.transactionHash] : []),
    ...(row.run.delivery === 'sequential' && row.batchId ? sequentialHashesV1(row.batchId) ?? [] : [])]));
}

/**
 * A review its owner released as never sent, whose wallet sent it after all: a request left open in the
 * wallet and confirmed later, or a transaction stuck on its way that landed (audit LL-1, 2026-11-14). The
 * release made the record final, and nothing read it again, so the loan stood on Base while Still said it
 * was not sent, and a second loan could be armed on a position without it. For a day after the release it
 * is read from Base like any other attempt: the wallet's own service where it named the batch, else the
 * wallet's transactions or operations since the review, each bound against the review's own calls. The
 * transaction found is read by the ordinary binding below, and a loan or repayment it proves is recorded
 * as what it is.
 */
async function releasedLandedAfterAllV1(record: LoanExecutionV1, input: { owner: LoanOwnerV1; executionId: string }, deps: LoanExecutionStatusDepsV1): Promise<HashV1 | null> {
  const releasedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(releasedAt) || deps.now().getTime() - releasedAt > LOAN_RELEASED_WATCH_MS_V1) return null;
  try {
    const exclude = await takenByOthersV1(deps.store, input);
    const sequential = record.run.delivery === 'sequential';
    if (record.batchId && !sequential) {
      const named = (await deps.readBatchHashes(record.batchId).catch(() => null))?.filter(value => hash(value) && !exclude.has(value)) ?? [];
      if (named.length === 1) return named[0]!;
    }
    const found = await attemptOnBaseSinceV1(record, deps.reader, { afterBlock: BigInt(record.run.measured.blockNumber), stepIndex: sequential ? 0 : null, exclude });
    return found.state === 'found' ? found.hash : null;
  } catch { return null; }
}

export async function refreshLoanExecutionV1(input: { owner: LoanOwnerV1; executionId: string; refresh: boolean }, deps: LoanExecutionStatusDepsV1): Promise<LoanExecutionV1 | null> {
  const stored = await deps.store.get(input);
  if (!stored || !input.refresh || stored.state === 'ready' || stored.errorCode === 'conflicting_batch_hints') return stored;
  // Released by its owner as never sent (lib/loanRelease.ts): no transaction is on record, and a reading that
  // finds none must not hold the market again. One that landed after all is found and read (audit LL-1).
  let record = stored, late: HashV1 | null = null;
  if (stored.state === 'failed' && stored.errorCode === LOAN_WALLET_SENT_NOTHING_V1) {
    late = await releasedLandedAfterAllV1(stored, input, deps);
    if (!late) return stored;
    record = { ...stored, transactionHash: late };
  }
  // A loan in steps is read step by step, and not while its steps are still being sent.
  if (record.run.delivery === 'sequential') {
    const read = await refreshSequentialLoanExecutionV1(input, record, deps);
    // A released one whose late step could not be written (another attempt holds the market) stays released.
    return late && read.errorCode === 'loan_execution_changed_while_reading' ? stored : read;
  }
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
    return next ?? (late ? stored : { ...record, state: 'unknown' as const, errorCode: 'loan_execution_changed_while_reading' });
  };
  let hints = record.transactionHash ? [record.transactionHash] : record.batchId ? await deps.readBatchHashes(record.batchId) : null;
  // A batch the wallet sent as its own transaction has a handle only that wallet can name (MetaMask,
  // 2026-11-09: a loan landed in 12 s and stayed "sent", and held its market against the repayment). It
  // is found by the account's own transaction count after the review, and bound like any other.
  let ownSearch = false;
  if (!hints?.length && record.batchId && deps.reader.findOwnTransactionsAfter) {
    hints = await deps.reader.findOwnTransactionsAfter(record.walletAddress, BigInt(record.run.measured.blockNumber)).catch(() => null);
    ownSearch = true;
    // The account's transactions include its other attempts': one already recorded for another is that one's,
    // even with the same calls, so two loans of the same amount do not hold each other for ever (audit LL-1).
    if (hints?.length) {
      const taken = await takenByOthersV1(deps.store, input).catch(() => null);
      hints = taken ? hints.filter(value => !taken.has(value)) : null;
    }
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
  // A released attempt is written again only from a transaction Base proves is its own (audit LL-1).
  if (late && candidates.length !== 1) return stored;
  if (candidates.length !== 1) return set('unknown', record.transactionHash, null, candidates.length > 1 ? 'loan_multiple_matching_transactions' : 'loan_receipt_not_matched');
  const candidate = candidates[0]!;
  const baseProof = { receiptFingerprint: receiptFingerprintV1(candidate.receipt), blockNumber: candidate.receipt.blockNumber.toString(), callsHash: record.run.callsHash };
  if (candidate.binding.state === 'failed') return set('failed', candidate.hash, baseProof, candidate.binding.errorCode);
  let effect: Awaited<ReturnType<LoanEffectPositionCheckV1>>;
  try { effect = await deps.verifyEffectPosition({ execution: record, transaction: candidate.transaction, receipt: candidate.receipt,
    logs: candidate.binding.logs, operationNonce: candidate.binding.operationNonce }); }
  catch { return late ? stored : set('unknown', candidate.hash, null, 'loan_effect_read_unavailable'); }
  // Unread just now, a released one stays as it is and is read again; one that did something else than its
  // review holds its market as unknown, as any other would.
  if (effect.state !== 'matched') return late && effect.state === 'unavailable' ? stored : set('unknown', candidate.hash, null, effect.errorCode);
  return set('confirmed', candidate.hash, { ...baseProof, operationNonce: candidate.binding.operationNonce, effect: effect.proof }, null);
}

/** A confirmed loan or repayment whose position, at its receipt's block, was moved by another hand too: a
 * liquidation, a repayment or pledge someone made for the wallet, or the person's own action in the
 * protocol's app (audit LM-1). The receipt proves the action; the position is said as it is. */
export function loanPositionMovedOutsideV1(record: Pick<LoanExecutionV1, 'state' | 'verification'>): boolean {
  const outside = (record.verification?.effect as { outside?: unknown } | undefined)?.outside;
  return record.state === 'confirmed' && outside !== null && typeof outside === 'object' && Object.keys(outside).length > 0;
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
