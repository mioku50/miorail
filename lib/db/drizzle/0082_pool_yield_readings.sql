-- What an Aerodrome concentrated-liquidity pool pays, read from the pool.
--
-- One row per pass: the gauge's emission rate and the end of its weekly
-- period, the pool's fee, in-range and staked liquidity, both balances and
-- its price, AERO's dollar price from Chainlink at the same block, and the
-- swaps since the previous row (the block interval they cover, their count,
-- and the amounts paid in on each side, which carry the fee). A week of fees
-- is a sum over our own rows, so no archive node and no single reading
-- decides it.
--
-- uint256 values are digit strings, like every balance in this schema.
--
-- Applied by the deploy, as the app user, inside the migrator's own
-- transaction. Re-runnable.
CREATE TABLE IF NOT EXISTS pool_yield_readings (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  pool_address text NOT NULL CHECK (pool_address ~ '^0x[0-9a-f]{40}$'),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  gauge_address text CHECK (gauge_address IS NULL OR gauge_address ~ '^0x[0-9a-f]{40}$'),
  block_number bigint NOT NULL CHECK (block_number > 0),
  -- The block's own timestamp. Time is never derived from a block count:
  -- Denim moves Base to 200 ms blocks.
  block_at timestamptz NOT NULL,
  read_at timestamptz NOT NULL,
  token0_address text NOT NULL CHECK (token0_address ~ '^0x[0-9a-f]{40}$'),
  token1_address text NOT NULL CHECK (token1_address ~ '^0x[0-9a-f]{40}$'),
  decimals0 integer NOT NULL CHECK (decimals0 BETWEEN 0 AND 36),
  decimals1 integer NOT NULL CHECK (decimals1 BETWEEN 0 AND 36),
  balance0_atomic text NOT NULL CHECK (balance0_atomic ~ '^[0-9]+$'),
  balance1_atomic text NOT NULL CHECK (balance1_atomic ~ '^[0-9]+$'),
  sqrt_price_x96 text NOT NULL CHECK (sqrt_price_x96 ~ '^[0-9]+$'),
  liquidity text NOT NULL CHECK (liquidity ~ '^[0-9]+$'),
  staked_liquidity text NOT NULL CHECK (staked_liquidity ~ '^[0-9]+$'),
  fee_pips integer NOT NULL CHECK (fee_pips BETWEEN 0 AND 1000000),
  unstaked_fee_pips integer NOT NULL CHECK (unstaked_fee_pips BETWEEN 0 AND 1000000),
  -- AERO wei per second for the gauge's current period; 0 with no gauge.
  reward_rate text NOT NULL CHECK (reward_rate ~ '^[0-9]+$'),
  period_finish bigint NOT NULL CHECK (period_finish >= 0),
  aero_usd numeric CHECK (aero_usd IS NULL OR aero_usd > 0),
  aero_usd_updated_at timestamptz,
  -- The swaps since the previous row: blocks (from, to], from the timestamp
  -- of `from` to `block_at`, or all null when the logs were not read this
  -- pass. Null is "not read", never "no swaps".
  swaps_from_block bigint,
  swaps_from_at timestamptz,
  swaps_to_block bigint,
  swaps_count integer CHECK (swaps_count IS NULL OR swaps_count >= 0),
  amount0_in_atomic text CHECK (amount0_in_atomic IS NULL OR amount0_in_atomic ~ '^[0-9]+$'),
  amount1_in_atomic text CHECK (amount1_in_atomic IS NULL OR amount1_in_atomic ~ '^[0-9]+$'),
  CONSTRAINT pool_yield_readings_swaps_complete CHECK (
    (swaps_from_block IS NULL AND swaps_from_at IS NULL AND swaps_to_block IS NULL
       AND swaps_count IS NULL AND amount0_in_atomic IS NULL AND amount1_in_atomic IS NULL)
    OR (swaps_from_block IS NOT NULL AND swaps_from_at IS NOT NULL AND swaps_to_block IS NOT NULL
       AND swaps_count IS NOT NULL AND amount0_in_atomic IS NOT NULL AND amount1_in_atomic IS NOT NULL
       AND swaps_from_block < swaps_to_block AND swaps_to_block = block_number
       AND swaps_from_at < block_at)
  ),
  CONSTRAINT pool_yield_readings_aero_price_complete CHECK ((aero_usd IS NULL) = (aero_usd_updated_at IS NULL)),
  CONSTRAINT pool_yield_readings_unique UNIQUE (chain_id, pool_address, block_number)
);
CREATE INDEX IF NOT EXISTS pool_yield_readings_pool_time_idx
  ON pool_yield_readings (chain_id, pool_address, read_at DESC);
CREATE INDEX IF NOT EXISTS pool_yield_readings_token_time_idx
  ON pool_yield_readings (chain_id, token_address, read_at DESC);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    -- Its id sequence follows: it is owned by the column.
    ALTER TABLE pool_yield_readings OWNER TO miorail_user;
  END IF;
END $$;
