// ---------------------------------------------------------------------------
// A swap sent one transaction at a time, for a wallet that cannot send a batch.
//
// Every Miorail trade leaves as one EIP-5792 batch, so an approval never goes
// out without the trade it is for. Rabby has no wallet_sendCalls, and an
// imported key in Coinbase Wallet answered one with "...is not supported"
// (2026-10-31), so neither could swap at all. The operator chose ("да
// сделай"): for those wallets a swap goes in steps. First an allowance for
// exactly the amount, then, once that has landed, the swap. A loan never does.
//
// The server decides whether these calls may go one at a time
// (transaction-composer `sequentialSwapDeliveryV1`); this module decides only
// when to ask, and what the screen says while the steps run.
// ---------------------------------------------------------------------------

import { concat, decodeFunctionData, erc20Abi, numberToHex, type Hex } from 'viem';
import { atomicBatchSupportV1, walletCannotSendSentenceV1, walletLacksCapabilitiesMethodV1 } from './walletBatchSupport';

/**
 * viem's EIP-5792 fallback marker. A batch id ending in it is a list of
 * transaction hashes, and viem's getCallsStatus reads their receipts itself
 * instead of asking the wallet, so the batch poller follows these steps
 * unchanged.
 */
export const SEQUENTIAL_BATCH_MAGIC_V1 = '0x5792579257925792579257925792579257925792579257925792579257925792' as const;

/** The batch id of transactions sent one at a time: viem's fallback format. */
export function sequentialBatchIdV1(hashes: readonly Hex[], chainId: number): Hex {
  return concat([...hashes, numberToHex(chainId, { size: 32 }), SEQUENTIAL_BATCH_MAGIC_V1]);
}

/** An ERC-20 approval among the approved calls, decoded, or null. */
export function exactAllowanceOfV1(call: { to: string; data: string }): { token: Hex; spender: Hex; amount: bigint } | null {
  if (call.data.slice(0, 10).toLowerCase() !== '0x095ea7b3') return null;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as Hex });
    if (decoded.functionName !== 'approve') return null;
    const [spender, amount] = decoded.args as readonly [Hex, bigint];
    return { token: call.to.toLowerCase() as Hex, spender: spender.toLowerCase() as Hex, amount };
  } catch {
    return null;
  }
}

export type SwapDeliveryPlanV1 = 'atomic' | 'sequential';

/**
 * How a swap is asked for, before the server is.
 *
 * One batch for any wallet that can send one, or might: the batch is the
 * stronger promise. Steps for a wallet that said it cannot, that has no batch
 * methods at all, or whose batch has just failed in a way that says so.
 */
export function swapDeliveryPlanV1(input: {
  capabilities: unknown;
  capabilitiesError: unknown;
  afterBatchFailure: boolean;
  chainId?: number;
}): SwapDeliveryPlanV1 {
  if (input.afterBatchFailure) return 'sequential';
  if (atomicBatchSupportV1(input.capabilities, input.chainId ?? 8453) === 'unsupported') return 'sequential';
  if (!input.capabilities && walletLacksCapabilitiesMethodV1(input.capabilitiesError)) return 'sequential';
  return 'atomic';
}

/** Whether a failed batch says the wallet cannot send one, so the next press
 * may go in steps. A refusal by the person is not this. */
export function batchFailureInvitesStepsV1(cause: unknown): boolean {
  if (walletCannotSendSentenceV1(cause) !== null) return true;
  // Coinbase Wallet with an imported key, 2026-10-31: -32603 "...is not
  // supported". The wallet's own words are the only signal it gave.
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { details?: unknown; message?: unknown; cause?: unknown };
    for (const text of [record.details, record.message]) {
      if (typeof text === 'string' && /\b(?:not supported|unsupported|does not support)\b/i.test(text)) return true;
    }
    current = record.cause;
  }
  return false;
}

/** "This wallet" becomes the wallet's own name, as in walletBatchSupport. */
function namedV1(sentence: string, walletName: string | null | undefined): string {
  const name = walletName?.trim();
  return name && name.length <= 40 && !/^(injected|browser wallet)$/i.test(name) ? sentence.replace(/^This wallet/, name) : sentence;
}

/** Said before anything is pressed, when the swap will go in steps. */
export function sequentialNoticeV1(walletName?: string | null): string {
  return namedV1(
    'This wallet sends one transaction at a time, so this swap goes in steps. If it needs an allowance, that comes first, for exactly the amount you swap; once it lands, your wallet asks again for the swap. You pay the network fee for each step. Stopping after the allowance leaves it in place until a swap uses it.',
    walletName,
  );
}

export function sequentialAfterBatchFailureV1(walletName?: string | null): string {
  return namedV1(
    'This wallet could not send these calls together. Nothing was sent. Press again to send them one at a time: first the allowance for the exact amount, then the swap.',
    walletName,
  );
}

export const SEQUENTIAL_SWAP_DECLINED_V1 =
  'The allowance for the exact amount is in place; the swap itself was not sent. Press again to send just the swap while this quote holds.';

export const SEQUENTIAL_ALLOWANCE_FAILED_V1 =
  'The allowance transaction failed onchain, so the swap was not sent. Nothing was swapped.';

export const SEQUENTIAL_ALLOWANCE_UNREAD_V1 =
  'The allowance was sent, and its result could not be read within three minutes, so the swap was not sent. Check your wallet’s activity before pressing again.';

export const SEQUENTIAL_EXPIRED_AFTER_ALLOWANCE_V1 =
  'The quote expired while the allowance confirmed, so the swap was not sent. The allowance is in place: go back to routes for a fresh quote, and it will not ask for another.';

export const SWAP_NEEDS_ONE_BATCH_V1 =
  'These calls can only be sent together, and this wallet cannot do that. Nothing was sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';
