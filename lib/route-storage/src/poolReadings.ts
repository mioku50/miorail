import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// What is actually IN the pools that hold a token.
//
// `market_venues` already knew which addresses are pools and which token sits
// on each side. Nothing read what they hold, so Use & access could only answer
// a lending question — four lending venues, three of them `not_listed` — and a
// token whose largest onchain use by a wide margin is an Aerodrome
// concentrated-liquidity pool read as a token with almost no DeFi presence.
//
// The unit here is a READING, not a pool: one row per (pool, token), the newest
// one, carrying both sides' balances at a named block. A reading of a pool is
// about the token you asked about, because "3,740 NVDAc against $1.61m USDC"
// and "1.61m USDC against 3,740 NVDAc" are the same pool and different answers.
//
// What a reading is NOT:
//
//   NOT TVL.       It is the balance the pool contract holds. For a
//                  concentrated-liquidity pool that includes every position,
//                  in range or out, plus uncollected fees.
//   NOT DEPTH.     Nothing here says what a trade of a given size would get.
//                  That question already has an answer elsewhere, measured by
//                  a router quote at an exact size, and this must never be
//                  read as a second opinion on it.
//   NOT A COUNT.   Thirty-nine pools hold NVDAc and twenty-four of them pair it
//                  against a memecoin — 71 NVDAc against 212 million KUMA. A
//                  count is true arithmetic about a market that does not exist,
//                  so the balance is stored and the ranking is by balance.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');
const Digits = z.string().regex(/^\d+$/, 'expected a decimal integer string');

/**
 * The venues we can name, and how each one is decided.
 *
 * A venue is established by reading the chain, never by a label a router or an
 * API handed us: the pool's own `factory()`, and for Aerodrome that factory's
 * `voter()`, which answers only on Aerodrome factories and pins the address to
 * one protocol. Three Aerodrome factories serve these tokens — two
 * concentrated-liquidity and one v2-style pool factory — and the published
 * Aerodrome CL address is NOT the one most tokenized-stock pools sit in, which
 * is exactly why the discriminator has to be a read and not a list.
 *
 * Five factories answered and stayed unnamed for a while, and the fix was more
 * reading rather than a longer address list. A protocol's own ABI is as good a
 * discriminator as its Voter: PancakeSwap v2's factory publishes
 * `INIT_CODE_PAIR_HASH()`, PancakeSwap v3's publishes `lmPoolDeployer()` for
 * its liquidity-mining pools, and Algebra's publishes `defaultPluginFactory()`
 * for the plugin architecture that only Algebra has. None of those methods
 * exists on Uniswap's factories or on each other's.
 *
 * The last two ids name a SHAPE, not a protocol, and say so in their own
 * label. A pool whose factory answers nothing can still be read as
 * concentrated-liquidity or as a constant-product pair, and telling the reader
 * which one it is beats "not identified" — as long as the words never suggest
 * we know whose it is. A brand is never inferred from a string the pool hands
 * us: a pool naming itself `MineSwap LP` proves only what it wrote there.
 */
export const POOL_VENUE_IDS_V1 = [
  'aerodrome_cl',
  'aerodrome_v2',
  'uniswap_v3',
  'pancakeswap_v2',
  'pancakeswap_v3',
  'algebra_cl',
  'unnamed_cl',
  'unnamed_pair',
] as const;
export type PoolVenueIdV1 = (typeof POOL_VENUE_IDS_V1)[number];

/**
 * The label the screen shows. Code-owned: a pool can call itself anything, and
 * a contract-supplied string rendered as our label is a venue a stranger gets
 * to name. The two shape labels carry their own caveat, because a name shown
 * on its own is read as an identification.
 */
export const POOL_VENUE_NAMES_V1: Readonly<Record<PoolVenueIdV1, string>> = {
  aerodrome_cl: 'Aerodrome CL',
  aerodrome_v2: 'Aerodrome',
  uniswap_v3: 'Uniswap v3',
  pancakeswap_v2: 'PancakeSwap v2',
  pancakeswap_v3: 'PancakeSwap v3',
  algebra_cl: 'Algebra CL',
  unnamed_cl: 'Concentrated pool, venue not named',
  unnamed_pair: 'AMM pair, venue not named',
};

/**
 * The ids that describe a SHAPE rather than a protocol.
 *
 * A caller that treats every id as a venue name will write "on Concentrated
 * pool, venue not named" into a sentence and count it among the venues it
 * identified. Both are false in the same way, so the distinction is exported
 * with the ids rather than re-derived by each surface.
 */
export const POOL_VENUE_SHAPE_IDS_V1 = ['unnamed_cl', 'unnamed_pair'] as const;

export function poolVenueIsShapeV1(id: PoolVenueIdV1 | null): boolean {
  return id !== null && (POOL_VENUE_SHAPE_IDS_V1 as readonly string[]).includes(id);
}

export const MarketPoolReadingV1Schema = z
  .object({
    chainId: z.literal(8453),
    poolAddress: Address,
    /** The token this reading is ABOUT. */
    tokenAddress: Address,
    /**
     * Null when the factory answered but is not one we have identified.
     * Unidentified is a state and must reach the screen as one: rendering it
     * as absent would delete a pool that holds real money from the answer.
     */
    venueId: z.enum(POOL_VENUE_IDS_V1).nullable(),
    /** Null when the address answers no `factory()` at all — then it is not a
     * pool in the sense this table means, and the reading records that. */
    factoryAddress: Address.nullable(),
    tokenBalanceAtomic: Digits,
    tokenDecimals: z.number().int().min(0).max(36),
    pairedTokenAddress: Address.nullable(),
    pairedBalanceAtomic: Digits.nullable(),
    pairedDecimals: z.number().int().min(0).max(36).nullable(),
    pairedSymbol: z.string().max(64).nullable(),
    blockNumber: z.number().int().nonnegative(),
    readAt: z.string().datetime(),
  })
  .strict()
  .superRefine((row, ctx) => {
    // All-or-nothing: an amount with no token to denominate it is a half-read
    // pretending to be a reading, and a screen would have to invent the other
    // half to render it.
    const pairedParts = [row.pairedTokenAddress, row.pairedBalanceAtomic, row.pairedDecimals];
    const present = pairedParts.filter((part) => part !== null).length;
    if (present !== 0 && present !== pairedParts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the paired side is address, amount and decimals together or not at all',
      });
    }
    if (row.pairedTokenAddress !== null && row.pairedTokenAddress === row.tokenAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a pool cannot be paired with the token the reading is about',
      });
    }
    // A venue is a conclusion about a factory. Naming one without having read
    // the factory is the guess this whole table exists to refuse.
    if (row.venueId !== null && row.factoryAddress === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a named venue must carry the factory it was read from',
      });
    }
  });

export type MarketPoolReadingV1 = z.infer<typeof MarketPoolReadingV1Schema>;

export function assertMarketPoolReadingV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): MarketPoolReadingV1 {
  const parsed = MarketPoolReadingV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RouteStorageIntegrityError(
    `market pool reading failed validation on ${direction}: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ')}`,
  );
}

export interface MarketPoolReadingRepositoryV1 {
  /**
   * One pass, written as a unit. A reading replaces the previous one for the
   * same (pool, token): the row IS the current fact and carries its own block
   * and clock, exactly like every other measurement in this product.
   */
  recordReadings(input: { readings: readonly MarketPoolReadingV1[] }): Promise<{ written: number }>;

  /**
   * Every pool holding one token, DEEPEST FIRST — the order the screen needs,
   * because ranking by count would put a memecoin pair beside the book that
   * holds the money.
   */
  readingsForToken(input: {
    chainId: number;
    tokenAddress: string;
    limit: number;
  }): Promise<MarketPoolReadingV1[]>;
}
