import {
  assertPoolYieldReadingV1,
  type PoolYieldReadingRepositoryV1,
  type PoolYieldReadingV1,
} from './poolYields.js';
import type { SqlTemplateExecutor } from './types.js';

function isoV1(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function readingFromRowV1(row: Record<string, unknown>): PoolYieldReadingV1 {
  return assertPoolYieldReadingV1(
    {
      chainId: Number(row.chain_id),
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      gaugeAddress: (row.gauge_address as string | null) ?? null,
      blockNumber: Number(row.block_number),
      blockAt: isoV1(row.block_at),
      readAt: isoV1(row.read_at),
      token0Address: row.token0_address,
      token1Address: row.token1_address,
      decimals0: Number(row.decimals0),
      decimals1: Number(row.decimals1),
      balance0Atomic: String(row.balance0_atomic),
      balance1Atomic: String(row.balance1_atomic),
      sqrtPriceX96: String(row.sqrt_price_x96),
      liquidity: String(row.liquidity),
      stakedLiquidity: String(row.staked_liquidity),
      feePips: Number(row.fee_pips),
      unstakedFeePips: Number(row.unstaked_fee_pips),
      rewardRate: String(row.reward_rate),
      periodFinish: Number(row.period_finish),
      aeroUsd: row.aero_usd === null || row.aero_usd === undefined ? null : Number(row.aero_usd),
      aeroUsdUpdatedAt: row.aero_usd_updated_at ? isoV1(row.aero_usd_updated_at) : null,
      swaps:
        row.swaps_from_block === null || row.swaps_from_block === undefined
          ? null
          : {
              fromBlock: Number(row.swaps_from_block),
              fromAt: isoV1(row.swaps_from_at),
              count: Number(row.swaps_count),
              amount0InAtomic: String(row.amount0_in_atomic),
              amount1InAtomic: String(row.amount1_in_atomic),
            },
    },
    'read',
  );
}

export function createDatabasePoolYieldReadingRepository(sql: SqlTemplateExecutor): PoolYieldReadingRepositoryV1 {
  return {
    async record(input) {
      const reading = assertPoolYieldReadingV1(input, 'write');
      const swaps = reading.swaps;
      const rows = await sql`
        INSERT INTO pool_yield_readings (
          chain_id, pool_address, token_address, gauge_address,
          block_number, block_at, read_at,
          token0_address, token1_address, decimals0, decimals1,
          balance0_atomic, balance1_atomic, sqrt_price_x96,
          liquidity, staked_liquidity, fee_pips, unstaked_fee_pips,
          reward_rate, period_finish, aero_usd, aero_usd_updated_at,
          swaps_from_block, swaps_from_at, swaps_to_block, swaps_count,
          amount0_in_atomic, amount1_in_atomic
        ) VALUES (
          ${reading.chainId}, ${reading.poolAddress}, ${reading.tokenAddress}, ${reading.gaugeAddress},
          ${reading.blockNumber}::bigint, ${reading.blockAt}::timestamptz, ${reading.readAt}::timestamptz,
          ${reading.token0Address}, ${reading.token1Address}, ${reading.decimals0}, ${reading.decimals1},
          ${reading.balance0Atomic}, ${reading.balance1Atomic}, ${reading.sqrtPriceX96},
          ${reading.liquidity}, ${reading.stakedLiquidity}, ${reading.feePips}, ${reading.unstakedFeePips},
          ${reading.rewardRate}, ${reading.periodFinish}::bigint,
          ${reading.aeroUsd === null ? null : String(reading.aeroUsd)}::numeric,
          ${reading.aeroUsdUpdatedAt}::timestamptz,
          ${swaps ? swaps.fromBlock : null}::bigint, ${swaps ? swaps.fromAt : null}::timestamptz,
          ${swaps ? reading.blockNumber : null}::bigint, ${swaps ? swaps.count : null}::integer,
          ${swaps ? swaps.amount0InAtomic : null}, ${swaps ? swaps.amount1InAtomic : null}
        )
        ON CONFLICT (chain_id, pool_address, block_number) DO NOTHING
        RETURNING id`;
      return rows.length > 0 ? 'recorded' : 'duplicate';
    },

    async readingsForTokenSince(input) {
      const rows = await sql`
        SELECT * FROM pool_yield_readings
         WHERE chain_id = ${input.chainId}
           AND token_address = ${input.tokenAddress.toLowerCase()}
           AND read_at >= ${input.since}::timestamptz
         ORDER BY block_number ASC, pool_address ASC
         LIMIT 2000`;
      return rows.map(readingFromRowV1);
    },

    async readingsSince(input) {
      const rows = await sql`
        SELECT * FROM pool_yield_readings
         WHERE chain_id = ${input.chainId}
           AND pool_address = ${input.poolAddress.toLowerCase()}
           AND read_at >= ${input.since}::timestamptz
         ORDER BY block_number ASC
         LIMIT 2000`;
      return rows.map(readingFromRowV1);
    },

    async latestWithSwaps(input) {
      const rows = await sql`
        SELECT * FROM pool_yield_readings
         WHERE chain_id = ${input.chainId}
           AND pool_address = ${input.poolAddress.toLowerCase()}
           AND swaps_from_block IS NOT NULL
         ORDER BY block_number DESC
         LIMIT 1`;
      return rows[0] ? readingFromRowV1(rows[0]) : null;
    },

    async prune(input) {
      const rows = await sql`
        DELETE FROM pool_yield_readings WHERE read_at < ${input.before}::timestamptz RETURNING id`;
      return rows.length;
    },
  };
}
