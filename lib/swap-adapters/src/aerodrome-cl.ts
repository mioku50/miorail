import { selectorV1 } from './aerodrome-pinned.js';

// ---------------------------------------------------------------------------
// Aerodrome concentrated liquidity — where the money for tokenized stocks is.
//
// The Market Route Coverage Audit found the Aerodrome adapter quoting NVDAc at
// $295 a token at $100 and $76,263 a token at $100,000, while KyberSwap held
// flat at ~$219 across the whole ladder. Neither was wrong about the pool it
// read. They were reading different pools:
//
//   the adapter          the v2 Router's `getAmountsOut`, over stable/volatile
//                        pools — which for these pairs hold dust
//   KyberSwap            an Aerodrome CONCENTRATED-LIQUIDITY pool holding
//                        $817,924 USDC and 3,534.62 NVDAc, about $1.6M
//
// Base names Aerodrome as the DEX for tokenized stocks, so an Aerodrome answer
// that silently excludes the venue holding the liquidity is the worst kind of
// wrong: confident, well-formed, and off by two orders of magnitude.
//
// WHAT THIS MODULE DOES NOT DO
//
// It does not price. A concentrated-liquidity quote has to walk initialised
// ticks, and the canonical Aerodrome QuoterV2 cannot help: it is bound to
// factory 0x5e7BB104, which holds NO pool for any reviewed stock (measured,
// every tick spacing, 2026-08-31). Deriving a price from pool state by hand
// would produce a number nobody can check, and a wrong number is worse here
// than a named absence — that is the whole premise of this product.
//
// So it establishes EXISTENCE and DEPTH, from plain reads, and lets the
// adapter refuse honestly instead of answering for a venue it cannot see.
//
// TWO FACTORIES, ONE VOTER
//
// Measured 2026-08-31: Aerodrome runs two CL factory deployments on Base. Both
// return the same `voter()` — Aerodrome's own — and different
// `poolImplementation()`. Every reviewed stock pool lives in the SECOND one,
// which is exactly why a scan of the canonical factory finds nothing and
// concludes, wrongly, that Aerodrome has no CL market here.
// ---------------------------------------------------------------------------

/**
 * Both Aerodrome CL factories on Base, in the order they are searched.
 *
 * Pinned as a pair rather than one, because picking either alone gives a false
 * answer for half the corpus. Each was confirmed to be Aerodrome by reading
 * `voter()` off the factory itself.
 */
export const AERODROME_CL_FACTORIES_V1: readonly `0x${string}`[] = [
  // The deployment that actually holds every reviewed tokenized-stock pool.
  // First because the search stops at the first funded pool, so ordering is
  // purely how many RPC calls the common case costs — never which answer is
  // correct. Both factories are always reachable.
  '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef',
  // Canonical Slipstream. The published SwapRouter, QuoterV2 and position
  // manager all point here; it holds no reviewed stock pool.
  '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',
];

/** Aerodrome's Voter, which both factories name. A factory that does not
 * return this address is not Aerodrome's, whatever it was called. */
export const AERODROME_VOTER_V1 = '0x16613524e02ad97edfef371bc883f2f5d6c480a5' as const;

/**
 * Tick spacings searched for a pool.
 *
 * Aerodrome's published set. A pair can have a pool at more than one — NVDAc
 * and AAPLc each have two — so every one is asked and all hits are returned;
 * taking the first would report a shallower pool as the venue.
 */
export const AERODROME_CL_TICK_SPACINGS_V1: readonly number[] = [1, 10, 50, 100, 200, 2000];

export const AERODROME_CL_GET_POOL_SELECTOR_V1 = selectorV1('getPool(address,address,int24)');
export const AERODROME_CL_TICK_SPACING_SELECTOR_V1 = selectorV1('tickSpacing()');
export const AERODROME_CL_FEE_SELECTOR_V1 = selectorV1('fee()');
export const AERODROME_CL_BALANCE_OF_SELECTOR_V1 = selectorV1('balanceOf(address)');

const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';

/** One CL pool, as read. Nothing here is derived or assumed. */
export interface AerodromeClPoolV1 {
  factory: `0x${string}`;
  pool: `0x${string}`;
  tickSpacing: number;
  /** Both token balances the pool custodies, at the block that was read. This
   * is CUSTODY, not tradeable depth — concentrated liquidity can sit entirely
   * outside the current price. It is enough to tell a dust pool from a real
   * one, which is the question this module exists to answer. */
  tokenABalanceAtomic: string;
  tokenBBalanceAtomic: string;
}

export type AerodromeClLookupV1 =
  | { ok: true; pools: AerodromeClPoolV1[] }
  /** The reads did not complete. NOT the same as "no pool exists", and kept
   * apart so an RPC failure can never be rendered as an empty market. */
  | { ok: false; reason: 'not_configured' | 'unavailable' };

export interface AerodromeClReaderV1 {
  findPools(input: {
    tokenA: `0x${string}`;
    tokenB: `0x${string}`;
    /**
     * Stop at the first funded pool (the default).
     *
     * The quote path only needs to know whether a CL market exists, and every
     * probe past the one that proves it is a wasted RPC call. Pass `false` to
     * enumerate — that is for evidence, not for the guard.
     */
    stopAtFirstMarket?: boolean;
  }): Promise<AerodromeClLookupV1>;
}

function encodeAddressPairAndTickV1(a: string, b: string, tickSpacing: number): `0x${string}` {
  const word = (value: string) => value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  // int24 is sign-extended; every reviewed spacing is positive, so a plain
  // left-pad is correct and a negative one is not representable here by design.
  const tick = tickSpacing.toString(16).padStart(64, '0');
  return `0x${AERODROME_CL_GET_POOL_SELECTOR_V1}${word(a)}${word(b)}${tick}`;
}

function addressFromWordV1(data: string): `0x${string}` | null {
  const hex = data.replace(/^0x/, '');
  if (hex.length < 40) return null;
  const address = `0x${hex.slice(-40)}`.toLowerCase();
  return address === ZERO_ADDRESS_V1 ? null : (address as `0x${string}`);
}

export interface AerodromeClRpcV1 {
  /** A plain `eth_call`. Injected so tests never open a socket, and so the
   * caller owns timeouts and endpoint secrecy. */
  call(input: { to: `0x${string}`; data: `0x${string}` }): Promise<string | null>;
}

/**
 * Pools for one pair, across both factories and every reviewed tick spacing.
 *
 * A read that does not complete returns `unavailable` for the WHOLE lookup
 * rather than a shorter list. A partial scan reported as a complete one is how
 * "Aerodrome has no CL pool here" gets said about a pool that exists.
 */
export function createAerodromeClReaderV1(rpc: AerodromeClRpcV1): AerodromeClReaderV1 {
  return {
    async findPools(input) {
      const pools: AerodromeClPoolV1[] = [];
      for (const factory of AERODROME_CL_FACTORIES_V1) {
        for (const tickSpacing of AERODROME_CL_TICK_SPACINGS_V1) {
          const data = encodeAddressPairAndTickV1(input.tokenA, input.tokenB, tickSpacing);
          let raw: string | null;
          try {
            raw = await rpc.call({ to: factory, data });
          } catch {
            return { ok: false, reason: 'unavailable' };
          }
          if (raw === null) return { ok: false, reason: 'unavailable' };
          const pool = addressFromWordV1(raw);
          if (!pool) continue;

          const balances: string[] = [];
          for (const token of [input.tokenA, input.tokenB]) {
            let balance: string | null;
            try {
              balance = await rpc.call({
                to: token,
                data: `0x${AERODROME_CL_BALANCE_OF_SELECTOR_V1}${pool.replace(/^0x/, '').padStart(64, '0')}`,
              });
            } catch {
              return { ok: false, reason: 'unavailable' };
            }
            if (balance === null || balance === '0x') return { ok: false, reason: 'unavailable' };
            balances.push(BigInt(balance).toString());
          }
          pools.push({
            factory,
            pool,
            tickSpacing,
            tokenABalanceAtomic: balances[0]!,
            tokenBBalanceAtomic: balances[1]!,
          });
          // The caller's question is "is there a CL market here", and one
          // funded pool answers it. Every extra probe past that is an RPC call
          // spent on a question already settled — and this runs on the quote
          // path, where a dozen sequential reads is the difference between an
          // adapter that answers and one that times out.
          //
          // This makes `pools` a WITNESS, not an inventory. Anything that needs
          // the full set has to ask for it, and no caller may read the length
          // of this list as a pool count.
          if (input.stopAtFirstMarket !== false && aerodromeClHasMarketV1(pools)) {
            return { ok: true, pools };
          }
        }
      }
      return { ok: true, pools };
    },
  };
}

/**
 * Does a CL pool custody enough of BOTH sides to be the venue for this pair?
 *
 * Both sides, because a pool holding one token and none of the other cannot
 * price a swap between them, and counting it would make the adapter refuse on
 * evidence of nothing. Zero is the only threshold used: any positive balance on
 * both sides means there is a CL market the v2 Router cannot see, and picking a
 * larger cutoff would be a market judgement this module has no standing to make.
 */
export function aerodromeClHasMarketV1(pools: readonly AerodromeClPoolV1[]): boolean {
  return pools.some(
    (pool) => BigInt(pool.tokenABalanceAtomic) > 0n && BigInt(pool.tokenBBalanceAtomic) > 0n,
  );
}

/**
 * A CL reader that borrows an existing Aerodrome reader's transport.
 *
 * Not a convenience. The Base public endpoint serves roughly half a call per
 * second, a CL lookup issues up to a dozen, and the reader already carries the
 * adaptive pacing that survives that — measured: the same scan answers
 * `unavailable` unpaced and finds $814,421 of NVDAc liquidity when paced.
 * Building a second transport here would mean a second thing to configure and a
 * second pacing policy to get wrong.
 *
 * Returns null when the reader is too old to expose a raw call, so a caller
 * that cannot look is simply given no guard rather than a false negative.
 */
export function aerodromeClReaderFromReaderV1(reader: {
  readCall?(input: {
    to: `0x${string}`;
    data: `0x${string}`;
  }): Promise<{ ok: true; value: string } | { ok: false; reason: string }>;
}): AerodromeClReaderV1 | null {
  const readCall = reader.readCall?.bind(reader);
  if (!readCall) return null;
  return createAerodromeClReaderV1({
    async call(input) {
      const result = await readCall(input);
      return result.ok ? result.value : null;
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 17.5 — the adapter stops being useless without becoming a quoter.
//
// The finding above is settled and does not change: there is no verifiable
// quoter for the factory that holds these pools. The deployer of factory #2
// (0x2BbFA3f31b12D7a773B2058Ac74659C8db891624) shipped three identical
// seven-contract Slipstream cores — pool implementation, factory, gauge
// implementation, gauge factory, a voting/rewards factory, a token descriptor
// and the position manager — and NEITHER a QuoterV2 nor a SwapRouter is among
// them. Measured by scanning each candidate's bytecode for
// `quoteExactInputSingle((address,address,uint256,int24,uint160))` and
// `exactInputSingle(...)`: false on all of them. The published QuoterV2 binds
// factory #1 through a different `poolImplementation()`, so its init-code hash
// cannot address a factory #2 pool. Writing tick math by hand would produce a
// number nobody can check, which this product exists not to do.
//
// So the adapter is upgraded into a CORROBORATOR instead.
//
// `slot0().sqrtPriceX96` is the pool's own current price, one word, one read.
// Squaring it and shifting by 2^192 is arithmetic a reader can redo on paper
// from the same block. It is the MARGINAL price at the current tick — the
// price of an infinitesimal trade — and it is therefore NOT a quote:
//
//   * no size            it is the limit as size goes to zero
//   * no slippage        a real trade walks ticks this read never looks at
//   * no route           one pool, not a path
//   * no executability   nothing here says the trade would succeed
//
// Every one of those absences is stated in the returned value rather than left
// to a caller's discretion, because the whole value of this reading is that it
// is a SECOND, INDEPENDENT one. Today every `full` observation on the entire
// tokenized-stock corpus comes from a single source; a number computed from the
// pool's own state next to a number an aggregator reported is the only
// cross-check this surface has ever had. A disagreement between them is itself
// a finding.
// ---------------------------------------------------------------------------

export const AERODROME_CL_SLOT0_SELECTOR_V1 = selectorV1('slot0()');
export const AERODROME_CL_TOKEN0_SELECTOR_V1 = selectorV1('token0()');
export const AERODROME_CL_TOKEN1_SELECTOR_V1 = selectorV1('token1()');
export const AERODROME_CL_FACTORY_SELECTOR_V1 = selectorV1('factory()');
export const AERODROME_CL_VOTER_SELECTOR_V1 = selectorV1('voter()');
export const AERODROME_CL_DECIMALS_SELECTOR_V1 = selectorV1('decimals()');

/**
 * The pool's own price, and everything needed to recompute it.
 *
 * `sqrtPriceX96` is carried verbatim beside the derived figure on purpose: the
 * derived one is ours, and the raw one is the pool's. A reader who distrusts
 * our arithmetic can redo it, and a reader who distrusts our read can call
 * `slot0()` themselves at the same block.
 */
export interface AerodromeClSpotV1 {
  pool: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  /** Decimal string. The pool's raw Q64.96 square-root price. */
  sqrtPriceX96: string;
  /** Price of ONE whole token0, denominated in whole token1. */
  token1PerToken0: string;
  /** Price of ONE whole token1, denominated in whole token0. */
  token0PerToken1: string;
  /** The block every field above was read at. Two reads at two blocks are two
   * facts, and this states one. */
  blockTag: string | null;
}

/** How many decimal places the derived prices carry. Enough to be checkable,
 * not so many that it implies a precision the read does not have. */
const SPOT_SCALE_V1 = 10n ** 18n;
const SPOT_DIGITS_V1 = 18;

function fixedV1(scaled: bigint): string {
  const whole = scaled / SPOT_SCALE_V1;
  const fraction = (scaled % SPOT_SCALE_V1).toString().padStart(SPOT_DIGITS_V1, '0');
  // Trailing zeros carry no information and imply a precision that is not
  // there. A value that is exactly whole keeps no decimal point at all.
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

/**
 * Marginal price from a square-root price, in exact integer arithmetic.
 *
 * price(token1 per token0) = (sqrtPriceX96 / 2^96)^2, then adjusted for the two
 * tokens' decimals. Done with bigints throughout: a float here would make the
 * last digits of a "checkable" number depend on IEEE rounding, and the entire
 * point of publishing this figure is that somebody else can arrive at it.
 *
 * Returns null on anything that cannot produce a price — a zero square-root
 * price means the pool has never been initialised, which is an absence, not a
 * price of zero.
 */
export function aerodromeClSpotPriceV1(input: {
  sqrtPriceX96: bigint;
  token0Decimals: number;
  token1Decimals: number;
}): { token1PerToken0: string; token0PerToken1: string } | null {
  const { sqrtPriceX96, token0Decimals, token1Decimals } = input;
  if (sqrtPriceX96 <= 0n) return null;
  if (!Number.isInteger(token0Decimals) || token0Decimals < 0 || token0Decimals > 36) return null;
  if (!Number.isInteger(token1Decimals) || token1Decimals < 0 || token1Decimals > 36) return null;

  const Q192 = 1n << 192n;
  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(token0Decimals) * SPOT_SCALE_V1;
  const denominator = Q192 * 10n ** BigInt(token1Decimals);
  const token1PerToken0Scaled = numerator / denominator;
  if (token1PerToken0Scaled <= 0n) return null;
  // Inverted from the same two integers rather than from the rounded decimal
  // above: dividing a printed string would compound our own rounding into the
  // second figure and make the pair internally inconsistent.
  const token0PerToken1Scaled = (denominator * SPOT_SCALE_V1) / (sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(token0Decimals));
  if (token0PerToken1Scaled <= 0n) return null;
  return {
    token1PerToken0: fixedV1(token1PerToken0Scaled),
    token0PerToken1: fixedV1(token0PerToken1Scaled),
  };
}

/** The first 32-byte word of a return payload, as a bigint. Null on anything
 * too short to be one. */
function firstWordV1(data: string): bigint | null {
  const hex = data.replace(/^0x/, '');
  if (hex.length < 64 || !/^[0-9a-f]+$/i.test(hex.slice(0, 64))) return null;
  return BigInt(`0x${hex.slice(0, 64)}`);
}

export type AerodromeClSpotResultV1 =
  | { ok: true; spot: AerodromeClSpotV1 }
  /**
   * Why there is no reading. Kept apart because they are different findings:
   * a pool that is not Aerodrome's is a statement about the address somebody
   * gave us, and a read that did not complete is a statement about us.
   */
  | {
      ok: false;
      reason:
        | 'not_aerodrome_cl'
        | 'not_initialised'
        /** The pool has a price and it is smaller than eighteen decimal places
         * can show. Its own state is fine; OURS is what ran out. Kept apart
         * from `not_initialised` because one is a fact about the pool and the
         * other is a fact about this function. */
        | 'below_published_precision'
        | 'unreadable';
    };

/**
 * Read one pool's own marginal price, having first proved it is Aerodrome's.
 *
 * The proof is two reads and is not optional: an arbitrary address answering
 * `slot0()` in the right shape would otherwise be published as an Aerodrome
 * price. `factory()` must be one of the two pinned CL factories, and that
 * factory must name Aerodrome's own Voter — the same check `AERODROME_VOTER_V1`
 * exists for, applied to the pool rather than to a scan.
 */
export async function readAerodromeClSpotV1(input: {
  rpc: AerodromeClRpcV1;
  pool: `0x${string}`;
  blockTag?: string | null;
}): Promise<AerodromeClSpotResultV1> {
  const call = async (to: `0x${string}`, selector: string): Promise<string | null> => {
    try {
      return await input.rpc.call({ to, data: `0x${selector}` as `0x${string}` });
    } catch {
      return null;
    }
  };

  const factoryRaw = await call(input.pool, AERODROME_CL_FACTORY_SELECTOR_V1);
  const factory = factoryRaw === null ? null : addressFromWordV1(factoryRaw);
  if (!factory) return { ok: false, reason: 'unreadable' };
  if (!AERODROME_CL_FACTORIES_V1.includes(factory)) return { ok: false, reason: 'not_aerodrome_cl' };
  const voterRaw = await call(factory, AERODROME_CL_VOTER_SELECTOR_V1);
  const voter = voterRaw === null ? null : addressFromWordV1(voterRaw);
  if (voter !== AERODROME_VOTER_V1) return { ok: false, reason: 'not_aerodrome_cl' };

  const [slot0Raw, token0Raw, token1Raw] = await Promise.all([
    call(input.pool, AERODROME_CL_SLOT0_SELECTOR_V1),
    call(input.pool, AERODROME_CL_TOKEN0_SELECTOR_V1),
    call(input.pool, AERODROME_CL_TOKEN1_SELECTOR_V1),
  ]);
  const token0 = token0Raw === null ? null : addressFromWordV1(token0Raw);
  const token1 = token1Raw === null ? null : addressFromWordV1(token1Raw);
  const sqrtPriceX96 = slot0Raw === null ? null : firstWordV1(slot0Raw);
  if (!token0 || !token1 || sqrtPriceX96 === null) return { ok: false, reason: 'unreadable' };
  // A pool that exists and has never been initialised is a real state, and it
  // is not a price of zero.
  if (sqrtPriceX96 === 0n) return { ok: false, reason: 'not_initialised' };

  const [decimals0Raw, decimals1Raw] = await Promise.all([
    call(token0, AERODROME_CL_DECIMALS_SELECTOR_V1),
    call(token1, AERODROME_CL_DECIMALS_SELECTOR_V1),
  ]);
  const decimals0 = decimals0Raw === null ? null : firstWordV1(decimals0Raw);
  const decimals1 = decimals1Raw === null ? null : firstWordV1(decimals1Raw);
  // Decimals are READ, never assumed. A guessed 18 against a 6-decimal USDC is
  // a price wrong by twelve orders of magnitude that still looks like a price.
  if (decimals0 === null || decimals1 === null || decimals0 > 36n || decimals1 > 36n) {
    return { ok: false, reason: 'unreadable' };
  }

  const price = aerodromeClSpotPriceV1({
    sqrtPriceX96,
    token0Decimals: Number(decimals0),
    token1Decimals: Number(decimals1),
  });
  // sqrtPriceX96 was already proved non-zero above, so a null here is our own
  // scale running out rather than an uninitialised pool.
  if (!price) return { ok: false, reason: 'below_published_precision' };

  return {
    ok: true,
    spot: {
      pool: input.pool,
      token0,
      token1,
      token0Decimals: Number(decimals0),
      token1Decimals: Number(decimals1),
      sqrtPriceX96: sqrtPriceX96.toString(),
      token1PerToken0: price.token1PerToken0,
      token0PerToken1: price.token0PerToken1,
      blockTag: input.blockTag ?? null,
    },
  };
}
