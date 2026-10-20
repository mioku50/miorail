-- Ownership of an issued draft and links from its releases to existing proofs.
-- No signed token, executable calls or hashed domain record is stored here.
CREATE TABLE IF NOT EXISTS stock_action_executions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  action_draft_id text NOT NULL,
  clearance_id text,
  blueprint_id text UNIQUE,
  route_run_id text,
  created_at timestamptz NOT NULL,
  CONSTRAINT stock_action_execution_wallet CHECK (
    wallet_address ~ '^0x[0-9a-f]{40}$' AND tenant_id = 'eip155:8453:' || wallet_address
  ),
  CONSTRAINT stock_action_execution_draft CHECK (action_draft_id ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  CONSTRAINT stock_action_execution_release CHECK (
    (clearance_id IS NULL AND blueprint_id IS NULL AND route_run_id IS NULL)
    OR (clearance_id IS NOT NULL AND blueprint_id IS NOT NULL AND route_run_id IS NOT NULL
      AND clearance_id ~ '^[A-Za-z0-9:_.-]{1,200}$'
      AND blueprint_id ~ '^[A-Za-z0-9:_.-]{1,200}$'
      AND route_run_id ~ '^[A-Za-z0-9:_.-]{1,200}$')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS stock_action_execution_draft_owner
  ON stock_action_executions (action_draft_id) WHERE blueprint_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stock_action_execution_latest
  ON stock_action_executions (tenant_id, wallet_address, action_draft_id,
    (blueprint_id IS NOT NULL) DESC, created_at DESC, id DESC);
--> statement-breakpoint
ALTER TABLE stock_action_executions OWNER TO miorail_user;
