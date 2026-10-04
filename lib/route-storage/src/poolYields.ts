import { z } from 'zod';

// ---------------------------------------------------------------------------
// What an Aerodrome concentrated-liquidity pool pays, one reading per pass.
//
// A reading is the pool and its gauge at one block: the emission rate for
// the gauge's current week, the fee, in-range and staked liquidity, both
// balances and the price, AERO's dollar price from Chainlink, and the swaps
// since the previous reading. A week of fees is a sum over these rows, so the
// yield is ours to recompute, and no single reading decides it.
// ---------------------------------------------------------------------------

const AddressV1 = z.string().regex(/^0x[0-9a-f]{40}$/);
const DigitsV1 = z.string().regex(/^[0-9]+$/);
const IsoV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

export const PoolYieldReadingV1Schema = z
  .object({
    chainId: z.number().int().positive(),
    poolAddress: AddressV1,
    /** The stock the pool was read for. */
    tokenAddress: AddressV1,
    /** Null when the pool has no gauge: then nothing is emitted to it. */
    gaugeAddress: AddressV1.nullable(),
    blockNumber: z.number().int().positive(),
    /** The block's own timestamp. Time is never derived from a block count:
     * Denim moves Base to 200 ms blocks. */
    blockAt: IsoV1,
    readAt: IsoV1,
    token0Address: AddressV1,
    token1Address: AddressV1,
    decimals0: z.number().int().min(0).max(36),
    decimals1: z.number().int().min(0).max(36),
    balance0Atomic: DigitsV1,
    balance1Atomic: DigitsV1,
    sqrtPriceX96: DigitsV1,
    liquidity: DigitsV1,
    stakedLiquidity: DigitsV1,
    feePips: z.number().int().min(0).max(1_000_000),
    unstakedFeePips: z.number().int().min(0).max(1_000_000),
    /** AERO wei per second for the gauge's current period; "0" with no gauge. */
    rewardRate: DigitsV1,
    /** Unix seconds: when the gauge's current period of emissions ends. */
    periodFinish: z.number().int().nonnegative(),
    aeroUsd: z.number().positive().finite().nullable(),
    aeroUsdUpdatedAt: IsoV1.nullable(),
    /**
     * The swaps in blocks (fromBlock, blockNumber], from `fromAt` to
     * `blockAt`. Null when the logs were not read this pass: null is "not
     * read", never "no swaps".
     */
    swaps: z
      .object({
        fromBlock: z.number().int().nonnegative(),
        fromAt: IsoV1,
        count: z.number().int().nonnegative(),
        amount0InAtomic: DigitsV1,
        amount1InAtomic: DigitsV1,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((reading) => (reading.aeroUsd === null) === (reading.aeroUsdUpdatedAt === null), {
    message: 'an AERO price must carry its time, and a time its price',
  })
  .refine(
    (reading) =>
      reading.swaps === null ||
      (reading.swaps.fromBlock < reading.blockNumber && Date.parse(reading.swaps.fromAt) < Date.parse(reading.blockAt)),
    { message: 'swaps cover blocks before the reading, ending at its block' },
  );

export type PoolYieldReadingV1 = z.infer<typeof PoolYieldReadingV1Schema>;

export function assertPoolYieldReadingV1(input: unknown, direction: 'read' | 'write'): PoolYieldReadingV1 {
  const parsed = PoolYieldReadingV1Schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(
    `pool yield reading failed validation on ${direction}: ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ')}`,
  );
}

export interface PoolYieldReadingRepositoryV1 {
  /** One pass's reading. A second reading at the same block is the same fact
   * and is not stored twice. */
  record(reading: PoolYieldReadingV1): Promise<'recorded' | 'duplicate'>;
  /** One stock's readings at or after a moment, every pool, oldest first:
   * the public read picks the pool whose reading is newest. */
  readingsForTokenSince(input: { chainId: number; tokenAddress: string; since: string }): Promise<PoolYieldReadingV1[]>;
  /** One pool's readings at or after a moment, oldest first. */
  readingsSince(input: { chainId: number; poolAddress: string; since: string }): Promise<PoolYieldReadingV1[]>;
  /** Where the next pass's swap read starts: the newest reading whose swaps
   * were read, or null. */
  latestWithSwaps(input: { chainId: number; poolAddress: string }): Promise<PoolYieldReadingV1 | null>;
  /** Readings older than this go: a yield looks back a week. */
  prune(input: { before: string }): Promise<number>;
}
