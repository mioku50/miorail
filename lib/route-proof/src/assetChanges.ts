import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import type { ExecutionResultV1, ExpectedAssetChangeV1 } from '@mioagent/route-domain';
import {
  CANONICAL_BASE_WETH,
  ERC20_TRANSFER_TOPIC0,
  WETH_DEPOSIT_TOPIC0,
  WETH_WITHDRAWAL_TOPIC0,
} from './constants.js';
import type { VerifiedReceiptLogV1 } from './receipts.js';

export type AssetReconstructionOutcomeV1 =
  | { kind: 'reconstructed'; actualResult: ExecutionResultV1 }
  | { kind: 'unsupported'; reason: 'native_output_unverifiable' | 'unsupported_asset' | 'gift_transfer_unverified' };

/** A gift in the batch: the output token's own transfer to someone else. */
export interface GiftTransferV1 {
  recipient: string;
  amountAtomic: string;
}

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

/** The gift an approved batch carries: its one ERC-20 transfer call. */
export function giftOfApprovedCallsV1(
  calls: readonly { callType: string; recipient: string | null; amountAtomic: string | null }[],
): GiftTransferV1 | null {
  const transfers = calls.filter((call) => call.callType === 'transfer');
  if (transfers.length !== 1) return null;
  const call = transfers[0]!;
  return call.recipient && call.amountAtomic ? { recipient: call.recipient, amountAtomic: call.amountAtomic } : null;
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

/**
 * Base's native asset, or any ERC-20 on Base named by its address.
 *
 * Until 2026-09-23 the ERC-20 side was canonical USDC and WETH only — written
 * when swaps were USDC↔ETH — so every tokenized-stock trade was sent to manual
 * review with "not verifiable" on its proof, while its receipt held the stock's
 * own Transfer to the wallet. An ERC-20 is read the same way whatever it is:
 * Transfer events that the token's own contract emitted, netted for the wallet.
 */
function supportedAssetV1(asset: ExpectedAssetChangeV1['asset']): boolean {
  if (asset.chainId !== 8453) return false;
  if (asset.kind === 'native') return true;
  return typeof asset.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(asset.address);
}

/**
 * A send, read back from the receipt: exactly one Transfer of the token, from
 * the wallet to the recipient, for exactly the declared amount. The wallet's
 * debit is its net outflow of that token in the receipt; what the recipient
 * received — the output — is that one Transfer's value.
 */
function reconstructSendV1(input: {
  walletAddress: `0x${string}`;
  debit: ExpectedAssetChangeV1;
  logs: readonly VerifiedReceiptLogV1[];
  giftTransfer: GiftTransferV1;
}): AssetReconstructionOutcomeV1 {
  const asset = input.debit.asset;
  if (asset.kind !== 'erc20' || !supportedAssetV1(asset)) return { kind: 'unsupported', reason: 'unsupported_asset' };
  const token = (asset.address as string).toLowerCase();
  const wallet = input.walletAddress.toLowerCase();
  const recipient = input.giftTransfer.recipient.toLowerCase();
  const decoded = decodeTransferLogsV1(input.logs);
  const matches = decoded.filter(
    (transfer) =>
      transfer.tokenAddress === token &&
      transfer.from === wallet &&
      transfer.to === recipient &&
      transfer.value.toString() === input.giftTransfer.amountAtomic,
  );
  if (matches.length !== 1) return { kind: 'unsupported', reason: 'gift_transfer_unverified' };
  const net = netForToken(decoded, token, wallet);
  const debit = net.out > net.in ? net.out - net.in : 0n;
  return {
    kind: 'reconstructed',
    actualResult: {
      assetChanges: [
        { asset, direction: 'debit', amountAtomic: debit.toString(), minimumAmountAtomic: null, maximumAmountAtomic: null },
      ],
      outputAmountAtomic: matches[0]!.value.toString(),
      outputAsset: asset,
    },
  };
}

/**
 * Reconstructs the actual Base swap movement from verified receipt logs only.
 * ERC-20 sides use wallet-net Transfer events emitted by that token's own
 * contract. Native sides use the canonical WETH9 Deposit/Withdrawal amount,
 * additionally bound to an approved call target. No balance-delta guess and no
 * trace-provider dependency is used.
 */
export function reconstructAssetChangesV1(input: {
  walletAddress: `0x${string}`;
  expectedAssetChanges: readonly ExpectedAssetChangeV1[];
  successReceiptLogs: readonly VerifiedReceiptLogV1[];
  approvedCallTargets?: readonly string[];
  /**
   * The gift the approved batch carried, if any. Its Transfer from the wallet
   * to the recipient is what the chain must show; the swap's own output is
   * then the wallet's net PLUS that transfer, because the gift left the
   * wallet after the swap put it there. No such Transfer, exactly as
   * declared, and nothing is reconstructed.
   */
  giftTransfer?: GiftTransferV1 | null;
}): AssetReconstructionOutcomeV1 {
  const outputChange = input.expectedAssetChanges.find((change) => change.direction === 'credit') ?? null;
  const inputChange = input.expectedAssetChanges.find((change) => change.direction === 'debit') ?? null;

  // A gift from holdings: nothing is bought, so nothing is credited. The one
  // debit is the gift itself, and what the chain must show is its Transfer.
  if (!outputChange && inputChange && input.giftTransfer && input.expectedAssetChanges.length === 1) {
    return reconstructSendV1({
      walletAddress: input.walletAddress,
      debit: inputChange,
      logs: input.successReceiptLogs,
      giftTransfer: input.giftTransfer,
    });
  }

  if (!outputChange || !supportedAssetV1(outputChange.asset) || (inputChange && !supportedAssetV1(inputChange.asset))) {
    return { kind: 'unsupported', reason: 'unsupported_asset' };
  }

  const wallet = input.walletAddress.toLowerCase();
  const decoded = decodeTransferLogsV1(input.successReceiptLogs);
  const native = nativeMovementV1(input.successReceiptLogs, input.approvedCallTargets ?? []);

  // The gift's own Transfer is set aside before netting: it is the gift, not
  // a cost of the swap. Exactly one, of the output token, wallet → recipient,
  // for exactly the declared amount — anything else is not the gift.
  let transfers = decoded;
  if (input.giftTransfer) {
    const token = outputChange.asset.kind === 'erc20' ? outputChange.asset.address?.toLowerCase() : null;
    const recipient = input.giftTransfer.recipient.toLowerCase();
    const matches = decoded.filter(
      (transfer) =>
        transfer.tokenAddress === token &&
        transfer.from === wallet &&
        transfer.to === recipient &&
        transfer.value.toString() === input.giftTransfer!.amountAtomic,
    );
    if (!token || matches.length !== 1) return { kind: 'unsupported', reason: 'gift_transfer_unverified' };
    transfers = decoded.filter((transfer) => transfer !== matches[0]);
  }

  const amountForV1 = (change: ExpectedAssetChangeV1, direction: 'debit' | 'credit'): bigint | null => {
    if (change.asset.kind === 'native') {
      if (!native) return null;
      return direction === 'debit' ? native.debit : native.credit;
    }
    const net = netForToken(transfers, (change.asset.address as string).toLowerCase(), wallet);
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
