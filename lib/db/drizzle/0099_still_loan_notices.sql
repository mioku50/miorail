-- Still: what a loan's owner is told besides a worse band (2026-11-17).
--
-- Three notices join the margin alerts, in the same chats:
-- - a loan just opened: what was borrowed, the debt, the rate and the margin,
--   once per confirmed borrow;
-- - the week's note on each open loan: the debt, the interest it gathered
--   since the last note, the rate and the margin;
-- - a hold on the collateral: its transfers paused or a holder frozen by its
--   issuer, or Aave pausing, freezing or halting its reserve, or Coinbase's
--   registry holding its price feed, with what that means on the venue.
--
-- still_loan_alerts keeps, per loan, what those need from the readings:
-- - debt_atomic and rate_bps: the last reading's debt (USDC, 6 decimals) and
--   borrow rate a year;
-- - interest_atomic: the interest the loan gathered while Still read it. Each
--   reading adds the debt's growth since the one before when that growth is
--   interest alone. Across a borrow or a repayment it adds what the rate read
--   before would have charged, and estimated_atomic counts that part;
-- - holds and hold_episode: the holds on its collateral as 'SYMBOL:kind', and
--   an episode that moves when a hold appears. A hold a reading could not
--   read stays as it was.
--
-- still_loan_notices remembers what each channel told, so each notice is told
-- once: a borrow by its execution id, a loan's week, or its hold episode. A
-- week's note keeps the interest count it was told at, so the next one says
-- the interest gathered since.
--
-- Stored: wallets, markets, amounts and times, as the alerts already keep.
-- Applied as the app user, like every migration here. Re-runnable.

ALTER TABLE still_loan_alerts
  ADD COLUMN IF NOT EXISTS debt_atomic      numeric(78, 0),
  ADD COLUMN IF NOT EXISTS rate_bps         integer,
  ADD COLUMN IF NOT EXISTS interest_atomic  numeric(78, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_atomic numeric(78, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holds            text[]         NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hold_episode     integer        NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE still_loan_alerts DROP CONSTRAINT IF EXISTS still_loan_alerts_amounts;
--> statement-breakpoint
ALTER TABLE still_loan_alerts ADD CONSTRAINT still_loan_alerts_amounts CHECK (
  (debt_atomic IS NULL OR debt_atomic >= 0)
  AND (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 1000000)
  AND interest_atomic >= 0
  AND estimated_atomic BETWEEN 0 AND interest_atomic
  AND hold_episode >= 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_loan_notices (
  channel           text           NOT NULL,
  kind              text           NOT NULL,
  notice_key        text           NOT NULL,
  wallet_address    text           NOT NULL,
  market            text           NOT NULL,
  interest_atomic   numeric(78, 0),
  estimated_atomic  numeric(78, 0),
  told_at           timestamptz    NOT NULL,
  CONSTRAINT still_loan_notices_pk PRIMARY KEY (channel, kind, notice_key),
  CONSTRAINT still_loan_notices_channel CHECK (channel IN ('base_app', 'telegram')),
  CONSTRAINT still_loan_notices_kind CHECK (kind IN ('opened', 'week', 'hold')),
  CONSTRAINT still_loan_notices_key CHECK (notice_key ~ '^[A-Za-z0-9:_.|-]{1,255}$'),
  CONSTRAINT still_loan_notices_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- A loan's market, or for a borrow the market its execution names.
  CONSTRAINT still_loan_notices_market CHECK (market ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  -- Only a week's note counts interest.
  CONSTRAINT still_loan_notices_interest CHECK (
    (kind = 'week' AND interest_atomic >= 0 AND estimated_atomic BETWEEN 0 AND interest_atomic)
    OR (kind <> 'week' AND interest_atomic IS NULL AND estimated_atomic IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_loan_notices_loan
  ON still_loan_notices (wallet_address, market, channel, kind, told_at DESC);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loan_notices OWNER TO miorail_user';
  END IF;
END
$$;
