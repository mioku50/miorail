-- Found, inside Wallet MCP: the wallets that asked to hear when the rewards
-- they can claim on Aerodrome build up.
--
-- A person in the Wallet MCP room says "Notify me when my Aerodrome rewards
-- reach $5". The notifier reads that wallet's claimable fees and AERO about
-- every six hours (one reading walks every Aerodrome pool) and tells it once,
-- per channel, each time they build up past the amount.
--
-- The episode is what "once" counts in: it moves on when a reading falls under
-- half the amount after the wallet was told (a claim does that), and when the
-- amount changes. told_base_app / told_telegram are the episode each channel
-- last told. Stored: the wallet, the amount, the last reading (cents and block,
-- or the failure's code) and those episodes. Nothing else.
--
-- Applied as the app user, like every migration here: a table created as
-- postgres is one the service cannot write. Re-runnable.

CREATE TABLE IF NOT EXISTS aerodrome_reward_alerts (
  wallet_address       text        PRIMARY KEY,
  threshold_usd_cents  integer     NOT NULL,
  episode              integer     NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  read_at              timestamptz,
  read_block           bigint,
  read_usd_cents       bigint,
  read_error           text,
  told_base_app        integer,
  told_telegram        integer,
  CONSTRAINT aerodrome_reward_alerts_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- Below a dollar, collecting costs about what it brings.
  CONSTRAINT aerodrome_reward_alerts_threshold CHECK (threshold_usd_cents BETWEEN 100 AND 1000000),
  CONSTRAINT aerodrome_reward_alerts_episode CHECK (episode >= 0),
  -- A reading is a dollar figure or a failure, never both.
  CONSTRAINT aerodrome_reward_alerts_reading CHECK (
    (read_usd_cents IS NULL OR read_error IS NULL)
    AND (read_usd_cents IS NULL OR read_usd_cents >= 0)
    AND (read_error IS NULL OR read_error ~ '^[a-z0-9_]{1,64}$')
  ),
  CONSTRAINT aerodrome_reward_alerts_told CHECK (
    (told_base_app IS NULL OR told_base_app BETWEEN 0 AND episode)
    AND (told_telegram IS NULL OR told_telegram BETWEEN 0 AND episode)
  )
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE aerodrome_reward_alerts OWNER TO miorail_user';
  END IF;
END
$$;
