import {
  resolveB20PoolV1,
  type B20PoolResultV1,
  type B20PoolV1,
  type RawLogV1,
} from './uniswap-v4-pool.js';
import { quoteV4ExactInputV1 } from './uniswap-v4-quoter.js';

// ---------------------------------------------------------------------------
// The round trip, on the venue B20 tokens actually trade on.
//
// Entry then exit, because a price to get IN is not the question. A pool can
// quote one USDC happily and give back a third of it on the way out, and the
// only way to know is to ask both directions at the size someone would
// actually hold. Measured on mainnet: `summer` costs 3.8× more per ETH at ten
// ETH than at one, and 31× at a hundred. That collapse is the product.
//
// Two quotes, not a ladder. The ladder belongs to the capacity search that
// already exists downstream; this answers the prior question — is there a
// round trip at this position at all — for the price of two `eth_call`s on an
// endpoint that meters them.
//
// The pool is resolved once and handed in, so a caller measuring many tokens
// pays one lookup each rather than one per direction.
// ---------------------------------------------------------------------------

export interface B20RoundTripInputV1 {
  pool: B20PoolV1;
  /** The position, in the QUOTE asset's atomic units — what a holder puts in. */
  positionAtomic: string;
  call: (request: { to: string; data: string }) => Promise<string>;
}

export interface B20RoundTripV1 {
  entryRouteFound: boolean;
  exitRouteFound: boolean;
  /** Tokens received for `positionAtomic`. */
  entryOutputAtomic: string | null;
  /** Quote asset returned for those tokens. */
  exitReturnAtomic: string | null;
  /** How much of the position came back, in basis points. Null unless both
   * directions answered — a round trip with one leg missing has no cost. */
  roundTripBps: number | null;
  /** True when a leg went unanswered by the ENDPOINT. The `*RouteFound` flags
   * are then absences of evidence, not evidence of absence, and no verdict
   * about the token may be drawn from them. */
  endpointDegraded: boolean;
  /** `eth_call`s spent, so the caller can pace an endpoint that meters them. */
  quotesUsed: number;
}

/**
 * One round trip through a v4 pool.
 *
 * `zeroForOne` is derived from where the token sits in the key rather than
 * assumed: v4 orders currencies by address, so the B20 token is currency0 in
 * some pools and currency1 in others, and guessing would quote the wrong
 * direction in half of them.
 */
export async function b20RoundTripV4V1(input: B20RoundTripInputV1): Promise<B20RoundTripV1> {
  const { pool } = input;
  // Entry spends the quote asset, so the input currency is whichever one the
  // token is NOT.
  const entryZeroForOne = !pool.tokenIsCurrency0;

  const entry = await quoteV4ExactInputV1({
    key: pool.key,
    zeroForOne: entryZeroForOne,
    exactAmountAtomic: BigInt(input.positionAtomic),
    call: input.call,
  });
  if (!entry.ok) {
    return {
      entryRouteFound: false,
      exitRouteFound: false,
      entryOutputAtomic: null,
      exitReturnAtomic: null,
      roundTripBps: null,
      endpointDegraded: entry.refusal === 'endpoint_unavailable',
      quotesUsed: 1,
    };
  }

  const exit = await quoteV4ExactInputV1({
    key: pool.key,
    zeroForOne: !entryZeroForOne,
    exactAmountAtomic: BigInt(entry.amountOutAtomic),
    call: input.call,
  });
  if (!exit.ok) {
    // Entry priced, exit did not. That is the worst answer a holder can get
    // and it must be reported as such, not rounded to "no route" — unless the
    // endpoint simply did not answer, in which case it is not an answer at all
    // and the flag below stops it being read as one.
    return {
      entryRouteFound: true,
      exitRouteFound: false,
      entryOutputAtomic: entry.amountOutAtomic,
      exitReturnAtomic: null,
      roundTripBps: null,
      endpointDegraded: exit.refusal === 'endpoint_unavailable',
      quotesUsed: 2,
    };
  }

  const position = BigInt(input.positionAtomic);
  const returned = BigInt(exit.amountOutAtomic);
  // Cost of the round trip, in bps of the position. Integer arithmetic
  // throughout: these are atomic amounts, and a float here would round money.
  // Clamped at zero — a pool that returns more than it took is not a negative
  // cost anyone should be shown.
  const lostBps = position > 0n && returned < position
    ? Number(((position - returned) * 10_000n) / position)
    : 0;

  return {
    entryRouteFound: true,
    exitRouteFound: true,
    entryOutputAtomic: entry.amountOutAtomic,
    exitReturnAtomic: exit.amountOutAtomic,
    roundTripBps: lostBps,
    endpointDegraded: false,
    quotesUsed: 2,
  };
}

export interface B20ExitSizeQuotesInputV1 {
  pool: B20PoolV1;
  /** Sizes to sell, in the TOKEN's atomic units. The caller chooses them; this
   * function has no opinion about ladders. */
  sizes: readonly string[];
  /** A size already priced elsewhere — the round trip's exit quote — so the
   * same `eth_call` is not bought twice on a metered endpoint. */
  known?: { sizeAtomic: string; outputAtomic: string | null };
  call: (request: { to: string; data: string }) => Promise<string>;
}

export interface B20ExitSizeQuotesV1 {
  /** One entry per size asked for, in the order given. `outputAtomic` is null
   * where the pool would not price the sale — never zero, which would read as
   * a measured price of nothing. */
  quotes: { sizeAtomic: string; outputAtomic: string | null }[];
  quotesUsed: number;
  /** True when the endpoint stopped answering. The quotes gathered before that
   * are real; the sizes after it were never asked. */
  endpointDegraded: boolean;
}

/**
 * Prices a set of exit sizes against one pool.
 *
 * Deliberately says nothing about capacity, slippage or tolerance — it reports
 * what the pool answered at each size and stops. Turning those into a capacity
 * boundary is the rail's job and already exists there; duplicating the
 * judgement next to the venue would give the same question two answers.
 *
 * On an unanswered endpoint it STOPS. Continuing would spend the rest of the
 * ladder's budget to collect more silence, and a ladder with holes in it
 * invites reading a gap as a price wall.
 */
export async function b20QuoteExitSizesV4V1(
  input: B20ExitSizeQuotesInputV1,
): Promise<B20ExitSizeQuotesV1> {
  // Selling the token: the input currency is the token itself.
  const zeroForOne = input.pool.tokenIsCurrency0;
  const quotes: { sizeAtomic: string; outputAtomic: string | null }[] = [];
  let quotesUsed = 0;

  for (const sizeAtomic of input.sizes) {
    if (input.known && input.known.sizeAtomic === sizeAtomic) {
      quotes.push({ sizeAtomic, outputAtomic: input.known.outputAtomic });
      continue;
    }
    const size = BigInt(sizeAtomic);
    if (size <= 0n) {
      quotes.push({ sizeAtomic, outputAtomic: null });
      continue;
    }
    const quote = await quoteV4ExactInputV1({
      key: input.pool.key,
      zeroForOne,
      exactAmountAtomic: size,
      call: input.call,
    });
    quotesUsed += 1;
    if (!quote.ok && quote.refusal === 'endpoint_unavailable') {
      return { quotes, quotesUsed, endpointDegraded: true };
    }
    quotes.push({ sizeAtomic, outputAtomic: quote.ok ? quote.amountOutAtomic : null });
  }

  return { quotes, quotesUsed, endpointDegraded: false };
}

/**
 * A pool lookup that remembers, for one measurement pass.
 *
 * The resolver costs two `eth_getLogs`, and the endpoint's plan caps those at
 * ten blocks each — repeating them per token per pass would spend the budget
 * on a fact that cannot change. Deliberately in-memory and pass-scoped: a
 * durable cache belongs in the database next to the launch, and pretending
 * this is one would be a claim about persistence it does not make.
 *
 * The result keeps its refusal, so a caller can tell "this token has no pool"
 * from "the endpoint did not answer". Only the first is a measurement.
 */
export function createB20PoolCacheV1(getLogs: (query: {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: (string | null)[];
}) => Promise<readonly RawLogV1[]>) {
  const known = new Map<string, B20PoolResultV1>();
  return {
    async lookup(token: string, launchBlock: number): Promise<B20PoolResultV1> {
      const key = token.toLowerCase();
      const cached = known.get(key);
      if (cached !== undefined) return cached;
      const result = await resolveB20PoolV1({ token, launchBlock, getLogs });
      // A miss is cached too. "This token has no v4 pool" is as worth
      // remembering as the pool itself, and re-asking would spend the same
      // metered budget to learn the same nothing.
      //
      // An unanswered endpoint is NOT cached: nothing was learned about the
      // token, and remembering it would turn one rate-limited request into a
      // verdict that outlives the outage for the whole pass.
      if (result.ok || result.refusal !== 'endpoint_unavailable') known.set(key, result);
      return result;
    },
    get size(): number {
      return known.size;
    },
  };
}
