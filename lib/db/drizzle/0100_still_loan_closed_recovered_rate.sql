-- Still: three more notices on a loan (2026-11-17).
--
-- - A loan repaid through Still: the receipt's verified effect says no debt is
--   left there, and whether the collateral came back to the wallet. Told once
--   per confirmed repayment, read from lending_executions like a loan opened.
-- - A margin back: a loan whose worse band this channel told reads calm again,
--   at two readings in a row, so a margin that only touches the Watch line is
--   not told as recovered. Once per episode.
-- - A rate that jumped: the borrow rate read at least 2 points and half again
--   over the rate its owner last heard of (a loan opened, a week's note or a
--   jump told before, else the first reading), for an hour. Once per stretch.
--
-- still_loan_alerts keeps what those need:
-- - state_since: when the loan entered the band it is in;
-- - rate_told_bps and rate_told_at: the rate its owner last heard of, and when;
-- - rate_high_since and rate_episode: since when the rate has read a jump over
--   it, and an episode that moves each time such a stretch starts.
--
-- Stored: rates and times, beside what the alerts already keep. Applied as the
-- app user, like every migration here. Re-runnable.

ALTER TABLE still_loan_alerts
  ADD COLUMN IF NOT EXISTS state_since     timestamptz,
  ADD COLUMN IF NOT EXISTS rate_told_bps   integer,
  ADD COLUMN IF NOT EXISTS rate_told_at    timestamptz,
  ADD COLUMN IF NOT EXISTS rate_high_since timestamptz,
  ADD COLUMN IF NOT EXISTS rate_episode    integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE still_loan_alerts SET state_since = read_at WHERE state_since IS NULL;
--> statement-breakpoint
UPDATE still_loan_alerts SET rate_told_bps = rate_bps, rate_told_at = read_at
 WHERE rate_told_bps IS NULL AND rate_bps IS NOT NULL;
--> statement-breakpoint
ALTER TABLE still_loan_alerts DROP CONSTRAINT IF EXISTS still_loan_alerts_rates;
--> statement-breakpoint
ALTER TABLE still_loan_alerts ADD CONSTRAINT still_loan_alerts_rates CHECK (
  (rate_told_bps IS NULL OR rate_told_bps BETWEEN 0 AND 1000000)
  AND (rate_told_bps IS NULL) = (rate_told_at IS NULL)
  AND rate_episode >= 0
  AND (rate_high_since IS NULL OR rate_episode > 0)
);
--> statement-breakpoint
ALTER TABLE still_loan_notices DROP CONSTRAINT IF EXISTS still_loan_notices_kind;
--> statement-breakpoint
ALTER TABLE still_loan_notices ADD CONSTRAINT still_loan_notices_kind
  CHECK (kind IN ('opened', 'week', 'hold', 'closed', 'recovered', 'rate'));
