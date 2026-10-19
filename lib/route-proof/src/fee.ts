import type { RouteProofV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptSourceV1 } from './receipts.js';

// ---------------------------------------------------------------------------
// The network fee of the person's OWN operation, and who paid it.
//
// A smart account's operation reaches the chain inside a bundler's
// `handleOps`, and a bundle may carry other people's operations. On
// 2026-10-19 each of the operator's three trades shared one, and the proof
// recorded the bundle's gasUsed (691 569) where the person's own operation
// used 477 132. The EntryPoint states every operation's own gas, cost and
// paymaster in its `UserOperationEvent`: that is what the person paid, or what
// a sponsor paid for them.
// ---------------------------------------------------------------------------

/** EntryPoint v0.6, v0.7 and v0.8. Only their events are believed: any
 * contract can emit a log with the same topic. */
export const ENTRY_POINT_ADDRESSES_V1: ReadonlySet<string> = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
]);

/** `UserOperationEvent(bytes32 indexed userOpHash, address indexed sender,
 * address indexed paymaster, uint256 nonce, bool success,
 * uint256 actualGasCost, uint256 actualGasUsed)`, the same in all three. */
export const USER_OPERATION_EVENT_TOPIC_V1 = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';

export type FeePaidByV1 = NonNullable<RouteProofV1['feePaidBy']>;

export interface ActualFeeV1 {
  actualGas: RouteProofV1['actualGas'];
  /** Null when it cannot be established, never a guess. */
  feePaidBy: FeePaidByV1 | null;
}

interface OperationFeeV1 {
  gasUsed: bigint;
  costWei: bigint | null;
  /** true: a paymaster paid; false: the person did; null: not established. */
  sponsored: boolean | null;
}

export function atomicDecimalFromWeiV1(amount: bigint): string {
  const base = BigInt(10) ** BigInt(18);
  const whole = amount / base;
  const frac = amount % base;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
}

function topicAddressV1(topic: string | undefined): string | null {
  return topic && /^0x[0-9a-fA-F]{64}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;
}

function dataWordV1(data: string, index: number): bigint | null {
  const word = data.slice(2 + index * 64, 2 + (index + 1) * 64);
  return /^[0-9a-fA-F]{64}$/.test(word) ? BigInt(`0x${word}`) : null;
}

/** The person's part of one transaction. */
function operationFeeV1(source: VerifiedReceiptSourceV1, wallet: string): OperationFeeV1 {
  let gasUsed = BigInt(0);
  let costWei = BigInt(0);
  let operations = 0;
  let sponsoredOperations = 0;
  for (const log of source.logs) {
    if (!ENTRY_POINT_ADDRESSES_V1.has(log.address.toLowerCase())) continue;
    if (log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC_V1) continue;
    if (topicAddressV1(log.topics[2]) !== wallet) continue;
    const paymaster = topicAddressV1(log.topics[3]);
    // Data words: nonce, success, actualGasCost, actualGasUsed.
    const cost = dataWordV1(log.data, 2);
    const used = dataWordV1(log.data, 3);
    if (paymaster === null || cost === null || used === null) continue;
    operations += 1;
    gasUsed += used;
    costWei += cost;
    if (!/^0x0{40}$/.test(paymaster)) sponsoredOperations += 1;
  }
  if (operations > 0) {
    return {
      gasUsed,
      costWei,
      sponsored: sponsoredOperations === operations ? true : sponsoredOperations === 0 ? false : null,
    };
  }
  // No operation of this wallet in the receipt. A transaction the wallet sent
  // itself paid its own gas; one somebody else sent says nothing about who
  // paid for the person.
  return {
    gasUsed: source.gasUsed,
    costWei: source.effectiveGasPriceWei === null ? null : source.gasUsed * source.effectiveGasPriceWei,
    sponsored: source.from?.toLowerCase() === wallet ? false : null,
  };
}

/** The person's gas and fee across the proof's transactions, and who paid. */
export function actualFeeV1(
  sources: readonly (VerifiedReceiptSourceV1 | null)[],
  walletAddress: string,
): ActualFeeV1 {
  const verified = sources.filter((source): source is VerifiedReceiptSourceV1 => source !== null);
  if (verified.length === 0) return { actualGas: null, feePaidBy: null };
  const wallet = walletAddress.toLowerCase();
  const fees = verified.map((source) => operationFeeV1(source, wallet));
  const gasUnits = fees.reduce((sum, fee) => sum + fee.gasUsed, BigInt(0));
  const costs = fees.map((fee) => fee.costWei);
  const estimatedCostNative = costs.every((cost): cost is bigint => cost !== null)
    ? atomicDecimalFromWeiV1(costs.reduce((sum, cost) => sum + cost, BigInt(0)))
    : null;
  const sponsored = fees.map((fee) => fee.sponsored);
  const feePaidBy: FeePaidByV1 | null = sponsored.some((value) => value === null)
    ? null
    : sponsored.every((value) => value === true)
      ? 'sponsor'
      : sponsored.every((value) => value === false)
        ? 'wallet'
        : 'mixed';
  return {
    actualGas: { gasUnits: gasUnits.toString(), maxFeePerGasWei: null, estimatedCostNative, estimatedCostUsd: null },
    feePaidBy,
  };
}
