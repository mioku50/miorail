-- Still: a loan's margin at the onchain price while its oracle holds (2026-11-17).
--
-- From Friday 20:00 New York time to Sunday 20:00, and on market holidays,
-- the feeds that price Coinbase stocks on Aave V4 hold the last close, and the
-- gold feed that prices PAXG on Morpho holds Friday's gold. The notifier works
-- each loan out at the price its collateral trades at meanwhile, and tells a
-- band worse there than at the oracle's, once per band per window. What each
-- channel told is kept in still_loan_notices under the new kind 'weekend'.
--
-- Stored: nothing new beside the notice rows. Applied as the app user, like
-- every migration here. Re-runnable.

ALTER TABLE still_loan_notices DROP CONSTRAINT IF EXISTS still_loan_notices_kind;
--> statement-breakpoint
ALTER TABLE still_loan_notices ADD CONSTRAINT still_loan_notices_kind
  CHECK (kind IN ('opened', 'week', 'hold', 'closed', 'recovered', 'rate', 'weekend'));
