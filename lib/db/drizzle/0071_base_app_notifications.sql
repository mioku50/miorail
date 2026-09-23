-- Base App notifications: what has been delivered, so nothing is delivered
-- twice and nothing old is delivered at all.
--
-- WHERE THEY GO
--
-- Base App pushes a notification to a wallet address that pinned Miorail and
-- turned notifications on, through the Base Dashboard REST API. That list lives
-- at Base, not here: this schema stores no subscriber list and no copy of it.
--
-- WHAT IS STORED
--
-- One cursor per source table: the newest row the notifier has handled, as the
-- (recorded_at, id) pair the source orders by. It is opened at the newest row
-- that exists when the notifier first runs, so a first pass announces nothing
-- -- the 700 signals recorded before 2026-09-23 are history, not news -- and
-- every later pass reads only what was written after it.
--
-- And a per-wallet count per UTC day, because a push is an interruption and
-- the cap on them has to survive the process that sends them. Rows older than
-- a week are deleted by the notifier; a count is all they ever hold.
--
-- Applied by hand, as the app user, like every migration here: a table created
-- as postgres is one the service cannot write.

CREATE TABLE IF NOT EXISTS base_app_notification_cursor (
  source      text        PRIMARY KEY,
  cursor_at   timestamptz NOT NULL,
  -- The row's own id as text: a bigserial for rwa_signals, a 0x hash for
  -- radar events. Empty when the source had no rows when the cursor opened.
  cursor_id   text        NOT NULL,
  opened_at   timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT base_app_notification_cursor_source CHECK (source IN ('rwa_signal', 'radar_event')),
  CONSTRAINT base_app_notification_cursor_id CHECK (
    cursor_id = '' OR cursor_id ~ '^[1-9][0-9]*$' OR cursor_id ~ '^0x[0-9a-f]{64}$'
  )
);

CREATE TABLE IF NOT EXISTS base_app_notification_daily (
  wallet_address  text    NOT NULL,
  day             date    NOT NULL,
  sent            integer NOT NULL,
  CONSTRAINT base_app_notification_daily_pk PRIMARY KEY (wallet_address, day),
  CONSTRAINT base_app_notification_daily_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT base_app_notification_daily_sent CHECK (sent > 0)
);

-- Owned by the app user whoever runs this, as 0066 and 0069 learned: a table
-- created as postgres is one the notifier can read nothing from.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE base_app_notification_cursor OWNER TO miorail_user';
    EXECUTE 'ALTER TABLE base_app_notification_daily OWNER TO miorail_user';
  END IF;
END
$$;
