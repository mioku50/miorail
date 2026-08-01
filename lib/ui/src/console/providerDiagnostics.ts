// ---------------------------------------------------------------------------
// T67E §3 — swap provider diagnostics.
//
// This module exists because of a defect, not a feature request. The console
// read `failure.adapterId` off every provider failure, and the wire has never
// carried that field: `SwapAdapterFailureV1` is
// `{ outcome, provider, errorCode, retryable }` and the schema is `.strict()`.
// So every failed provider rendered as `undefined` — in the candidate table, in
// the evidence table, in the adapter rail and in the "didn't answer" notice.
// The old `ProviderFailureNotice` in RoutePlan.tsx read `failure.provider` and
// was right; the console was written later and was wrong.
//
// Two rules this module keeps:
//
//   * The reason a user sees is derived from a TYPED code, never from parsing
//     provider text. Nothing here looks at a message, a status line or a body.
//     The server already sends `errorCode`; the front end's whole job is to
//     translate it.
//   * A failure sentence names what happened, what still works, and what the
//     user can do. A bare code ("provider_invalid_schema") tells a user
//     nothing, and "something went wrong" tells them less.
// ---------------------------------------------------------------------------

/** Adapter id → the name a person recognises. The wire sends the id. */
export const SWAP_PROVIDER_DISPLAY_NAME_V1: Record<string, string> = {
  uniswap: 'Uniswap',
  kyberswap: 'KyberSwap',
  aerodrome: 'Aerodrome',
};

export function swapProviderDisplayNameV1(providerId: string): string {
  const known = SWAP_PROVIDER_DISPLAY_NAME_V1[providerId];
  if (known) return known;
  // An unknown id is shown as-is rather than hidden: a provider the front end
  // has not been taught about still answered or failed, and the run is more
  // honest naming it than dropping it.
  return providerId.length > 0 ? providerId : 'unknown provider';
}

/**
 * The safe, user-facing reason taxonomy.
 *
 * These are the codes the SURFACE reasons about. They are deliberately coarser
 * than the adapter-level `errorCode`s: an adapter distinguishes "the quote
 * named an asset we did not ask for" from "the JSON did not parse", and a user
 * cannot act differently on those two. What a user can act on is "this answer
 * could not be verified".
 */
export type SwapDiagnosticReasonV1 =
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_invalid_schema'
  | 'provider_not_configured'
  | 'provider_preflight_failed'
  | 'no_route'
  | 'amount_too_small'
  | 'unsupported_pair'
  | 'unsupported_chain'
  | 'stale_quote'
  | 'rpc_unavailable'
  | 'unknown';

/**
 * Adapter `errorCode` → the surface taxonomy.
 *
 * Every mapping here is a deliberate loss of precision, so each one is worth
 * stating:
 *
 *   asset_mismatch, router_mismatch and the engine_* validation codes all mean
 *   "the provider answered, and Miorail refused the answer". `router_mismatch`
 *   is kept separate as a preflight failure because it is the one case where
 *   the refusal is about the CONTRACT the calls would target, which is a safety
 *   property rather than a data-quality one.
 */
const REASON_BY_ERROR_CODE_V1: Record<string, SwapDiagnosticReasonV1> = {
  provider_timeout: 'provider_timeout',
  provider_rate_limited: 'provider_rate_limited',
  provider_http_error: 'provider_http_error',
  provider_invalid_schema: 'provider_invalid_schema',
  provider_asset_mismatch: 'provider_invalid_schema',
  provider_not_configured: 'provider_not_configured',
  provider_router_mismatch: 'provider_preflight_failed',
  provider_no_route: 'no_route',
  provider_unsupported_intent: 'unsupported_pair',
  provider_chain_mismatch: 'unsupported_chain',
  provider_expired_quote: 'stale_quote',
  provider_unreachable: 'rpc_unavailable',
  // Not currently emitted by any adapter. Kept mapped so that when an adapter
  // does start reporting a minimum, the surface already has words for it
  // instead of falling through to "could not be verified".
  provider_amount_too_small: 'amount_too_small',
  amount_too_small: 'amount_too_small',
  // Engine-side refusals of an adapter's candidate. From a user's point of
  // view these are indistinguishable from a malformed response, because they
  // are: the provider replied and the reply did not survive validation.
  engine_schema_validation_failed: 'provider_invalid_schema',
  adapter_unhandled_exception: 'provider_invalid_schema',
};

export function swapDiagnosticReasonV1(errorCode: string): SwapDiagnosticReasonV1 {
  const mapped = REASON_BY_ERROR_CODE_V1[errorCode];
  if (mapped) return mapped;
  // Every `engine_*` code is a validation refusal, and new ones get added as
  // the engine's checks grow. Matching the prefix keeps a new check from
  // silently degrading to "unknown".
  if (errorCode.startsWith('engine_')) return 'provider_invalid_schema';
  return 'unknown';
}

/** The short phrase for the table's Reason column. No sentence, no advice —
 * this sits next to a provider name in a narrow cell. */
export const SWAP_DIAGNOSTIC_LABEL_V1: Record<SwapDiagnosticReasonV1, string> = {
  provider_timeout: 'timeout',
  provider_rate_limited: 'rate limited',
  provider_http_error: 'HTTP error',
  provider_invalid_schema: 'invalid schema',
  provider_not_configured: 'not configured',
  provider_preflight_failed: 'preflight failed',
  no_route: 'no route',
  amount_too_small: 'amount too small',
  unsupported_pair: 'unsupported pair',
  unsupported_chain: 'unsupported chain',
  stale_quote: 'quote expired',
  rpc_unavailable: 'RPC unavailable',
  unknown: 'unreported',
};

/** What the user can do about it, if anything. Drives whether the screen
 * offers "Compare again" as a remedy for THIS row. */
export function swapDiagnosticRetryableV1(reason: SwapDiagnosticReasonV1): boolean {
  return (
    reason === 'provider_timeout' ||
    reason === 'provider_rate_limited' ||
    reason === 'rpc_unavailable' ||
    reason === 'stale_quote' ||
    reason === 'provider_http_error'
  );
}

/**
 * The sentence.
 *
 * `stillWorks` is the clause that keeps a single provider's failure from
 * reading as an outage. It is built from what actually answered on this run —
 * never asserted. When nothing answered there is no such clause, because
 * claiming one would be false.
 */
function stillWorksClauseV1(answeredNames: readonly string[]): string {
  if (answeredNames.length === 0) return '';
  if (answeredNames.length === 1) return ` ${answeredNames[0]} comparison still completed.`;
  const list = `${answeredNames.slice(0, -1).join(', ')} and ${answeredNames[answeredNames.length - 1]}`;
  return ` ${list} still answered.`;
}

export interface SwapDiagnosticMessageInputV1 {
  providerName: string;
  reason: SwapDiagnosticReasonV1;
  /** Display names of the providers that DID answer on this run. */
  answered: readonly string[];
}

export function swapDiagnosticMessageV1(input: SwapDiagnosticMessageInputV1): string {
  const { providerName: name, reason } = input;
  const stillWorks = stillWorksClauseV1(input.answered);
  switch (reason) {
    case 'provider_timeout':
      return `${name} did not answer before the timeout.${stillWorks}`;
    case 'provider_rate_limited':
      return `${name} is rate limiting Miorail right now.${stillWorks} Comparing again in a minute usually clears it.`;
    case 'provider_http_error':
      return `${name} refused the request.${stillWorks} This is on the provider's side, not your goal.`;
    case 'provider_invalid_schema':
      return `${name} returned a response this version of Miorail could not verify.${stillWorks} Nothing from it was used.`;
    case 'provider_not_configured':
      return `${name} is not configured on this server, so it was never asked.${stillWorks}`;
    case 'provider_preflight_failed':
      return `${name} preflight could not verify the router on Base, so no calls were built from it.${stillWorks}`;
    case 'no_route':
      return `${name} found no route for this amount.${stillWorks} A slightly larger amount often routes.`;
    case 'amount_too_small':
      return `The amount is below ${name}'s minimum.${stillWorks} Try a larger amount.`;
    case 'unsupported_pair':
      return `${name} does not support this pair.${stillWorks}`;
    case 'unsupported_chain':
      return `${name} answered for a different chain, so its quote was discarded.${stillWorks} Miorail only routes on Base.`;
    case 'stale_quote':
      return `The ${name} quote expired before it could be used. Compare again to receive fresh terms.`;
    case 'rpc_unavailable':
      return `${name} could not be reached over the network.${stillWorks}`;
    case 'unknown':
      // Deliberately does not invent a cause. "Something went wrong" is worse
      // than saying plainly that the provider gave no reason.
      return `${name} did not answer and reported no reason.${stillWorks}`;
  }
}

/** The wire shape, structurally — lib/ui never imports a contract package. */
export interface SwapProviderFailureLikeV1 {
  provider: string;
  errorCode: string;
  outcome?: string;
  retryable?: boolean;
}

export interface ProviderFailureViewV1 {
  providerId: string;
  providerName: string;
  reason: SwapDiagnosticReasonV1;
  /** Short phrase for a table cell. */
  reasonLabel: string;
  /** Full sentence: what happened, what still works, what to do. */
  message: string;
  /** Whether comparing again could plausibly change this outcome. */
  retryable: boolean;
}

export function providerFailureViewV1(
  failure: SwapProviderFailureLikeV1,
  answered: readonly string[] = [],
): ProviderFailureViewV1 {
  const providerName = swapProviderDisplayNameV1(failure.provider);
  const reason = swapDiagnosticReasonV1(failure.errorCode);
  return {
    providerId: failure.provider,
    providerName,
    reason,
    reasonLabel: SWAP_DIAGNOSTIC_LABEL_V1[reason],
    message: swapDiagnosticMessageV1({ providerName, reason, answered }),
    // The server's own `retryable` wins when it sent one: the adapter knows
    // more about its provider than this table does.
    retryable: failure.retryable ?? swapDiagnosticRetryableV1(reason),
  };
}

export function providerFailureViewsV1(
  failures: readonly SwapProviderFailureLikeV1[],
  answered: readonly string[] = [],
): ProviderFailureViewV1[] {
  return failures.map((failure) => providerFailureViewV1(failure, answered));
}

// --- §3.4: what the comparison may claim -------------------------------------

export type ComparisonClaimV1 = 'comparative' | 'single_route' | 'none';

export interface ComparisonClaimViewV1 {
  claim: ComparisonClaimV1;
  /** The line shown where a recommendation would otherwise go. */
  headline: string | null;
}

/**
 * Whether this run earned the right to recommend anything.
 *
 * One valid candidate is not a comparison. Calling it "best route" or "highest
 * expected output" would be a superlative over a set of one — technically true
 * and read by every user as "we checked the alternatives". Execution is still
 * allowed; that decision belongs to the Safety Kernel and the simulation gates,
 * not to this line of text.
 */
export function comparisonClaimV1(quotableCount: number): ComparisonClaimViewV1 {
  if (quotableCount >= 2) return { claim: 'comparative', headline: null };
  if (quotableCount === 1) {
    return { claim: 'single_route', headline: 'Single route available · no comparative recommendation' };
  }
  return { claim: 'none', headline: 'No route was produced for this goal.' };
}
