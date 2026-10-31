-- Earlier readings of a signed-in wallet's own Still report, so the Agent can
-- say what moved its borrowing room. Figures only, the same public chain state
-- the report shows: no session, name or address other than the wallet the
-- session proved. Kept 60 days; the writer deletes older rows.
CREATE TABLE IF NOT EXISTS still_wallet_readings (
  id bigserial PRIMARY KEY,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  block_number bigint NOT NULL CHECK (block_number > 0),
  block_time timestamptz NOT NULL,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 40),
  market_closed boolean NOT NULL,
  available_cents bigint CHECK (available_cents IS NULL OR available_cents >= 0),
  reading_json jsonb NOT NULL CHECK (jsonb_typeof(reading_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_wallet_readings_latest
  ON still_wallet_readings (wallet_address, block_time DESC);
--> statement-breakpoint
ALTER TABLE still_wallet_readings OWNER TO miorail_user;
