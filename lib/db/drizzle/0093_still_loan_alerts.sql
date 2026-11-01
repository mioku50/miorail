-- Still: a loan's margin, told before it is too late.
--
-- The notifier reads, every pass, the wallets that borrowed through Still and
-- connected a chat, with the Mirror engine, and keeps one row per loan: the
-- Aave V4 spoke (one USDC debt across every stock) or a Morpho market. The row
-- holds the safety band of that reading (calm, watch, act or liquidation, by
-- Still's terms) and the margin, the share by which all the collateral may
-- fall before liquidation.
--
-- The episode is what "once" counts in. It moves on each time the band gets
-- worse, so watch, act and liquidation are each told once; a band that gets
-- better moves nothing, and a later fall is told again. told_base_app /
-- told_telegram are the episode each channel last told. A loan that is gone
-- (repaid) loses its row; a reading that failed changes nothing, because an
-- unread loan is not a safe one.
--
-- Stored: the wallet, the loan's market, the band, the margin, the block and
-- time of the reading, and those episodes. Nothing else.
--
-- Applied as the app user, like every migration here: a table created as
-- postgres is one the service cannot write. Re-runnable.

CREATE TABLE IF NOT EXISTS still_loan_alerts (
  wallet_address  text        NOT NULL,
  market          text        NOT NULL,
  venue           text        NOT NULL,
  state           text        NOT NULL,
  margin_bps      integer     NOT NULL,
  episode         integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL,
  read_at         timestamptz NOT NULL,
  read_block      bigint      NOT NULL,
  told_base_app   integer,
  told_telegram   integer,
  CONSTRAINT still_loan_alerts_pk PRIMARY KEY (wallet_address, market),
  CONSTRAINT still_loan_alerts_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- The Aave spoke's address, or a Morpho market id.
  CONSTRAINT still_loan_alerts_market CHECK (market ~ '^0x[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT still_loan_alerts_venue CHECK (venue IN ('aave-v4', 'morpho')),
  CONSTRAINT still_loan_alerts_state CHECK (state IN ('calm', 'watch', 'act', 'liquidation')),
  CONSTRAINT still_loan_alerts_margin CHECK (margin_bps BETWEEN 0 AND 10000),
  CONSTRAINT still_loan_alerts_block CHECK (read_block > 0),
  CONSTRAINT still_loan_alerts_episode CHECK (episode >= 0),
  CONSTRAINT still_loan_alerts_told CHECK (
    (told_base_app IS NULL OR told_base_app BETWEEN 0 AND episode)
    AND (told_telegram IS NULL OR told_telegram BETWEEN 0 AND episode)
  )
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loan_alerts OWNER TO miorail_user';
  END IF;
END
$$;
