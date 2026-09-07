import {
  assertMarketPoolReadingV1,
  type MarketPoolReadingRepositoryV1,
  type MarketPoolReadingV1,
} from './poolReadings.js';
import type { SqlTemplateExecutor } from './types.js';

function readingFromRowV1(row: Record<string, unknown>): MarketPoolReadingV1 {
  return assertMarketPoolReadingV1(
    {
      chainId: Number(row.chain_id),
      poolAddress: row.pool_address,
      tokenAddress: row.token_address,
      venueId: (row.venue_id as string | null) ?? null,
      factoryAddress: (row.factory_address as string | null) ?? null,
      tokenBalanceAtomic: String(row.token_balance_atomic),
      tokenDecimals: Number(row.token_decimals),
      pairedTokenAddress: (row.paired_token_address as string | null) ?? null,
      pairedBalanceAtomic:
        row.paired_balance_atomic === null || row.paired_balance_atomic === undefined
          ? null
          : String(row.paired_balance_atomic),
      pairedDecimals:
        row.paired_decimals === null || row.paired_decimals === undefined
          ? null
          : Number(row.paired_decimals),
      pairedSymbol: (row.paired_symbol as string | null) ?? null,
      blockNumber: Number(row.block_number),
      readAt: new Date(row.read_at as string).toISOString(),
    },
    'read',
  );
}

export function createDatabaseMarketPoolReadingRepository(
  sql: SqlTemplateExecutor,
): MarketPoolReadingRepositoryV1 {
  return {
    async recordReadings(input) {
      // Validate every row BEFORE the first write. A pass that writes eleven
      // good readings and then refuses the twelfth has already changed what
      // the screen shows, and the caller cannot tell which half landed.
      const readings = input.readings.map((reading) => assertMarketPoolReadingV1(reading, 'write'));
      if (readings.length === 0) return { written: 0 };

      let written = 0;
      for (const reading of readings) {
        await sql`
          INSERT INTO market_pool_readings (
            chain_id, pool_address, token_address, venue_id, factory_address,
            token_balance_atomic, token_decimals,
            paired_token_address, paired_balance_atomic, paired_decimals, paired_symbol,
            block_number, read_at
          ) VALUES (
            ${reading.chainId}, ${reading.poolAddress}, ${reading.tokenAddress},
            ${reading.venueId}, ${reading.factoryAddress},
            ${reading.tokenBalanceAtomic}, ${reading.tokenDecimals},
            ${reading.pairedTokenAddress}, ${reading.pairedBalanceAtomic},
            ${reading.pairedDecimals}, ${reading.pairedSymbol},
            ${reading.blockNumber}::bigint, ${reading.readAt}::timestamptz
          )
          ON CONFLICT (chain_id, pool_address, token_address) DO UPDATE SET
            venue_id = EXCLUDED.venue_id,
            factory_address = EXCLUDED.factory_address,
            token_balance_atomic = EXCLUDED.token_balance_atomic,
            token_decimals = EXCLUDED.token_decimals,
            paired_token_address = EXCLUDED.paired_token_address,
            paired_balance_atomic = EXCLUDED.paired_balance_atomic,
            paired_decimals = EXCLUDED.paired_decimals,
            paired_symbol = EXCLUDED.paired_symbol,
            block_number = EXCLUDED.block_number,
            read_at = EXCLUDED.read_at
          -- A reading never moves backwards. A pass re-reading an older block
          -- than the stored one is a retry that raced a newer pass, and letting
          -- it win would age the screen by replacing a fresh fact with a stale
          -- one that looks identical.
          WHERE market_pool_readings.block_number <= EXCLUDED.block_number
            -- And it never LOSES a fact the stored row already has.
            --
            -- Measured twice on 2026-09-07, both times within minutes of
            -- shipping. First a rate-limited pass read each token balance and
            -- lost the other side, turning "3,774.69 against 1,629,587.32 USDC"
            -- into "the other side was not read" on a third of the live rows.
            -- Guarding the pair alone was not enough: the next pass read the
            -- pair and lost the FACTORY, and a pool that had been labelled
            -- Uniswap v3 came back as "Venue not identified". Both are the same
            -- failure — a newer partial answer beating an older whole one
            -- because the only thing compared was the block.
            --
            -- So each optional fact is guarded on its own. The row keeps its own
            -- block and the screen already says how old it is, which is the
            -- honest trade: a slightly older complete reading beats a fresh one
            -- with holes in it.
            --
            -- A pair that genuinely emptied reads as 0, not as null — null means
            -- the call failed — so none of this can hide a pool that drained.
            AND (EXCLUDED.paired_balance_atomic IS NOT NULL
                 OR market_pool_readings.paired_balance_atomic IS NULL)
            AND (EXCLUDED.factory_address IS NOT NULL
                 OR market_pool_readings.factory_address IS NULL)
            AND (EXCLUDED.venue_id IS NOT NULL
                 OR market_pool_readings.venue_id IS NULL)`;
        written += 1;
      }
      return { written };
    },

    async readingsForToken(input) {
      const rows = (await sql`
        SELECT * FROM market_pool_readings
         WHERE chain_id = ${input.chainId}
           AND token_address = ${input.tokenAddress.toLowerCase()}
         -- Deepest first, by the MEASURED balance. ::numeric because the column
         -- is a digit string: ordering it as text puts 9 above 1,614,910.
         ORDER BY token_balance_atomic::numeric DESC, pool_address
         LIMIT ${Math.max(1, Math.min(500, input.limit))}`) as Record<string, unknown>[];
      return rows.map(readingFromRowV1);
    },
  };
}
