-- The weekly summary: which wallets have had this week's.
--
-- The notifier runs every five minutes, and the summary for a week is sent
-- once, in the evening after the week's last close. Base deduplicates an
-- identical push for 24 hours, but "identical" is its rule, not ours: a figure
-- that moved between two passes would reach the same person twice. So the
-- record is ours, keyed by the close the week ended at.
--
-- Applied by hand, as the app user, like every migration here: a table created
-- as postgres is one the service cannot write.

CREATE TABLE IF NOT EXISTS base_app_weekly_summary (
  week_close_at   timestamptz NOT NULL,
  wallet_address  text        NOT NULL,
  sent_at         timestamptz NOT NULL,
  CONSTRAINT base_app_weekly_summary_pk PRIMARY KEY (week_close_at, wallet_address),
  CONSTRAINT base_app_weekly_summary_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$')
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE base_app_weekly_summary OWNER TO miorail_user';
  END IF;
END
$$;
