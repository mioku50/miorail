-- Phase 10C.2A attaches the reference/session/basis facts observed during a
-- NEW cash-exit measurement to that same immutable run. Existing rows remain
-- NULL: no current feed or calendar is projected backwards into old history.

ALTER TABLE official_cash_exit_runs
  ADD COLUMN IF NOT EXISTS market_reality_snapshots jsonb;

ALTER TABLE official_cash_exit_runs
  DROP CONSTRAINT IF EXISTS official_cash_exit_market_reality_snapshots_array;

ALTER TABLE official_cash_exit_runs
  ADD CONSTRAINT official_cash_exit_market_reality_snapshots_array CHECK (
    market_reality_snapshots IS NULL OR (
      jsonb_typeof(market_reality_snapshots) = 'array'
      AND jsonb_array_length(market_reality_snapshots) > 0
    )
  );
