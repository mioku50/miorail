// ---------------------------------------------------------------------------
// Whether the connected wallet can send a batch as ONE transaction.
//
// Every Miorail trade and every Still loan leaves as one EIP-5792 batch with
// `atomicRequired`, so an approval never goes out without the action it was
// granted for. Base Account, Coinbase Wallet (Base App) and MetaMask can all do
// that — MetaMask by offering to switch the account to its smart account first.
// A wallet that cannot must hear so in words BEFORE anything is approved, not
// as a raw JSON-RPC error after.
//
// Rabby, read from its source on 2026-10-31, has neither wallet_getCapabilities
// nor wallet_sendCalls: both answer -32601, "doesn't has corresponding handler".
// The swap screen showed that as "the wallet could not send this with the fee
// sponsored. Press again", with the wallet's real answer in a hover title, so
// the person pressed again for the same refusal.
//
// It lives in lib/ui, not wallet-actions, because the Still lending and stock
// action consoles here classify the same answers, and wallet-actions already
// depends on this package.
// ---------------------------------------------------------------------------

/**
 * What the wallet reports for atomic execution on a chain.
 *
 * - `supported`: it sends the batch as one transaction.
 * - `ready`: it can, after upgrading the account (EIP-7702) — the wallet asks.
 * - `unsupported`: it cannot.
 * - `null`: it said nothing (no entry for the chain, or no answer yet). Not a
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
  'This wallet cannot send these calls as one transaction. They are sent only together, so an approval never goes out without the action it is for. Nothing was approved or sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';

export const WALLET_UPGRADE_DECLINED_V1 =
  'Your wallet offered to switch this account to a smart account so it can send the calls as one transaction, and the switch was declined. Nothing was sent. Accept the switch to continue, or use Base Account.';

export const WALLET_HAS_NO_BATCHES_V1 =
  'This wallet cannot send several calls in one request, so it cannot send these as one transaction. They are sent only together, so an approval never goes out without the action it is for. Nothing was approved or sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.';

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

/** "This wallet" becomes the wallet's own name when the host knows it. wagmi's
 * catch-all connector is called "Injected", which names nothing a person has. */
function namedV1(sentence: string, walletName: string | null | undefined): string {
  const name = walletName?.trim();
  return name && name.length <= 40 && !/^(injected|browser wallet)$/i.test(name) ? sentence.replace(/^This wallet/, name) : sentence;
}

/**
 * The wallet's answer, when it says it CANNOT do what was asked. Each of these
 * is a refusal of the request itself, so nothing was sent.
 *
 * EIP-5792: 5760 atomicity not supported, 5750 the upgrade was rejected, 5710
 * the chain is not supported for batches. EIP-1193 4200 and JSON-RPC -32601:
 * the method is not there at all.
 */
export function walletCannotSendSentenceV1(cause: unknown, walletName?: string | null): string | null {
  const code = walletErrorCodeV1(cause);
  if (code === 5760 || code === 5710) return namedV1(WALLET_CANNOT_BATCH_V1, walletName);
  if (code === 5750) return WALLET_UPGRADE_DECLINED_V1;
  if (code === 4200 || code === -32601) return namedV1(WALLET_HAS_NO_BATCHES_V1, walletName);
  return null;
}

/**
 * Whether the wallet's answer proves that nothing was sent: the person refused
 * (EIP-1193 4001), or the wallet said it cannot do this at all. A timeout or a
 * dropped connection proves nothing and is not here.
 */
export function walletDidNotSendV1(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return true;
    current = record.cause;
  }
  return walletCannotSendSentenceV1(cause) !== null;
}

/**
 * The wallet's refusal in words, when the refusal is about what the wallet can
 * do rather than about the person. Anything else keeps the wallet's own
 * message — a translation is only honest where the code says what happened.
 */
export function walletSubmissionFailureMessageV1(cause: unknown, walletName?: string | null): string {
  return walletCannotSendSentenceV1(cause, walletName) ?? (cause instanceof Error ? cause.message : 'Wallet submission failed');
}

/** Whether reading the capabilities failed because the method is not there. */
export function walletLacksCapabilitiesMethodV1(error: unknown): boolean {
  const code = walletErrorCodeV1(error);
  return code === 4200 || code === -32601;
}

/**
 * What the page says before anything is approved, or null when the wallet may
 * be asked.
 *
 * A wallet that says it cannot batch, and a wallet with no
 * wallet_getCapabilities at all: EIP-5792 defines both methods together, and
 * every wallet Miorail serves answers it (Base Account, Base App, MetaMask,
 * Farcaster's). A wallet that has not answered yet, or failed for another
 * reason, is asked and its answer translated.
 */
export function walletBatchBlockerV1(input: {
  capabilities: unknown;
  capabilitiesError: unknown;
  walletName?: string | null;
  chainId?: number;
}): string | null {
  if (atomicBatchSupportV1(input.capabilities, input.chainId ?? 8453) === 'unsupported') {
    return namedV1(WALLET_CANNOT_BATCH_V1, input.walletName);
  }
  if (!input.capabilities && walletLacksCapabilitiesMethodV1(input.capabilitiesError)) {
    return namedV1(WALLET_HAS_NO_BATCHES_V1, input.walletName);
  }
  return null;
}
