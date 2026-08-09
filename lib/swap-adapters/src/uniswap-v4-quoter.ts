import { selectorV1 } from './aerodrome-pinned.js';
import type { UniswapV4PoolKeyV1 } from './uniswap-v4-pool.js';

// ---------------------------------------------------------------------------
// What a B20 token is worth, measured rather than asked for.
//
// The v4 Quoter simulates the real swap through the real pool, hook included.
// That last part is why nothing simpler works here: every B20 pool carries the
// launch hook 0x985c14ba…, and a hook may take a fee, move a tick, or refuse
// the swap outright. A price computed from reserves would be a guess about
// what the hook does; this is the hook doing it.
//
// It is an `eth_call`, so it moves nothing and costs nothing. The Quoter is
// non-view by design — it reverts to return its answer — which is invisible
// from outside because a call gets the return data either way.
//
// Encoding is by hand, like the Aerodrome integration next door: this package
// deliberately has no viem dependency, and one struct is not a reason to add
// one. The selector is COMPUTED from the signature. A hand-copied four bytes
// is unverifiable by inspection and calls a different function when wrong.
// ---------------------------------------------------------------------------

/**
 * `quoteExactInputSingle(QuoteExactSingleParams)`.
 *
 * Written flat, with the PoolKey inlined as its own tuple, because that is how
 * the ABI hashes it — a signature naming the struct types would produce a
 * selector no contract answers.
 */
export const V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR_V1 = selectorV1(
  'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))',
);

const UINT256_MAX_V1 = (1n << 256n) - 1n;

function word(value: bigint): string {
  if (value < 0n || value > UINT256_MAX_V1) throw new RangeError('word out of range');
  return value.toString(16).padStart(64, '0');
}

function addressWord(address: string): string {
  const bare = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(bare)) throw new TypeError('not an address');
  return bare.padStart(64, '0');
}

/** int24 as two's complement in a 32-byte word. */
function int24Word(value: number): string {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) {
    throw new RangeError('tickSpacing out of int24 range');
  }
  return word(BigInt(value < 0 ? (1n << 256n) + BigInt(value) : BigInt(value)));
}

export interface V4QuoteRequestV1 {
  key: UniswapV4PoolKeyV1;
  /** True to swap currency0 → currency1. */
  zeroForOne: boolean;
  /** Exact input, in the input currency's atomic units. */
  exactAmountAtomic: bigint;
}

/**
 * Calldata for one exact-input quote.
 *
 * The outer parameter is a dynamic tuple — it ends in `bytes` — so the head is
 * a single offset and the body follows. `hookData` is empty: the launch hook
 * observed on B20 pools takes none, and inventing bytes for a hook we have not
 * read would change the very behaviour this call exists to measure.
 */
export function encodeV4QuoteExactInputSingleV1(request: V4QuoteRequestV1): `0x${string}` {
  const { key } = request;
  const body =
    addressWord(key.currency0) +
    addressWord(key.currency1) +
    word(BigInt(key.fee)) +
    int24Word(key.tickSpacing) +
    addressWord(key.hooks) +
    word(request.zeroForOne ? 1n : 0n) +
    word(request.exactAmountAtomic) +
    // Offset to `hookData`, measured from the start of this tuple: eight words
    // precede it.
    word(BigInt(8 * 32)) +
    word(0n);
  // Head: the tuple itself is dynamic, so the argument area holds its offset.
  return `0x${V4_QUOTE_EXACT_INPUT_SINGLE_SELECTOR_V1}${word(BigInt(32))}${body}`;
}

export type V4QuoteRefusalV1 =
  | 'empty_result'
  | 'malformed_result'
  | 'zero_output'
  // The endpoint, not the pool. See `V4QuoteUnavailableError`.
  | 'endpoint_unavailable';

/**
 * Thrown by an injected `call` when the ENDPOINT failed — throttled, timed
 * out, unreachable — as opposed to the pool refusing the swap.
 *
 * The distinction cannot be made from the transport alone: a reverting quote
 * arrives as empty data on one client and as a thrown error on another, so a
 * bare throw stays a refusal. Only a caller that can read its own transport's
 * reason knows the difference, and this is how it says so.
 *
 * It matters more here than anywhere else in the rail: "you cannot sell this
 * token" is the headline this feed exists to publish, and a rate limit shaped
 * like a failed sell would publish it about tokens that sell fine.
 */
export class V4QuoteUnavailableError extends Error {
  constructor(message = 'quote endpoint unavailable') {
    super(message);
    this.name = 'V4QuoteUnavailableError';
  }
}

export type V4QuoteResultV1 =
  | { ok: true; amountOutAtomic: string; gasEstimate: string }
  | { ok: false; refusal: V4QuoteRefusalV1 };

/**
 * Reads `(uint256 amountOut, uint256 gasEstimate)`.
 *
 * A revert arrives as empty return data, and that is the ordinary answer for a
 * pool with no liquidity at this size — reported as a refusal, never as a zero
 * price. A zero output is refused for the same reason: it is the shape of "the
 * swap returns nothing", which is not a quote anyone can act on.
 */
export function decodeV4QuoteResultV1(data: string | null | undefined): V4QuoteResultV1 {
  const bare = (data ?? '').replace(/^0x/, '');
  if (bare.length === 0) return { ok: false, refusal: 'empty_result' };
  if (bare.length < 128 || !/^[0-9a-fA-F]+$/.test(bare)) {
    return { ok: false, refusal: 'malformed_result' };
  }
  const amountOut = BigInt(`0x${bare.slice(0, 64)}`);
  const gasEstimate = BigInt(`0x${bare.slice(64, 128)}`);
  if (amountOut === 0n) return { ok: false, refusal: 'zero_output' };
  return { ok: true, amountOutAtomic: amountOut.toString(), gasEstimate: gasEstimate.toString() };
}

export interface V4QuoteCallInputV1 extends V4QuoteRequestV1 {
  /** Injected. Performs one `eth_call` and returns the raw return data, or an
   * empty string on revert. The caller owns the endpoint, pacing and retries. */
  call: (request: { to: string; data: string }) => Promise<string>;
  /** Defaults to the pinned Base Quoter. */
  quoter?: string;
}

/** One quote, end to end. Kept thin: the encode and decode above are where the
 * behaviour lives, and both are pure. */
export async function quoteV4ExactInputV1(input: V4QuoteCallInputV1): Promise<V4QuoteResultV1> {
  const { UNISWAP_V4_QUOTER_V1 } = await import('./uniswap-v4-pinned.js');
  let data: string;
  try {
    data = await input.call({
      to: input.quoter ?? UNISWAP_V4_QUOTER_V1,
      data: encodeV4QuoteExactInputSingleV1(input),
    });
  } catch (error) {
    // A reverting quote is a liquidity answer, not an outage — and many
    // transports report a revert by throwing, so a bare throw stays an answer.
    // Only the caller can tell the two apart, and it does so with this type.
    if (error instanceof V4QuoteUnavailableError) {
      return { ok: false, refusal: 'endpoint_unavailable' };
    }
    return { ok: false, refusal: 'empty_result' };
  }
  return decodeV4QuoteResultV1(data);
}
