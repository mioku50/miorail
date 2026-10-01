-- A wallet's initial baseline is fixed at first read. Reads do not acknowledge
-- events. Explicit receipts name individual events, so concurrent inserts,
-- same-time observations and unseen pages cannot be swallowed by a timestamp.
BEGIN;
CREATE TABLE IF NOT EXISTS stock_inbox_state (
  wallet_address text PRIMARY KEY CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  since_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  CHECK (since_at <= opened_at),
  CHECK (reviewed_at IS NULL OR reviewed_at >= opened_at)
);
CREATE TABLE IF NOT EXISTS stock_inbox_reads (
  wallet_address text NOT NULL REFERENCES stock_inbox_state(wallet_address),
  signal_id bigint NOT NULL REFERENCES rwa_signals(id),
  read_at timestamptz NOT NULL,
  PRIMARY KEY (wallet_address, signal_id)
);
CREATE INDEX IF NOT EXISTS rwa_signals_recorded_page_idx
  ON rwa_signals (chain_id, recorded_at, id);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    ALTER TABLE stock_inbox_state OWNER TO miorail_user;
    ALTER TABLE stock_inbox_reads OWNER TO miorail_user;
  END IF;
END $$;
COMMIT;
