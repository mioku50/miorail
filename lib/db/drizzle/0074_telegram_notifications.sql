-- Telegram notifications: a second channel for what Base App already hears.
--
-- ONE: THE NOTIFIER'S MEMORY, PER CHANNEL
--
-- The cursors, the per-wallet daily count and the weekly record were written
-- for Base App alone. A second channel reads the same signals and must keep
-- its own position in them, its own cap and its own weekly record: a wallet
-- told something in Base App is still told it in Telegram, and neither
-- channel's cap spends the other's. So each table gains `channel`, and its key
-- gains it too. The names keep their `base_app_` prefix, which is where they
-- started, not what they hold.
--
-- Existing rows are Base App's, which is what the default says. The default
-- stays so that nothing written in the minutes between this migration and the
-- deploy that reads it lands without a channel.
--
-- TWO: WHO HEARS ABOUT WHICH WALLET
--
-- `telegram_links` joins a Telegram chat to a wallet, and holds the chat's
-- numeric id and nothing else Telegram knows about the person. A link is made
-- only with a code from `telegram_link_codes`, which the website issues to a
-- session that already proved the wallet; a code is stored as its SHA-256,
-- lives ten minutes and is spent once.
--
-- Applied by hand, as the app user, like every migration here: a table created
-- as postgres is one the service cannot write. Re-runnable.

ALTER TABLE base_app_notification_cursor ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'base_app';
ALTER TABLE base_app_notification_daily ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'base_app';
ALTER TABLE base_app_weekly_summary ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'base_app';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'base_app_notification_cursor_pkey') THEN
    ALTER TABLE base_app_notification_cursor DROP CONSTRAINT base_app_notification_cursor_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_cursor_pk') THEN
    ALTER TABLE base_app_notification_cursor ADD CONSTRAINT notification_cursor_pk PRIMARY KEY (channel, source);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_cursor_channel') THEN
    ALTER TABLE base_app_notification_cursor
      ADD CONSTRAINT notification_cursor_channel CHECK (channel IN ('base_app', 'telegram'));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'base_app_notification_daily_pk') THEN
    ALTER TABLE base_app_notification_daily DROP CONSTRAINT base_app_notification_daily_pk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_daily_pk') THEN
    ALTER TABLE base_app_notification_daily ADD CONSTRAINT notification_daily_pk PRIMARY KEY (channel, wallet_address, day);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_daily_channel') THEN
    ALTER TABLE base_app_notification_daily
      ADD CONSTRAINT notification_daily_channel CHECK (channel IN ('base_app', 'telegram'));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'base_app_weekly_summary_pk') THEN
    ALTER TABLE base_app_weekly_summary DROP CONSTRAINT base_app_weekly_summary_pk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_weekly_summary_pk') THEN
    ALTER TABLE base_app_weekly_summary
      ADD CONSTRAINT notification_weekly_summary_pk PRIMARY KEY (channel, week_close_at, wallet_address);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_weekly_summary_channel') THEN
    ALTER TABLE base_app_weekly_summary
      ADD CONSTRAINT notification_weekly_summary_channel CHECK (channel IN ('base_app', 'telegram'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id         bigint      NOT NULL,
  wallet_address  text        NOT NULL,
  linked_at       timestamptz NOT NULL,
  CONSTRAINT telegram_links_pk PRIMARY KEY (chat_id, wallet_address),
  -- A private chat's id is the person's user id: positive.
  CONSTRAINT telegram_links_chat CHECK (chat_id > 0),
  CONSTRAINT telegram_links_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$')
);
CREATE INDEX IF NOT EXISTS telegram_links_wallet_idx ON telegram_links (wallet_address);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code_hash       text        PRIMARY KEY,
  wallet_address  text        NOT NULL,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  CONSTRAINT telegram_link_codes_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT telegram_link_codes_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT telegram_link_codes_window CHECK (expires_at > created_at)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE telegram_links OWNER TO miorail_user';
    EXECUTE 'ALTER TABLE telegram_link_codes OWNER TO miorail_user';
  END IF;
END
$$;
