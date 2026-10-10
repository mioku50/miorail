-- Service alerts: which Telegram chats hear that a Miorail unit failed.
--
-- `miorail-rwa-official` failed every hour from 2026-10-07 to 2026-10-09 and
-- nobody heard: a failed unit was a line in a journal nobody reads. The
-- service-alert worker tells the chats listed here when a unit fails, once a
-- day while it stays failed, and when it recovers.
--
-- A chat is listed one way only: the operator issues a one-time code on the
-- server, and the person brings it to the bot in /start. Stored are the chat's
-- numeric id and when it subscribed, nothing else Telegram knows; a code only
-- as its SHA-256, for ten minutes, spent once. /stop removes the chat.
--
-- Applied as the app user, like every migration here: a table created as
-- postgres is one the service cannot write. Re-runnable.

CREATE TABLE IF NOT EXISTS ops_alert_chats (
  chat_id        bigint      PRIMARY KEY,
  subscribed_at  timestamptz NOT NULL,
  -- A private chat's id is the person's user id: positive.
  CONSTRAINT ops_alert_chats_chat CHECK (chat_id > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_alert_codes (
  code_hash   text        PRIMARY KEY,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT ops_alert_codes_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ops_alert_codes_window CHECK (expires_at > created_at)
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE ops_alert_chats OWNER TO miorail_user';
    EXECUTE 'ALTER TABLE ops_alert_codes OWNER TO miorail_user';
  END IF;
END
$$;
