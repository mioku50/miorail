-- Still: when a reading last said a loan's borrow rate (2026-11-18).
--
-- A reading that could not read the rate keeps the last one it knew, and
-- moves read_at all the same: a notice told that kept rate as the rate now.
-- rate_read_at moves only with a reading that said a rate, so a rate is the
-- latest reading's only when rate_read_at is that reading's read_at. Rows
-- written before this have none until their next reading that says a rate.
-- Applied as the app user, like every migration here. Re-runnable.

ALTER TABLE still_loan_alerts ADD COLUMN IF NOT EXISTS rate_read_at timestamptz;
