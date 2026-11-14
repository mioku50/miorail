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
import {
  atomicBatchSupportV1,
  walletCannotSendSentenceV1,
  walletLacksCapabilitiesMethodV1,
  walletRefusedBatchesV1,
} from './walletBatchSupport';

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

export const PERMIT2_ADDRESS_V1 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;

const PERMIT2_APPROVE_ABI_V1 = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

export const PERMIT2_ALLOWANCE_ABI_V1 = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
] as const;

/**
 * A Permit2 allowance among the approved calls, decoded, or null. Uniswap's
 * routes spend through Permit2: the token lets Permit2 move it, and Permit2
 * lets the router move an exact amount until the quote ends. Sent in steps,
 * that second allowance is a step of its own (2026-11-11).
 */
export function permit2AllowanceOfV1(call: { to: string; data: string }): { token: Hex; spender: Hex; amount: bigint; expiration: number } | null {
  if (call.to.toLowerCase() !== PERMIT2_ADDRESS_V1 || call.data.slice(0, 10).toLowerCase() !== '0x87517c45') return null;
  try {
    const decoded = decodeFunctionData({ abi: PERMIT2_APPROVE_ABI_V1, data: call.data as Hex });
    const [token, spender, amount, expiration] = decoded.args;
    return { token: token.toLowerCase() as Hex, spender: spender.toLowerCase() as Hex, amount, expiration: Number(expiration) };
  } catch {
    return null;
  }
}

/**
 * Whether what Permit2 already holds covers a step: at least the amount, and
 * ending no earlier than the step's own allowance would. The one left by a
 * stopped swap step of the same review is exactly that, and is not asked for
 * twice; an older one that ends sooner is written again. An answer that could
 * not be read covers nothing.
 */
export function permit2AllowanceInPlaceV1(current: unknown, wanted: { amount: bigint; expiration: number }): boolean {
  if (!Array.isArray(current) || typeof current[0] !== 'bigint') return false;
  const expiration = Number(current[1]);
  return current[0] >= wanted.amount && Number.isFinite(expiration) && expiration >= wanted.expiration;
}

export type SwapDeliveryPlanV1 = 'atomic' | 'sequential';

/**
 * How a swap is asked for, before the server is.
 *
 * One batch for any wallet that can send one, or might: the batch is the
 * stronger promise. Steps for a wallet that said it cannot, that has no batch
 * methods at all, that refused a batch earlier in this tab, or whose batch has
 * just failed in a way that says so.
 */
export function swapDeliveryPlanV1(input: {
  capabilities: unknown;
  capabilitiesError: unknown;
  afterBatchFailure: boolean;
  knownNotToBatch?: boolean;
  chainId?: number;
}): SwapDeliveryPlanV1 {
  if (input.afterBatchFailure || input.knownNotToBatch) return 'sequential';
  if (atomicBatchSupportV1(input.capabilities, input.chainId ?? 8453) === 'unsupported') return 'sequential';
  if (!input.capabilities && walletLacksCapabilitiesMethodV1(input.capabilitiesError)) return 'sequential';
  return 'atomic';
}

/** Whether a failed batch says the wallet cannot send one, so the swap may go
 * in steps. A refusal by the person is not this. Coinbase Wallet with an
 * imported key said so only in words (walletCannotSendSentenceV1). */
export function batchFailureInvitesStepsV1(cause: unknown): boolean {
  return walletCannotSendSentenceV1(cause) !== null;
}

/**
 * Whether the same press goes on in steps. The wallet refused the batch
 * itself, so nothing was sent and nothing needs the person's word twice: the
 * wallet asks for each step. A declined smart-account switch is the person's
 * answer, so that one waits for them to press again.
 */
export function batchRefusalContinuesInStepsV1(cause: unknown): boolean {
  return walletRefusedBatchesV1(cause);
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

/** Said when the swap step was declined after its allowance landed. The allowance's hash is already in this
 * swap's proof, so the server refuses the same calls again (`route_already_sent`, 00231dcf): pressing again
 * cannot help, and the words no longer say it does (audit SW-2, 2026-11-14). */
export const SEQUENTIAL_SWAP_DECLINED_V1 =
  'The allowance for the exact amount is in place; the swap itself was not sent. These calls already reached Base once, so this quote is not sent again: compare again for a fresh one. An allowance already in place for the same amount is not asked for again.';

export const SEQUENTIAL_ALLOWANCE_FAILED_V1 =
  'The allowance transaction failed onchain, so the swap was not sent. Nothing was swapped.';

export const SEQUENTIAL_ALLOWANCE_UNREAD_V1 =
  'The allowance was sent, and its result could not be read within three minutes, so the swap was not sent. Check your wallet’s activity before pressing again.';

export const SEQUENTIAL_SEND_UNREAD_V1 =
  'The wallet did not say whether it sent this step: its answer never came back. Check your wallet’s activity before anything else, because it may already be on Base.';

export const SEQUENTIAL_EXPIRED_AFTER_ALLOWANCE_V1 =
  'The quote expired while the allowance confirmed, so the swap was not sent. The allowance is in place: go back to routes for a fresh quote, and it will not ask for another.';

export const SWAP_NEEDS_ONE_BATCH_V1 =
  'These calls can only be sent together, and this wallet cannot do that. Nothing was sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';
