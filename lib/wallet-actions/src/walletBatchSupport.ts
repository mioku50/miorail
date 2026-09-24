// ---------------------------------------------------------------------------
// Whether the connected wallet can send a batch as ONE transaction.
//
// Every Miorail trade leaves as one EIP-5792 batch with `atomicRequired`, so an
// approval never goes out without the trade it was granted for. Base Account,
// Coinbase Wallet (Base App) and MetaMask can all do that — MetaMask by
// offering to switch the account to its smart account first. A wallet that
// cannot must hear so in words BEFORE anything is approved, not as a raw
// JSON-RPC error after.
// ---------------------------------------------------------------------------

/**
 * What the wallet reports for atomic execution on a chain.
 *
 * - `supported`: it sends the batch as one transaction.
 * - `ready`: it can, after upgrading the account (EIP-7702) — the wallet asks.
 * - `unsupported`: it cannot.
 * - `null`: it said nothing (no `wallet_getCapabilities`, or no entry). Not a
 *   refusal: the wallet is asked, and its answer is translated.
 */
export type AtomicBatchSupportV1 = 'supported' | 'ready' | 'unsupported' | null;

export function atomicBatchSupportV1(capabilities: unknown, chainId = 8453): AtomicBatchSupportV1 {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const byChain = capabilities as Record<string | number, unknown>;
  // wagmi keys by decimal chain id; the raw RPC keys by hex.
  const entry = byChain[chainId] ?? byChain[`0x${chainId.toString(16)}`];
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const atomic = record.atomic;
  if (atomic && typeof atomic === 'object') {
    const status = (atomic as { status?: unknown }).status;
    if (status === 'supported' || status === 'ready' || status === 'unsupported') return status;
  }
  // The draft spelling some wallets still answer with.
  const legacy = record.atomicBatch;
  if (legacy && typeof legacy === 'object') {
    const supported = (legacy as { supported?: unknown }).supported;
    if (supported === true) return 'supported';
    if (supported === false) return 'unsupported';
  }
  return null;
}

export const WALLET_CANNOT_BATCH_V1 =
  'This wallet cannot send these calls as one transaction, and Miorail sends a trade only that way, so an approval never goes out without the trade it is for. Nothing was approved or sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';

export const WALLET_UPGRADE_DECLINED_V1 =
  'Your wallet offered to switch this account to a smart account so it can send the calls as one transaction, and the switch was declined. Nothing was sent. Accept the switch to trade, or use Base Account.';

export const WALLET_HAS_NO_BATCHES_V1 =
  'This wallet does not support sending a batch of calls (EIP-5792 wallet_sendCalls), which every Miorail trade needs. Nothing was sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';

/** The first numeric error code along a viem/wagmi error's `cause` chain. */
function walletErrorCodeV1(cause: unknown): number | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The wallet's refusal in words, when the refusal is about what the wallet can
 * do rather than about the person. Anything else keeps the wallet's own
 * message — a translation is only honest where the code says what happened.
 */
export function walletSubmissionFailureMessageV1(cause: unknown): string {
  const code = walletErrorCodeV1(cause);
  // EIP-5792: 5760 atomicity not supported, 5750 the upgrade was rejected.
  if (code === 5760) return WALLET_CANNOT_BATCH_V1;
  if (code === 5750) return WALLET_UPGRADE_DECLINED_V1;
  // EIP-1193 4200 / JSON-RPC -32601: the method itself is not there.
  if (code === 4200 || code === -32601) return WALLET_HAS_NO_BATCHES_V1;
  return cause instanceof Error ? cause.message : 'Wallet submission failed';
}
