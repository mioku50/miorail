-- How many tokens existed when a dividend's record date closed.
--
-- A company pays its dividend to whoever held its shares at the close of
-- business on the record date. Coinbase holds the shares behind its tokenized
-- stocks, so a token is owed a dividend only if it existed then: AAPLc had no
-- supply when Apple's 2026-08-10 record date closed, and MSFTc none at
-- Microsoft's 2026-08-20. Neither dividend was owed, and a multiplier that
-- never moved for them is not a failure. Without this row the calendar cannot
-- tell those two apart from a dividend that was owed and not converted.
--
-- One row per token and record date, read once from the token's own
-- `totalSupply()` at the last block at or before 16:00 New York on that date,
-- and never rewritten: the past does not change, and a later read of an older
-- block is the same answer or a worse endpoint.
--
-- Applied by hand, as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS dividend_record_supply (
  chain_id             integer     NOT NULL,
  token_address        text        NOT NULL,
  record_date          date        NOT NULL,
  -- 16:00 New York on the record date: the instant the supply answers for.
  record_close_at      timestamptz NOT NULL,
  -- The last block at or before that instant, and its own timestamp.
  block_number         bigint      NOT NULL,
  block_time           timestamptz NOT NULL,
  -- As the token returned it, in its own units. Text: a uint256.
  total_supply_atomic  text        NOT NULL,
  decimals             integer     NOT NULL,
  read_at              timestamptz NOT NULL,
  CONSTRAINT dividend_record_supply_pk PRIMARY KEY (chain_id, token_address, record_date),
  CONSTRAINT dividend_record_supply_chain CHECK (chain_id = 8453),
  CONSTRAINT dividend_record_supply_token CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT dividend_record_supply_amount CHECK (total_supply_atomic ~ '^[0-9]+$'),
  CONSTRAINT dividend_record_supply_decimals CHECK (decimals BETWEEN 0 AND 36),
  CONSTRAINT dividend_record_supply_block CHECK (block_number > 0),
  CONSTRAINT dividend_record_supply_before_close CHECK (block_time <= record_close_at)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE dividend_record_supply OWNER TO miorail_user';
  END IF;
END
$$;
