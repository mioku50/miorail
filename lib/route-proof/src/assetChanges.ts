import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import type { ExecutionResultV1, ExpectedAssetChangeV1 } from '@mioagent/route-domain';
import { CANONICAL_BASE_USDC, CANONICAL_BASE_WETH, ERC20_TRANSFER_TOPIC0 } from './constants.js';
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

/**
 * Reconstructs the actual asset movement (Swap V1: USDC debit / WETH credit
 * only) from the verified ERC-20 Transfer logs of the SUCCESS receipts only.
 * Any output asset outside {USDC, WETH} — most importantly native ETH, which
 * emits no Transfer log — is honestly reported as unsupported rather than
 * guessed from a balance delta or trace.
 */
export function reconstructAssetChangesV1(input: {
  walletAddress: `0x${string}`;
  expectedAssetChanges: readonly ExpectedAssetChangeV1[];
  successReceiptLogs: readonly VerifiedReceiptLogV1[];
}): AssetReconstructionOutcomeV1 {
  const outputChange = input.expectedAssetChanges.find((change) => change.direction === 'credit') ?? null;
  const inputChange = input.expectedAssetChanges.find((change) => change.direction === 'debit') ?? null;

  if (!outputChange || outputChange.asset.kind === 'native') {
    return { kind: 'unsupported', reason: 'native_output_unverifiable' };
  }
  if (outputChange.asset.address?.toLowerCase() !== CANONICAL_BASE_WETH) {
    return { kind: 'unsupported', reason: 'unsupported_asset' };
  }
  // The debit leg must be STRICTLY canonical ERC-20 USDC. A native debit (or
  // any other asset) emits no Transfer log this method can observe — letting
  // it through would fabricate an honest-looking "0"-amount debit, so it is
  // rejected as unsupported instead of reconstructed.
  if (
    inputChange &&
    (inputChange.asset.kind !== 'erc20' || inputChange.asset.address?.toLowerCase() !== CANONICAL_BASE_USDC)
  ) {
    return { kind: 'unsupported', reason: 'unsupported_asset' };
  }

  const wallet = input.walletAddress.toLowerCase();
  const transfers = decodeTransferLogsV1(input.successReceiptLogs);
  const usdc = netForToken(transfers, CANONICAL_BASE_USDC, wallet);
  const weth = netForToken(transfers, CANONICAL_BASE_WETH, wallet);
  const usdcDebit = usdc.out > usdc.in ? usdc.out - usdc.in : BigInt(0);
  const wethCredit = weth.in > weth.out ? weth.in - weth.out : BigInt(0);

  const assetChanges: ExpectedAssetChangeV1[] = [];
  if (inputChange) {
    assetChanges.push({
      asset: inputChange.asset,
      direction: 'debit',
      amountAtomic: usdcDebit.toString(),
      minimumAmountAtomic: null,
      maximumAmountAtomic: null,
    });
  }
  assetChanges.push({
    asset: outputChange.asset,
    direction: 'credit',
    amountAtomic: wethCredit.toString(),
    minimumAmountAtomic: null,
    maximumAmountAtomic: null,
  });

  return {
    kind: 'reconstructed',
    actualResult: {
      assetChanges,
      outputAmountAtomic: wethCredit.toString(),
      outputAsset: outputChange.asset,
    },
  };
}
