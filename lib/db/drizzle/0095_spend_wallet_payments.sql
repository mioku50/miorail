-- Still Spend: a Bitrefill invoice paid from the USDC already in the wallet,
-- one exact transfer and no loan (2026-11-03). One row per invoice and
-- wallet; calls are private server-prepared data, never a signature, token or
-- a client verdict. A loan's review of the same invoice lives in
-- lending_executions, and the API checks the two against each other before
-- either is armed, so one invoice is paid once.
CREATE TABLE IF NOT EXISTS spend_wallet_payments (
  payment_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  order_id text NOT NULL,
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
  CONSTRAINT spend_wallet_payment_owner CHECK (wallet_address ~ '^0x[0-9a-f]{40}$' AND tenant_id = 'eip155:8453:' || wallet_address),
  CONSTRAINT spend_wallet_payment_order CHECK (order_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT spend_wallet_payment_run_binding CHECK (run_json @> jsonb_build_object(
    'state', 'ready', 'callsHash', calls_hash,
    'facts', jsonb_build_object('payment', jsonb_build_object('orderId', order_id)))),
  CONSTRAINT spend_wallet_payment_attempt CHECK ((state = 'ready' AND attempt_id IS NULL) OR (state <> 'ready' AND attempt_id IS NOT NULL)),
  CONSTRAINT spend_wallet_payment_verified CHECK (state NOT IN ('confirmed', 'failed') OR (transaction_hash IS NOT NULL AND verification_json IS NOT NULL)),
  UNIQUE (tenant_id, wallet_address, order_id)
);
--> statement-breakpoint
-- Production runs migrations as `miorail_user`, and the table must be its own.
-- A database without that role (a fresh clone, CI) has nobody to hand it to:
-- naming the role outright stopped the whole chain there with "role does not
-- exist". Editing an applied migration is safe: drizzle applies a file by its
-- journal time and never compares its text.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE spend_wallet_payments OWNER TO miorail_user';
  END IF;
END
$$;
