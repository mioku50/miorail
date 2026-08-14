import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import type { ExecutionResultV1, ExpectedAssetChangeV1 } from '@mioagent/route-domain';
import {
  CANONICAL_BASE_USDC,
  CANONICAL_BASE_WETH,
  ERC20_TRANSFER_TOPIC0,
  WETH_DEPOSIT_TOPIC0,
  WETH_WITHDRAWAL_TOPIC0,
} from './constants.js';
import type { VerifiedReceiptLogV1 } from './receipts.js';

export type AssetReconstructionOutcomeV1 =
  | { kind: 'reconstructed'; actualResult: ExecutionResultV1 }
  | { kind: 'unsupported'; reason: 'native_output_unverifiable' | 'unsupported_asset' };

interface DecodedTransferV1 {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
}

/** Decodes only well-formed ERC-20 Transfer logs; anything else (malformed
 * data, unrelated topic0) is skipped rather than thrown — reconstruction
 * stays conservative, never fabricating a transfer that wasn't really there. */
function decodeTransferLogsV1(logs: readonly VerifiedReceiptLogV1[]): DecodedTransferV1[] {
  const out: DecodedTransferV1[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0];
    if (!topic0 || topic0.toLowerCase() !== ERC20_TRANSFER_TOPIC0.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        eventName: 'Transfer',
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });
      out.push({
        tokenAddress: log.address.toLowerCase(),
        from: decoded.args.from.toLowerCase(),
        to: decoded.args.to.toLowerCase(),
        value: decoded.args.value,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function netForToken(transfers: readonly DecodedTransferV1[], tokenAddress: string, wallet: string): { out: bigint; in: bigint } {
  let out = BigInt(0);
  let inbound = BigInt(0);
  for (const transfer of transfers) {
    if (transfer.tokenAddress !== tokenAddress) continue;
    if (transfer.from === wallet) out += transfer.value;
    if (transfer.to === wallet) inbound += transfer.value;
  }
  return { out, in: inbound };
}

function topicAddressV1(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function uintDataV1(data: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  try {
    return BigInt(data);
  } catch {
    return null;
  }
}

/** Native ETH itself emits no log. Canonical WETH9 does emit the exact amount
 * as the approved router wraps `msg.value` or unwraps output for the bound
 * recipient. We accept that evidence only when the event actor is one of the
 * server-approved call targets; an unrelated WETH event in a broader wallet
 * batch cannot be counted. */
function nativeMovementV1(
  logs: readonly VerifiedReceiptLogV1[],
  approvedCallTargets: readonly string[],
): { debit: bigint; credit: bigint } | null {
  if (approvedCallTargets.length === 0) return null;
  const allowed = new Set(approvedCallTargets.map((target) => target.toLowerCase()));
  let wrapped = 0n;
  let unwrapped = 0n;
  let observed = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== CANONICAL_BASE_WETH) continue;
    const actor = topicAddressV1(log.topics[1]);
    if (!actor || !allowed.has(actor)) continue;
    const amount = uintDataV1(log.data);
    if (amount === null) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === WETH_DEPOSIT_TOPIC0.toLowerCase()) {
      wrapped += amount;
      observed = true;
    }
    if (topic0 === WETH_WITHDRAWAL_TOPIC0.toLowerCase()) {
      unwrapped += amount;
      observed = true;
    }
  }
  if (!observed) return null;
  return {
    debit: wrapped > unwrapped ? wrapped - unwrapped : 0n,
    credit: unwrapped > wrapped ? unwrapped - wrapped : 0n,
  };
}

function supportedAssetV1(asset: ExpectedAssetChangeV1['asset']): boolean {
  if (asset.kind === 'native') return asset.chainId === 8453;
  const address = asset.address?.toLowerCase();
  return address === CANONICAL_BASE_USDC || address === CANONICAL_BASE_WETH;
}

/**
 * Reconstructs the actual Base swap movement from verified receipt logs only.
 * ERC-20 sides use wallet-net Transfer events. Native sides use the canonical
 * WETH9 Deposit/Withdrawal amount, additionally bound to an approved call
 * target. No balance-delta guess and no trace-provider dependency is used.
 */
export function reconstructAssetChangesV1(input: {
  walletAddress: `0x${string}`;
  expectedAssetChanges: readonly ExpectedAssetChangeV1[];
  successReceiptLogs: readonly VerifiedReceiptLogV1[];
  approvedCallTargets?: readonly string[];
}): AssetReconstructionOutcomeV1 {
  const outputChange = input.expectedAssetChanges.find((change) => change.direction === 'credit') ?? null;
  const inputChange = input.expectedAssetChanges.find((change) => change.direction === 'debit') ?? null;

  if (!outputChange || !supportedAssetV1(outputChange.asset) || (inputChange && !supportedAssetV1(inputChange.asset))) {
    return { kind: 'unsupported', reason: 'unsupported_asset' };
  }

  const wallet = input.walletAddress.toLowerCase();
  const transfers = decodeTransferLogsV1(input.successReceiptLogs);
  const usdc = netForToken(transfers, CANONICAL_BASE_USDC, wallet);
  const weth = netForToken(transfers, CANONICAL_BASE_WETH, wallet);
  const native = nativeMovementV1(input.successReceiptLogs, input.approvedCallTargets ?? []);

  const amountForV1 = (change: ExpectedAssetChangeV1, direction: 'debit' | 'credit'): bigint | null => {
    if (change.asset.kind === 'native') {
      if (!native) return null;
      return direction === 'debit' ? native.debit : native.credit;
    }
    const net = change.asset.address?.toLowerCase() === CANONICAL_BASE_USDC ? usdc : weth;
    return direction === 'debit'
      ? (net.out > net.in ? net.out - net.in : 0n)
      : (net.in > net.out ? net.in - net.out : 0n);
  };

  const outputAmount = amountForV1(outputChange, 'credit');
  const inputAmount = inputChange ? amountForV1(inputChange, 'debit') : 0n;
  if (outputAmount === null || inputAmount === null) {
    return { kind: 'unsupported', reason: 'native_output_unverifiable' };
  }

  const assetChanges: ExpectedAssetChangeV1[] = [];
  if (inputChange) {
    assetChanges.push({
      asset: inputChange.asset,
      direction: 'debit',
      amountAtomic: inputAmount.toString(),
      minimumAmountAtomic: null,
      maximumAmountAtomic: null,
    });
  }
  assetChanges.push({
    asset: outputChange.asset,
    direction: 'credit',
    amountAtomic: outputAmount.toString(),
    minimumAmountAtomic: null,
    maximumAmountAtomic: null,
  });

  return {
    kind: 'reconstructed',
    actualResult: {
      assetChanges,
      outputAmountAtomic: outputAmount.toString(),
      outputAsset: outputChange.asset,
    },
  };
}
