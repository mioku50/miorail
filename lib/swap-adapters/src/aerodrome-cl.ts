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
