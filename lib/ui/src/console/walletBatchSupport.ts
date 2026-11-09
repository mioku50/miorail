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
 * A wallet that refused in its own words rather than by a code. Coinbase Wallet
 * with an imported key answered wallet_sendCalls with -32603 "An internal error
 * was received" and "...is not supported" in the details (2026-10-31); the Still
 * loan page read that as "maybe sent" and locked the review.
 */
function walletSaysUnsupportedV1(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; details?: unknown; message?: unknown; cause?: unknown };
    // A capability marked required (5700) is its own answer, not this one.
    if (record.code === 5700) return false;
    for (const text of [record.details, record.message]) {
      if (typeof text === 'string' && /\b(?:not supported|unsupported|does not support)\b/i.test(text)) return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * The wallet's answer, when it says it CANNOT do what was asked. Each of these
 * is a refusal of the request itself, so nothing was sent.
 *
 * EIP-5792: 5760 atomicity not supported, 5750 the upgrade was rejected, 5710
 * the chain is not supported for batches. EIP-1193 4200 and JSON-RPC -32601:
 * the method is not there at all. An internal error (-32603) only when the
 * wallet's own words say the request is not supported.
 */
export function walletCannotSendSentenceV1(cause: unknown, walletName?: string | null): string | null {
  const code = walletErrorCodeV1(cause);
  if (code === 5760 || code === 5710) return namedV1(WALLET_CANNOT_BATCH_V1, walletName);
  if (code === 5750) return WALLET_UPGRADE_DECLINED_V1;
  if (code === 4200 || code === -32601) return namedV1(WALLET_HAS_NO_BATCHES_V1, walletName);
  if ((code === -32603 || code === null) && walletSaysUnsupportedV1(cause)) return namedV1(WALLET_CANNOT_BATCH_V1, walletName);
  return null;
}

/**
 * Whether the refusal is about the wallet, so this wallet is not asked for a
 * batch again. The declined smart-account switch (5750) is the person's
 * choice, not the wallet's, and is asked again.
 */
export function walletRefusedBatchesV1(cause: unknown): boolean {
  return walletErrorCodeV1(cause) !== 5750 && walletCannotSendSentenceV1(cause) !== null;
}

// What a wallet said about itself by refusing a batch, kept for this tab. The
// next press is not asked of it again, and every page that needs one batch
// says so before the button instead of after it.
const KNOWN_KEY_V1 = 'miorail.wallet.cannotBatch.v1';
const knownCannotBatchV1 = new Set<string>();
const verdictListenersV1 = new Set<() => void>();
let verdictsLoadedV1 = false;

function loadVerdictsV1(): void {
  if (verdictsLoadedV1) return;
  verdictsLoadedV1 = true;
  try {
    const saved: unknown = JSON.parse(globalThis.sessionStorage?.getItem(KNOWN_KEY_V1) ?? '[]');
    if (Array.isArray(saved)) for (const key of saved) if (typeof key === 'string') knownCannotBatchV1.add(key);
  } catch {
    // Storage can be blocked; the verdict then lasts as long as the page.
  }
}

/** One wallet app with one account. Null until both are known. */
export function walletBatchKeyV1(connectorId: string | null | undefined, address: string | null | undefined): string | null {
  return connectorId && address ? `${connectorId.toLowerCase()}:${address.toLowerCase()}` : null;
}

export function rememberWalletCannotBatchV1(key: string | null): void {
  if (!key) return;
  loadVerdictsV1();
  if (knownCannotBatchV1.has(key)) return;
  knownCannotBatchV1.add(key);
  try {
    globalThis.sessionStorage?.setItem(KNOWN_KEY_V1, JSON.stringify([...knownCannotBatchV1]));
  } catch {
    // Kept in memory only.
  }
  for (const listener of verdictListenersV1) listener();
}

export function walletKnownNotToBatchV1(key: string | null): boolean {
  if (!key) return false;
  loadVerdictsV1();
  return knownCannotBatchV1.has(key);
}

export function subscribeWalletBatchVerdictsV1(listener: () => void): () => void {
  verdictListenersV1.add(listener);
  return () => {
    verdictListenersV1.delete(listener);
  };
}

/**
 * The wallet's own connection to Base failed: MetaMask's words when the RPC its
 * Base network uses keeps failing and it stops asking it for a while. On
 * 2026-11-08 MetaMask answered a swap's wallet_sendCalls with -32002 "RPC
 * 0x2105 Custom eth_getCode: RPC endpoint returned too many errors, retrying in
 * 0,12 minutes. Consider using a different RPC endpoint.", on its own default
 * Base endpoint (Infura, with a QuickNode failover): "Custom" is the type
 * MetaMask gives Base's endpoint, not a sign of an RPC the person added. The
 * page blamed the fee sponsor, which MetaMask never asked. It is the wallet's
 * connection, not Miorail's server and not the sponsor. `beforeSending`: the
 * request that failed is a read a wallet makes before it signs or sends.
 */
const WALLET_RPC_FAILING_V1 = /RPC endpoint returned too many errors|Consider using a different RPC endpoint/i;
const WALLET_READ_BEFORE_SENDING_V1 = /\beth_(?:getCode|call|estimateGas|getTransactionCount|chainId|getBalance|gasPrice|feeHistory|maxPriorityFeePerGas|getBlockByNumber)\b/;
function walletNetworkFailureV1(cause: unknown): { beforeSending: boolean } | null {
  let current: unknown = cause;
  let words = '';
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { details?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const text of [record.details, record.message, record.shortMessage]) if (typeof text === 'string') words += `\n${text}`;
    current = record.cause;
  }
  if (!WALLET_RPC_FAILING_V1.test(words)) return null;
  return { beforeSending: WALLET_READ_BEFORE_SENDING_V1.test(words) && !/\beth_send(?:Raw)?Transaction\b/.test(words) };
}

/** What the page says when the wallet could not reach Base, or null for any other failure. */
export function walletNetworkFailureSentenceV1(cause: unknown, walletName?: string | null): string | null {
  const failure = walletNetworkFailureV1(cause);
  if (!failure) return null;
  const sent = failure.beforeSending
    ? ', so nothing was sent. Wait a minute and press again.'
    : '. Check its activity before you press again: if nothing is there, nothing was sent.';
  return namedV1(`This wallet could not reach Base: its own connection to the network (its RPC) kept failing${sent}`
    + ' If it keeps failing, try another internet connection (turn a VPN on or off), or add another RPC for Base in the wallet’s network settings,'
    + ' such as Base’s public https://mainnet.base.org, and make it the default.', walletName);
}

/**
 * How long the wallet said it waits before it asks its RPC again, in milliseconds, or null when it
 * did not say. MetaMask writes the minutes with the reader's decimal comma: "retrying in 0,12 minutes".
 */
export function walletNetworkRetryAfterMsV1(cause: unknown): number | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { details?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    for (const text of [record.details, record.message, record.shortMessage]) {
      const match = typeof text === 'string' ? /retrying in ([0-9]{1,4}(?:[.,][0-9]{1,4})?) (minute|second)s?\b/i.exec(text) : null;
      if (match) return Math.round(Number(match[1]!.replace(',', '.')) * (match[2]!.toLowerCase() === 'minute' ? 60_000 : 1_000));
    }
    current = record.cause;
  }
  return null;
}

/** The longest a press waits for a wallet's connection to Base to come back before the person is told. */
export const WALLET_NETWORK_RETRY_MAX_WAIT_MS_V1 = 20_000;

/**
 * Sends the same request once more when the wallet's own connection to Base failed on a read it
 * makes before sending, after the wait the wallet named (MetaMask, 2026-11-08: "retrying in 0,12
 * minutes"). Nothing was sent, so this is the same request again, never a second one. A wallet that
 * named a longer wait than the bound, failed while sending, or failed any other way is not asked
 * again: the caller says what happened.
 */
export async function sendRetryingWalletNetworkV1<T>(send: () => Promise<T>, options: {
  retries?: number;
  maxWaitMs?: number;
  /** Told before each wait, with its length, so the page can say why it is waiting. */
  onWait?: (ms: number) => void;
  wait?: (ms: number) => Promise<void>;
} = {}): Promise<T> {
  const retries = options.retries ?? 1;
  const maxWaitMs = options.maxWaitMs ?? WALLET_NETWORK_RETRY_MAX_WAIT_MS_V1;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= retries || walletNetworkFailureV1(error)?.beforeSending !== true) throw error;
      const named = walletNetworkRetryAfterMsV1(error);
      if (named !== null && named > maxWaitMs) throw error;
      const ms = Math.min(maxWaitMs, (named ?? 4_000) + 1_000);
      options.onWait?.(ms);
      await wait(ms);
    }
  }
}

/**
 * The page's own connection to the wallet was not live, so the wallet was never asked. After a
 * reload wagmi keeps the restored connection as a bare record ({ id, name, type, uid }) until its
 * reconnect finishes; useAccount already gives the address, so the page says Connected, and an
 * action in that window throws "connector.getChainId is not a function" (2026-11-09: four swaps of
 * one wallet failed so in one evening, and the page showed that sentence). wagmi's own names for
 * the same state are ConnectorUnavailableReconnectingError and ConnectorNotConnectedError, and
 * wallet-actions throws WalletConnectionNotReadyError when it could not bring the connection back.
 */
export const WALLET_CONNECTION_NOT_READY_V1 =
  'Your wallet’s connection in this tab was not ready, so the wallet was not asked and nothing was sent. Open the wallet, unlock it if it is locked, and press again.';
const CONNECTION_NOT_READY_NAMES_V1 = new Set(['WalletConnectionNotReadyError', 'ConnectorUnavailableReconnectingError', 'ConnectorNotConnectedError']);
const BARE_CONNECTOR_V1 = /\bconnector\.(?:getChainId|getAccounts|getProvider) is not a function\b/;
export function walletConnectionNotReadyV1(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.name === 'string' && CONNECTION_NOT_READY_NAMES_V1.has(record.name)) return true;
    if (typeof record.message === 'string' && BARE_CONNECTOR_V1.test(record.message)) return true;
    current = record.cause;
  }
  return false;
}

/**
 * Whether the wallet's answer proves that nothing was sent: the person refused
 * (EIP-1193 4001), the wallet said it cannot do this at all, its own
 * connection to Base failed on a read it makes before sending, or the page's
 * connection to it was not live, so it was never asked. A timeout or a
 * dropped connection proves nothing and is not here.
 */
export function walletDidNotSendV1(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return true;
    current = record.cause;
  }
  return walletCannotSendSentenceV1(cause) !== null || walletNetworkFailureV1(cause)?.beforeSending === true
    || walletConnectionNotReadyV1(cause);
}

/**
 * The wallet's refusal in words, when the refusal is about what the wallet can
 * do rather than about the person, when its own connection to Base failed, or
 * when the page's connection to it was not live. Anything else keeps the
 * wallet's own message — a translation is only honest where the code or the
 * wallet's words say what happened.
 */
export function walletSubmissionFailureMessageV1(cause: unknown, walletName?: string | null): string {
  return walletCannotSendSentenceV1(cause, walletName) ?? walletNetworkFailureSentenceV1(cause, walletName)
    ?? (walletConnectionNotReadyV1(cause) ? WALLET_CONNECTION_NOT_READY_V1 : null)
    ?? (cause instanceof Error ? cause.message : 'Wallet submission failed');
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
  /** This wallet already refused a batch in this tab. */
  knownNotToBatch?: boolean;
}): string | null {
  if (input.knownNotToBatch || atomicBatchSupportV1(input.capabilities, input.chainId ?? 8453) === 'unsupported') {
    return namedV1(WALLET_CANNOT_BATCH_V1, input.walletName);
  }
  if (!input.capabilities && walletLacksCapabilitiesMethodV1(input.capabilitiesError)) {
    return namedV1(WALLET_HAS_NO_BATCHES_V1, input.walletName);
  }
  return null;
}
