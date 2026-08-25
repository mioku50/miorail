-- Phase 4 router observations. A row is one completed, append-only measurement
-- run. Its JSON observations are hash-validated at both write and read; keeping
-- the exact quote legs together makes partial database writes impossible.
--
-- Direct-pool probes do not write here. This table is reserved for the explicit
-- approved-router set, so one venue miss can never become an asset miss.
CREATE TABLE IF NOT EXISTS official_cash_exit_runs (
  run_id            text        PRIMARY KEY,
  chain_id          integer     NOT NULL,
  token_address     text        NOT NULL,
  scope             text        NOT NULL,
  tenant_id         text,
  approved_sources  jsonb       NOT NULL,
  destinations      jsonb       NOT NULL,
  started_at        timestamptz NOT NULL,
  completed_at      timestamptz NOT NULL,
  observations      jsonb       NOT NULL,
  CONSTRAINT official_cash_exit_chain CHECK (chain_id = 8453),
  CONSTRAINT official_cash_exit_run_hash CHECK (run_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT official_cash_exit_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT official_cash_exit_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT official_cash_exit_scope CHECK (scope IN ('public_ladder', 'tenant_position')),
  CONSTRAINT official_cash_exit_tenant_scope CHECK (
    (scope = 'public_ladder' AND tenant_id IS NULL) OR
    (scope = 'tenant_position' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT official_cash_exit_sources_array CHECK (
    jsonb_typeof(approved_sources) = 'array' AND jsonb_array_length(approved_sources) > 0
  ),
  CONSTRAINT official_cash_exit_destinations_array CHECK (
    jsonb_typeof(destinations) = 'array' AND jsonb_array_length(destinations) > 0
  ),
  CONSTRAINT official_cash_exit_observations_array CHECK (
    jsonb_typeof(observations) = 'array' AND jsonb_array_length(observations) > 0
  ),
  CONSTRAINT official_cash_exit_chronology CHECK (completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS official_cash_exit_latest_public_idx
  ON official_cash_exit_runs (chain_id, token_address, completed_at DESC)
  WHERE scope = 'public_ladder';

CREATE INDEX IF NOT EXISTS official_cash_exit_latest_tenant_idx
  ON official_cash_exit_runs (tenant_id, chain_id, token_address, completed_at DESC)
  WHERE scope = 'tenant_position';
