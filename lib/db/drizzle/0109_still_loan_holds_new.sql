-- Still: the holds a loan's newest hold episode began with (2026-11-21, audit 11-20 LL-3).
--
-- A loan already told "AAPLc transfers are paused" that then met a second
-- hold (NVDAc paused, a feed paused in Coinbase's registry) started a new
-- episode, and its notice named the old hold again, so the person read it as
-- a repeat. The holds that appeared in the episode are kept here, and the
-- notice names those. A row from before this column holds none, and its
-- notice says what it said before.
ALTER TABLE still_loan_alerts ADD COLUMN IF NOT EXISTS holds_new text[] NOT NULL DEFAULT '{}';
