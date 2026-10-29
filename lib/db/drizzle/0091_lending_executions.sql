-- Wallet-owned lending reviews and atomic submission locks. Calls are private
-- server-prepared data, never a signature, token or a client verdict.
CREATE TABLE IF NOT EXISTS lending_executions (
  execution_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  draft_id text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('morpho', 'aave-v4')),
  operation text NOT NULL CHECK (operation IN ('borrow', 'repay')),
  market_id text NOT NULL,
  calls_hash text NOT NULL CHECK (calls_hash ~ '^0x[0-9a-f]{64}$'),
  run_json jsonb NOT NULL CHECK (jsonb_typeof(run_json) = 'object'),
  state text NOT NULL CHECK (state IN ('ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed')),
  attempt_id uuid,
  batch_id text CHECK (batch_id IS NULL OR length(batch_id) BETWEEN 1 AND 2000),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  verification_json jsonb,
  error_code text,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT lending_execution_owner CHECK (wallet_address ~ '^0x[0-9a-f]{40}$' AND tenant_id = 'eip155:8453:' || wallet_address),
  CONSTRAINT lending_execution_draft CHECK (draft_id ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  CONSTRAINT lending_execution_market CHECK (market_id ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  CONSTRAINT lending_execution_run_binding CHECK (run_json @> jsonb_build_object(
    'state', 'ready', 'callsHash', calls_hash,
    'facts', jsonb_build_object('venue', venue, 'operation', operation, 'marketId', market_id))),
  CONSTRAINT lending_execution_attempt CHECK ((state = 'ready' AND attempt_id IS NULL) OR (state <> 'ready' AND attempt_id IS NOT NULL)),
  CONSTRAINT lending_execution_verified CHECK (state NOT IN ('confirmed', 'failed') OR (transaction_hash IS NOT NULL AND verification_json IS NOT NULL)),
  UNIQUE (tenant_id, wallet_address, draft_id)
);
--> statement-breakpoint
-- Aave's USDC debt is shared across its collateral reserves, so its whole
-- spoke is one lock scope even if a review names a particular stock reserve.
CREATE UNIQUE INDEX IF NOT EXISTS lending_execution_active_market
  ON lending_executions (tenant_id, wallet_address, venue,
    (CASE WHEN venue = 'aave-v4' THEN 'aave-v4' ELSE market_id END))
  WHERE state IN ('awaiting_wallet', 'submitted', 'unknown');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lending_execution_owner_latest
  ON lending_executions (tenant_id, wallet_address, created_at DESC);
--> statement-breakpoint
ALTER TABLE lending_executions OWNER TO miorail_user;
