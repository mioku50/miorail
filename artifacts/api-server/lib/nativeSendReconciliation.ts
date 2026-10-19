import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import {
  ENTRY_POINT_ADDRESSES_V1,
  USER_OPERATION_EVENT_TOPIC_V1,
  type VerifiedReceiptSourceV1,
} from '@mioagent/route-proof';
import { stripErc8021SuffixV1, userOperationCallsV1 } from './sponsoredGas.js';
import type { BaseTransactionSourceV1 } from './baseReceiptReader.js';

// ---------------------------------------------------------------------------
// An ETH send, read back from the chain.
//
// A USDC send is matched to its Transfer event. ETH has no token contract and
// emits no event, so the transfer is read from what the wallet asked for. A
// smart account's operation reaches the chain inside a bundler's `handleOps`,
// and its calldata names every call: target, value, data. The EntryPoint's
// UserOperationEvent for the same sender and nonce says whether it ran, since
// a bundle succeeds even when one of its operations fails. A wallet that sends
// its own transaction is read from the transaction itself.
//
// A shape this does not read is `unavailable`, never a mismatch: failing to
// read a bundle is not evidence that the money went elsewhere.
// ---------------------------------------------------------------------------

const HANDLE_OPS_ABI_V1 = parseAbi([
  // EntryPoint v0.6, the one Base Account's wallet runs on.
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, uint256 callGasLimit, uint256 verificationGasLimit, uint256 preVerificationGas, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  // EntryPoint v0.7 and v0.8 pack the gas fields.
  'function handleOps((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
]);

export type NativeSendCheckV1 =
  | { state: 'matched'; errorCode: null }
  | { state: 'mismatched'; errorCode: 'base_mcp_transaction_reverted' | 'base_mcp_operation_failed' | 'base_mcp_transfer_facts_mismatch' }
  | { state: 'unavailable'; errorCode: 'base_mcp_operation_unreadable' | 'base_mcp_operation_event_missing' };

interface BundledOperationV1 {
  sender: string;
  nonce: bigint;
  callData: string;
}

function bundledOperationsV1(input: string): BundledOperationV1[] | null {
  try {
    const decoded = decodeFunctionData({ abi: HANDLE_OPS_ABI_V1, data: stripErc8021SuffixV1(input) as Hex });
    return decoded.args[0].map((op) => ({ sender: op.sender.toLowerCase(), nonce: op.nonce, callData: op.callData }));
  } catch {
    return null;
  }
}

function topicAddressV1(topic: string | undefined): string | null {
  return topic && /^0x[0-9a-fA-F]{64}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;
}

function dataWordV1(data: string, index: number): bigint | null {
  const word = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? BigInt(`0x${word}`) : null;
}

/** Whether the operation ran: its own event, from the EntryPoint the bundle
 * called, for this sender and nonce. Null when there is none. */
function operationSucceededV1(
  receipt: VerifiedReceiptSourceV1,
  entryPoint: string,
  sender: string,
  nonce: bigint,
): boolean | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== entryPoint) continue;
    if (log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC_V1) continue;
    if (topicAddressV1(log.topics[2]) !== sender) continue;
    // Data words: nonce, success, actualGasCost, actualGasUsed.
    if (dataWordV1(log.data, 0) !== nonce) continue;
    const success = dataWordV1(log.data, 1);
    if (success === null) continue;
    return success === 1n;
  }
  return null;
}

export function nativeSendCheckV1(input: {
  walletAddress: string;
  recipient: string;
  amountWei: bigint;
  transaction: BaseTransactionSourceV1;
  receipt: VerifiedReceiptSourceV1;
}): NativeSendCheckV1 {
  const wallet = input.walletAddress.toLowerCase();
  const recipient = input.recipient.toLowerCase();
  const { transaction, receipt } = input;
  if (receipt.status !== 'success') return { state: 'mismatched', errorCode: 'base_mcp_transaction_reverted' };

  const to = transaction.to?.toLowerCase() ?? null;
  if (transaction.from.toLowerCase() === wallet) {
    // A call to itself is a delegated account's batch, which this does not read.
    if (to === wallet) return { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' };
    const plain = to === recipient && transaction.value === input.amountWei && stripErc8021SuffixV1(transaction.input) === '0x';
    return plain ? { state: 'matched', errorCode: null } : { state: 'mismatched', errorCode: 'base_mcp_transfer_facts_mismatch' };
  }

  if (!to || !ENTRY_POINT_ADDRESSES_V1.has(to)) return { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' };
  const operations = bundledOperationsV1(transaction.input);
  if (!operations) return { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' };
  const own = operations.filter((operation) => operation.sender === wallet);
  if (own.length === 0) return { state: 'mismatched', errorCode: 'base_mcp_transfer_facts_mismatch' };

  let unreadable = false;
  for (const operation of own) {
    const calls = userOperationCallsV1(operation.callData);
    if (!calls) {
      unreadable = true;
      continue;
    }
    // Exactly once: an operation that sent the amount twice did not do what
    // was approved either.
    const transfers = calls.filter((call) => call.to === recipient && BigInt(call.value) === input.amountWei && call.data === '0x');
    if (transfers.length !== 1) continue;
    const succeeded = operationSucceededV1(receipt, to, wallet, operation.nonce);
    if (succeeded === null) return { state: 'unavailable', errorCode: 'base_mcp_operation_event_missing' };
    return succeeded ? { state: 'matched', errorCode: null } : { state: 'mismatched', errorCode: 'base_mcp_operation_failed' };
  }
  return unreadable
    ? { state: 'unavailable', errorCode: 'base_mcp_operation_unreadable' }
    : { state: 'mismatched', errorCode: 'base_mcp_transfer_facts_mismatch' };
}
