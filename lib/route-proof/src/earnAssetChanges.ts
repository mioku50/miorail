import { decodeEventLog, erc20Abi, type Hex } from 'viem';
import type { AssetRefV1, ExecutionResultV1 } from '@mioagent/route-domain';
import { CANONICAL_BASE_USDC, ERC20_TRANSFER_TOPIC0 } from './constants.js';
import type { VerifiedReceiptLogV1 } from './receipts.js';

// ---------------------------------------------------------------------------
// T61 §8 — earn deposit Route Proof reconstruction. A deposit's proof is NOT
// "the receipt succeeded"; it is the two ERC-20 movements the user was promised:
//   • the EXACT USDC DEBIT leaving the wallet, and
//   • a POSITION CREDIT — mTokens (Moonwell market) or vault shares (Morpho
//     ERC-4626) — arriving at the wallet (both tokens ARE the deposit target).
// Both are read only from the SUCCESS receipts' Transfer logs. If the position
// credit (or the USDC debit) cannot be observed, the deposit is UNPROVABLE and
// routes to `reconciliation_required` — a successful receipt is never enough.
// ---------------------------------------------------------------------------

interface DecodedTransferV1 {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
}

/** Decodes only well-formed ERC-20 Transfer logs; anything else is skipped
 * (never a fabricated transfer). Mirrors assetChanges.ts intentionally — earn
 * reconstruction must not couple to the swap reconstructor's asset pair. */
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

function netForToken(
  transfers: readonly DecodedTransferV1[],
  tokenAddress: string,
  wallet: string,
): { out: bigint; in: bigint } {
  let out = BigInt(0);
  let inbound = BigInt(0);
  for (const transfer of transfers) {
    if (transfer.tokenAddress !== tokenAddress) continue;
    if (transfer.from === wallet) out += transfer.value;
    if (transfer.to === wallet) inbound += transfer.value;
  }
  return { out, in: inbound };
}

export interface ReconstructEarnPositionInputV1 {
  walletAddress: `0x${string}`;
  /** Canonical Base USDC (the debit asset). */
  usdcAsset: AssetRefV1;
  /** The position token == the deposit target (mToken market / ERC-4626 vault). */
  positionAsset: AssetRefV1;
  successReceiptLogs: readonly VerifiedReceiptLogV1[];
}

export type EarnPositionReconstructionV1 =
  | {
      kind: 'reconstructed';
      actualResult: ExecutionResultV1;
      usdcDebitAtomic: string;
      positionCreditAtomic: string;
    }
  | { kind: 'unprovable'; reason: 'position_credit_absent' | 'usdc_debit_absent' | 'unsupported_asset' };

/**
 * Reconstructs the actual USDC debit and position credit for an earn deposit
 * from the SUCCESS receipts' Transfer logs. Conservative: a missing/zero
 * position credit is reported `unprovable` (→ reconciliation_required), never
 * a fabricated "0" position.
 */
export function reconstructEarnPositionV1(
  input: ReconstructEarnPositionInputV1,
): EarnPositionReconstructionV1 {
  const usdcAddress = input.usdcAsset.address?.toLowerCase();
  const positionAddress = input.positionAsset.address?.toLowerCase();
  // The debit leg must be STRICTLY canonical ERC-20 USDC and the position must
  // be a concrete ERC-20 token — anything else emits no observable Transfer.
  if (
    input.usdcAsset.kind !== 'erc20' ||
    usdcAddress !== CANONICAL_BASE_USDC ||
    input.positionAsset.kind !== 'erc20' ||
    !positionAddress
  ) {
    return { kind: 'unprovable', reason: 'unsupported_asset' };
  }

  const wallet = input.walletAddress.toLowerCase();
  const transfers = decodeTransferLogsV1(input.successReceiptLogs);
  const usdc = netForToken(transfers, usdcAddress, wallet);
  const position = netForToken(transfers, positionAddress, wallet);
  const usdcDebit = usdc.out > usdc.in ? usdc.out - usdc.in : BigInt(0);
  const positionCredit = position.in > position.out ? position.in - position.out : BigInt(0);

  // A successful receipt with no USDC actually leaving, or no position token
  // actually arriving, does NOT prove the deposit — surface for reconciliation.
  if (usdcDebit === BigInt(0)) {
    return { kind: 'unprovable', reason: 'usdc_debit_absent' };
  }
  if (positionCredit === BigInt(0)) {
    return { kind: 'unprovable', reason: 'position_credit_absent' };
  }

  const actualResult: ExecutionResultV1 = {
    assetChanges: [
      {
        asset: input.usdcAsset,
        direction: 'debit',
        amountAtomic: usdcDebit.toString(),
        minimumAmountAtomic: null,
        maximumAmountAtomic: null,
      },
      {
        asset: input.positionAsset,
        direction: 'credit',
        amountAtomic: positionCredit.toString(),
        minimumAmountAtomic: null,
        maximumAmountAtomic: null,
      },
    ],
    outputAmountAtomic: positionCredit.toString(),
    outputAsset: input.positionAsset,
  };
  return {
    kind: 'reconstructed',
    actualResult,
    usdcDebitAtomic: usdcDebit.toString(),
    positionCreditAtomic: positionCredit.toString(),
  };
}

export interface EarnPositionProofOutcomeV1 {
  finalStatus: 'completed' | 'partial_failure' | 'failed' | 'reconciliation_required';
  reconciliationState: 'matched' | 'partial' | 'failed' | 'manual_review';
}

/**
 * The §8 finalization policy for an earn deposit, given the reconstruction and
 * the receipt outcome. Encodes "receipt success ≠ deposit proof": even when
 * every receipt succeeded, an unprovable position is `reconciliation_required`.
 */
export function earnPositionProofOutcomeV1(input: {
  reconstruction: EarnPositionReconstructionV1;
  anyReceiptSuccess: boolean;
  allReceiptsSuccess: boolean;
}): EarnPositionProofOutcomeV1 {
  if (!input.anyReceiptSuccess) {
    return { finalStatus: 'failed', reconciliationState: 'failed' };
  }
  if (input.reconstruction.kind === 'unprovable') {
    // A success receipt is NOT proof of the deposit — the position could not be
    // observed onchain, so a human must reconcile it.
    return { finalStatus: 'reconciliation_required', reconciliationState: 'manual_review' };
  }
  if (input.allReceiptsSuccess) {
    return { finalStatus: 'completed', reconciliationState: 'matched' };
  }
  return { finalStatus: 'partial_failure', reconciliationState: 'partial' };
}
