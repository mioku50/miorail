import { resolveB20PoolV1, type B20PoolV1, type RawLogV1 } from './uniswap-v4-pool.js';
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
    // and it must be reported as such, not rounded to "no route".
    return {
      entryRouteFound: true,
      exitRouteFound: false,
      entryOutputAtomic: entry.amountOutAtomic,
      exitReturnAtomic: null,
      roundTripBps: null,
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
    quotesUsed: 2,
  };
}

/**
 * A pool lookup that remembers, for one measurement pass.
 *
 * The resolver costs two `eth_getLogs`, and the endpoint's plan caps those at
 * ten blocks each — repeating them per token per pass would spend the budget
 * on a fact that cannot change. Deliberately in-memory and pass-scoped: a
 * durable cache belongs in the database next to the launch, and pretending
 * this is one would be a claim about persistence it does not make.
 */
export function createB20PoolCacheV1(getLogs: (query: {
  address: string;
  fromBlock: number;
  toBlock: number;
  topics: (string | null)[];
}) => Promise<readonly RawLogV1[]>) {
  const known = new Map<string, B20PoolV1 | null>();
  return {
    async lookup(token: string, launchBlock: number): Promise<B20PoolV1 | null> {
      const key = token.toLowerCase();
      const cached = known.get(key);
      if (cached !== undefined) return cached;
      const result = await resolveB20PoolV1({ token, launchBlock, getLogs });
      const pool = result.ok ? result.pool : null;
      // A miss is cached too. "This token has no v4 pool" is as worth
      // remembering as the pool itself, and re-asking would spend the same
      // metered budget to learn the same nothing.
      known.set(key, pool);
      return pool;
    },
    get size(): number {
      return known.size;
    },
  };
}
