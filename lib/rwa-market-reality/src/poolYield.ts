import { z } from 'zod';
import type { PoolYieldReadingV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// What an Aerodrome concentrated-liquidity pool pays, per dollar in it.
//
// Two payments, and a position gets ONE of them. In Slipstream a position
// staked in the pool's gauge earns AERO and gives its share of the swap fees
// to voters; a position that is not staked earns the fees (less the pool's
// unstaked fee) and no AERO. So the card states two alternatives and never
// their sum.
//
// Both are said per dollar in the pool, on average: AERO over a year at this
// week's emission rate and today's AERO price, and fees over the week that
// was measured. Measured on the NVDAc/USDC pool on 2026-10-04, 97% of the
// in-range liquidity was staked and most of it in ranges far narrower than
// ±10%, so a dollar in a wide range earns much less than the average, and a
// dollar in a narrow one more, for as long as the price stays inside it.
//
// The readings come from the pools worker (`rwa-issuer`'s chain reads); this
// module only computes, so the browser can take its schema.
// ---------------------------------------------------------------------------

/** USDC on Base: the only pair this version prices, because a dollar is its
 * own price. */
export const POOL_YIELD_USDC_BASE_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

const SECONDS_PER_YEAR_V1 = 365 * 24 * 3_600;
const SECONDS_PER_WEEK_V1 = 7 * 24 * 3_600;
/** The window fees are measured over, and the least of it worth a figure. */
export const POOL_YIELD_FEE_WINDOW_DAYS_V1 = 7;
export const POOL_YIELD_FEE_MIN_DAYS_V1 = 1;
/**
 * The least a pool must hold, at the stock's market price, for a yearly rate.
 *
 * Rates were divided by the pool's own price, and a concentrated pool's
 * current price is wherever its last trade left it: BILIc's read $157,235 on
 * 2026-10-10 (the share: $15.49), and pools of a few hundred dollars printed
 * "about 24208% a year in AERO" (CAKEc) and "about $0 in it · 121892% a year
 * in fees" (DUOLc). A rate now needs the stock's market price on Base and at
 * least this much in the pool; otherwise the amounts stay and the rates go.
 */
export const POOL_YIELD_MIN_POOL_USD_V1 = 1_000;

export interface PoolYieldV1 {
  schemaVersion: 'pool-yield/v1';
  tokenAddress: string;
  poolAddress: string;
  /** The price the pool is valued at, in USDC: the stock's market price on
   * Base when the caller has one, else the pool's own (and then no rate). */
  stockPriceUsd: number;
  /** What the pool holds, both sides, at that price. */
  poolUsd: number;
  /** Of the liquidity in range at the reading, the share staked in the gauge. */
  stakedSharePercent: number | null;
  /** Staked positions: AERO this week. Null with no gauge, no emissions this
   * period, or no AERO price. */
  aero: {
    perWeek: number;
    perWeekUsd: number;
    /** Per staked dollar, on average, over a year at this rate: the week's
     * AERO over the staked share of the pool's money. Null when almost
     * nothing in range is staked, because then a few dollars share it all
     * and the figure says nothing a reader can use. */
    aprPercent: number | null;
    priceUsd: number;
    priceAt: string;
    periodEndsAt: string;
  } | null;
  /** Positions not staked: the fees, over the days measured. Null under a
   * day, and for a pool too small or too unpriced to rate. */
  fees: {
    days: number;
    feesUsd: number;
    swaps: number;
    /** Per dollar in the pool, on average, over a year at that pace. */
    aprPercent: number;
    unstakedFeePercent: number;
  } | null;
  readAt: string;
  blockNumber: number;
}

const IsoV1 = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);
const AddressV1 = z.string().regex(/^0x[0-9a-f]{40}$/);
const AmountV1 = z.number().finite().nonnegative();

export const PoolYieldV1Schema = z
  .object({
    schemaVersion: z.literal('pool-yield/v1'),
    tokenAddress: AddressV1,
    poolAddress: AddressV1,
    stockPriceUsd: z.number().positive().finite(),
    poolUsd: z.number().positive().finite(),
    stakedSharePercent: z.number().min(0).max(100).nullable(),
    aero: z
      .object({
        perWeek: AmountV1,
        perWeekUsd: AmountV1,
        aprPercent: AmountV1.nullable(),
        priceUsd: z.number().positive().finite(),
        priceAt: IsoV1,
        periodEndsAt: IsoV1,
      })
      .strict()
      .nullable(),
    fees: z
      .object({
        days: AmountV1,
        feesUsd: AmountV1,
        swaps: z.number().int().nonnegative(),
        aprPercent: AmountV1,
        unstakedFeePercent: z.number().min(0).max(100),
      })
      .strict()
      .nullable(),
    readAt: IsoV1,
    blockNumber: z.number().int().positive(),
  })
  .strict();

/** The public read: one stock's deepest Aerodrome pool, or null when none is
 * measured. Null is "not measured", never "pays nothing". */
export const PoolYieldResponseV1Schema = z
  .object({
    schemaVersion: z.literal('pool-yield-response/v1'),
    tokenAddress: AddressV1,
    yield: PoolYieldV1Schema.nullable(),
  })
  .strict();

export type PoolYieldResponseV1 = z.infer<typeof PoolYieldResponseV1Schema>;

/** The stock price, in USDC, from the pool's sqrt price. */
function stockPriceUsdV1(reading: PoolYieldReadingV1, stockIs0: boolean): number | null {
  const sqrt = Number(BigInt(reading.sqrtPriceX96)) / 2 ** 96;
  const raw = sqrt * sqrt; // token1 per token0, in atomic units
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // token0 in token1, in whole units.
  const price0In1 = raw * 10 ** (reading.decimals0 - reading.decimals1);
  return stockIs0 ? price0In1 : 1 / price0In1;
}

export function poolYieldV1(input: {
  readings: readonly PoolYieldReadingV1[];
  now: Date;
  /** The stock's market price on Base (the ladder's $100 mid where its market
   * is not thin). Without it the pool is valued at its own price and no rate
   * is given. */
  marketPriceUsd?: number | null;
}): PoolYieldV1 | null {
  const sorted = [...input.readings].sort((a, b) => a.blockNumber - b.blockNumber);
  const latest = sorted[sorted.length - 1];
  if (!latest) return null;
  const usdcIs0 = latest.token0Address === POOL_YIELD_USDC_BASE_V1;
  const usdcIs1 = latest.token1Address === POOL_YIELD_USDC_BASE_V1;
  if (usdcIs0 === usdcIs1) return null;
  const stockIs0 = usdcIs1;
  const market =
    input.marketPriceUsd != null && Number.isFinite(input.marketPriceUsd) && input.marketPriceUsd > 0
      ? input.marketPriceUsd
      : null;
  const price = market ?? stockPriceUsdV1(latest, stockIs0);
  if (price === null) return null;

  const usd0 = (atomic: string, reading: PoolYieldReadingV1, p: number) =>
    (Number(BigInt(atomic)) / 10 ** reading.decimals0) * (stockIs0 ? p : 1);
  const usd1 = (atomic: string, reading: PoolYieldReadingV1, p: number) =>
    (Number(BigInt(atomic)) / 10 ** reading.decimals1) * (stockIs0 ? 1 : p);
  const poolUsd = usd0(latest.balance0Atomic, latest, price) + usd1(latest.balance1Atomic, latest, price);
  if (!Number.isFinite(poolUsd) || poolUsd <= 0) return null;
  const rated = market !== null && poolUsd >= POOL_YIELD_MIN_POOL_USD_V1;

  const liquidity = BigInt(latest.liquidity);
  const staked = BigInt(latest.stakedLiquidity);
  const stakedSharePercent = liquidity > 0n ? Number((staked * 10_000n) / liquidity) / 100 : null;
  // The share of the pool's money taken to be staked: the staked share of the
  // liquidity in range, assuming staked and unstaked positions are spread the
  // same way. Under 1% the figure would be a few dollars sharing everything.
  const stakedShare = stakedSharePercent !== null && stakedSharePercent >= 1 ? stakedSharePercent / 100 : null;

  // AERO: this period's rate, while the period lasts, at Chainlink's price.
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  const perSecond = Number(BigInt(latest.rewardRate)) / 1e18;
  const aero =
    latest.gaugeAddress && perSecond > 0 && latest.periodFinish > nowSeconds && latest.aeroUsd !== null && latest.aeroUsdUpdatedAt
      ? {
          perWeek: perSecond * SECONDS_PER_WEEK_V1,
          perWeekUsd: perSecond * SECONDS_PER_WEEK_V1 * latest.aeroUsd,
          aprPercent:
            !rated || stakedShare === null
              ? null
              : ((perSecond * SECONDS_PER_YEAR_V1 * latest.aeroUsd) / (poolUsd * stakedShare)) * 100,
          priceUsd: latest.aeroUsd,
          priceAt: latest.aeroUsdUpdatedAt,
          periodEndsAt: new Date(latest.periodFinish * 1_000).toISOString(),
        }
      : null;

  // Fees: the swaps of the readings inside the window, each side's paid-in
  // amount times that reading's fee, valued at that reading's price.
  const windowStart = input.now.getTime() - POOL_YIELD_FEE_WINDOW_DAYS_V1 * 86_400_000;
  let feesUsd = 0;
  let coveredMs = 0;
  let swaps = 0;
  for (const reading of sorted) {
    if (!reading.swaps || Date.parse(reading.swaps.fromAt) < windowStart) continue;
    // At the market price when there is one: a pool's own price wanders
    // with every trade in a thin pool.
    const readingPrice = market ?? stockPriceUsdV1(reading, stockIs0) ?? price;
    const feeShare = reading.feePips / 1_000_000;
    feesUsd +=
      usd0(reading.swaps.amount0InAtomic, reading, readingPrice) * feeShare +
      usd1(reading.swaps.amount1InAtomic, reading, readingPrice) * feeShare;
    coveredMs += Date.parse(reading.blockAt) - Date.parse(reading.swaps.fromAt);
    swaps += reading.swaps.count;
  }
  const days = coveredMs / 86_400_000;
  const fees =
    rated && days >= POOL_YIELD_FEE_MIN_DAYS_V1
      ? {
          days: Math.round(days * 10) / 10,
          feesUsd,
          swaps,
          aprPercent: ((feesUsd / days) * 365 * (1 - latest.unstakedFeePips / 1_000_000)) / poolUsd * 100,
          unstakedFeePercent: latest.unstakedFeePips / 10_000,
        }
      : null;

  return {
    schemaVersion: 'pool-yield/v1',
    tokenAddress: latest.tokenAddress,
    poolAddress: latest.poolAddress,
    stockPriceUsd: price,
    poolUsd,
    stakedSharePercent,
    aero,
    fees,
    readAt: latest.readAt,
    blockNumber: latest.blockNumber,
  };
}

// ---------------------------------------------------------------------------
// The same figure for an assistant: two alternatives by name, and the
// sentence to repeat, written by no model.
// ---------------------------------------------------------------------------

export interface PoolYieldAgentV1 {
  poolAddress: string;
  poolUsd: number;
  stakedSharePercent: number | null;
  /** A position staked in the gauge: AERO, and its fees go to voters. */
  staked: { aeroPerWeek: number; aeroPriceUsd: number; aprPercent: number | null; periodEndsAt: string } | null;
  /** A position not staked: the fees, less the pool's unstaked fee, and no AERO. */
  notStaked: { feesAprPercent: number; days: number; unstakedFeePercent: number } | null;
  readAt: string;
  summary: string;
}

function agentPercentV1(value: number): string {
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  return `${value.toFixed(2)}%`;
}

export function poolYieldAgentV1(view: PoolYieldV1): PoolYieldAgentV1 {
  const money = view.poolUsd >= 1_000_000 ? `$${(view.poolUsd / 1_000_000).toFixed(2)}M` : `$${Math.round(view.poolUsd).toLocaleString('en-US')}`;
  const sentences = [`The deepest Aerodrome pool for this token (${view.poolAddress}) holds about ${money}.`];
  if (view.aero) {
    sentences.push(
      view.aero.aprPercent !== null
        ? `A position staked in its gauge earns AERO instead of its fees: about ${agentPercentV1(view.aero.aprPercent)} a year per dollar at this week's emission rate and AERO at $${view.aero.priceUsd.toFixed(3)}, until ${view.aero.periodEndsAt}.`
        : `A position staked in its gauge shares ${Math.round(view.aero.perWeek).toLocaleString('en-US')} AERO this week; so little is staked in range that no rate per dollar is stated.`,
    );
  }
  if (view.fees) {
    sentences.push(
      `A position not staked earns fees instead of AERO: about ${agentPercentV1(view.fees.aprPercent)} a year per dollar over the last ${view.fees.days} days, after the pool's ${view.fees.unstakedFeePercent}% unstaked fee.`,
    );
  }
  sentences.push(
    "These are averages over the pool's money, never a promise: a narrow range earns more while the price stays inside it, a range the price has left earns nothing, and AERO's price and the weekly emissions move.",
  );
  return {
    poolAddress: view.poolAddress,
    poolUsd: view.poolUsd,
    stakedSharePercent: view.stakedSharePercent,
    staked: view.aero
      ? { aeroPerWeek: view.aero.perWeek, aeroPriceUsd: view.aero.priceUsd, aprPercent: view.aero.aprPercent, periodEndsAt: view.aero.periodEndsAt }
      : null,
    notStaked: view.fees
      ? { feesAprPercent: view.fees.aprPercent, days: view.fees.days, unstakedFeePercent: view.fees.unstakedFeePercent }
      : null,
    readAt: view.readAt,
    summary: sentences.join(' '),
  };
}
