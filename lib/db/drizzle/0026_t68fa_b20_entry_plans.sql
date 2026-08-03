-- T68F-A: the prepared B20 Entry Plan, as a stored execution subject. Additive
-- only — no existing table is altered, so no other execution family changes
-- shape or gains a nullable column.
--
-- WHY A DEDICATED TABLE, AND NOT `execution_blueprints`:
--
--   `execution_blueprints` requires `intent_hash` and `selected_candidate_hash`,
--   which belong to a `RouteIntentV1`. A B20 token cannot form one:
--   `isTrustedRouteAsset` refuses it by design, and that refusal is the
--   boundary keeping arbitrary-token routing out of every other path in the
--   product. Representing this family there would have meant making those
--   columns nullable — weakening the guarantee for swap, earn, commerce and
--   NFT so one new family could avoid its own table. A clearance exists
--   precisely so that shortcut is never needed.
--
-- WHAT THE SCHEMA ENFORCES:
--
--   * IMMUTABLE. There is no update path in this migration's repository, and
--     the unique idempotency index makes a second preparation a conflict rather
--     than an overwrite. The stored calls are the ones the kernel checked and
--     the simulator ran; a plan whose bytes could change between review and
--     signature would make every check above it decorative.
--
--   * IDEMPOTENT on tenant + wallet + clearance + request. A retried
--     preparation returns the same plan rather than re-quoting the pool and
--     offering different numbers to a user who only refreshed.
--
--   * SHORT-LIVED, and the database says so. `expires_at` is NOT NULL and must
--     be after `created_at`. A plan encodes a swap deadline; past it the calls
--     revert on chain, and a Review screen offering them would be lying.
--
--   * NOT EXECUTABLE. `lifecycle` may only be `prepared` on insert, and a
--     `submitted` row must name a submission. There is no submission id,
--     transaction hash or batch id in this migration because none exists yet.
--
--   * NO CREDENTIALS. There is no column for an RPC URL, an API key, an
--     authorization header, a provider response body, a wallet signature or a
--     raw transaction. `calls` live inside the validated payload and are never
--     accepted from a client. A record that justifies a signature must not
--     become a place credentials accumulate.

CREATE TABLE "b20_entry_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"clearance_id" text NOT NULL,
	"clearance_hash" text NOT NULL,
	"profile_identity" text NOT NULL,
	"token_address" text NOT NULL,
	"quote_asset" text NOT NULL,
	"position_atomic" numeric(78, 0) NOT NULL,
	"entry_provider_id" text NOT NULL,
	"entry_source_key" text NOT NULL,
	"entry_route_hash" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"calls_hash" text NOT NULL,
	"fresh_quote_hash" text NOT NULL,
	"certification_control_snapshot_hash" text NOT NULL,
	"prepare_control_snapshot_hash" text NOT NULL,
	"certification_simulation_evidence_hash" text NOT NULL,
	"prepare_simulation_evidence_hash" text NOT NULL,
	"expected_output_atomic" numeric(78, 0) NOT NULL,
	"minimum_output_atomic" numeric(78, 0) NOT NULL,
	"coverage" text NOT NULL,
	"viable_route_confirmed" boolean NOT NULL,
	"best_route_confirmed" boolean NOT NULL,
	"certification_block_number" numeric(78, 0) NOT NULL,
	"prepare_control_block_number" numeric(78, 0),
	"prepare_simulation_block_number" numeric(78, 0) NOT NULL,
	"lifecycle" text DEFAULT 'prepared' NOT NULL,
	"submission_id" text,
	"request_id" text NOT NULL,
	-- The validated plan document, including the unsigned calls. Re-parsed on
	-- read, never trusted.
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_entry_plan_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_entry_plan_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_entry_plan_token_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	-- Canonical Base USDC and nothing else. This family quotes in one asset.
	CONSTRAINT "b20_entry_plan_quote_asset_check"
		CHECK ("quote_asset" = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
	CONSTRAINT "b20_entry_plan_blueprint_hash_check" CHECK ("blueprint_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_calls_hash_check" CHECK ("calls_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_clearance_hash_check" CHECK ("clearance_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_quote_hash_check" CHECK ("fresh_quote_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_route_hash_check" CHECK ("entry_route_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_cert_control_hash_check"
		CHECK ("certification_control_snapshot_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_prep_control_hash_check"
		CHECK ("prepare_control_snapshot_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_cert_sim_hash_check"
		CHECK ("certification_simulation_evidence_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_prep_sim_hash_check"
		CHECK ("prepare_simulation_evidence_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_plan_position_check" CHECK ("position_atomic" > 0),
	-- A plan that could settle for less than it promised is not a plan.
	CONSTRAINT "b20_entry_plan_minimum_check"
		CHECK ("minimum_output_atomic" > 0 AND "minimum_output_atomic" <= "expected_output_atomic"),
	CONSTRAINT "b20_entry_plan_coverage_check" CHECK ("coverage" IN ('complete', 'partial')),
	-- Only a CONFIRMED exit produces a plan. A quoted one never does, and the
	-- database refuses the row rather than trusting every writer.
	CONSTRAINT "b20_entry_plan_viable_check" CHECK ("viable_route_confirmed" = true),
	CONSTRAINT "b20_entry_plan_lifecycle_check"
		CHECK ("lifecycle" IN ('prepared', 'awaiting_wallet_approval', 'submitted', 'terminal')),
	-- Nothing reaches `submitted` without naming the submission it claims, and
	-- nothing that has not been submitted may carry one.
	CONSTRAINT "b20_entry_plan_submission_check"
		CHECK (("lifecycle" = 'submitted') = ("submission_id" IS NOT NULL)),
	-- A plan that never expires is a standing authorisation wearing a different
	-- name. The database refuses one.
	CONSTRAINT "b20_entry_plan_ttl_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint

-- The idempotency identity. This index IS the guarantee in §2: a repeated
-- preparation cannot become a second plan.
CREATE UNIQUE INDEX "b20_entry_plan_idempotency_unique"
	ON "b20_entry_plans" ("tenant_id", "wallet_address", "clearance_id", "request_id");
--> statement-breakpoint

-- The read path: this wallet's plans, newest first.
CREATE INDEX "b20_entry_plan_wallet_idx"
	ON "b20_entry_plans" ("tenant_id", "wallet_address", "created_at" DESC);
--> statement-breakpoint

-- The route-run-compatible record the later EIP-5792 and Route Proof machinery
-- will key on. It states the relationship and nothing more:
--   run -> execution_family -> prepared_plan_id -> clearance_id
--
-- Deliberately NOT a `route_runs` row: that table's `intent_payload` is a
-- `RouteIntentV1`, and forging one for an asset the intent schema refuses would
-- be a lie told to satisfy a foreign key.
CREATE TABLE "b20_entry_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"execution_family" text NOT NULL,
	"prepared_plan_id" text NOT NULL,
	"clearance_id" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"submission_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_entry_execution_plan_fk" FOREIGN KEY ("prepared_plan_id")
		REFERENCES "public"."b20_entry_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "b20_entry_execution_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_entry_execution_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	-- One family, named. A row that claimed another would be a different kind
	-- of execution reusing this table's guarantees.
	CONSTRAINT "b20_entry_execution_family_check"
		CHECK ("execution_family" = 'b20_opportunity_entry'),
	CONSTRAINT "b20_entry_execution_state_check"
		CHECK ("state" IN ('prepared', 'awaiting_wallet_approval', 'submitted', 'terminal')),
	CONSTRAINT "b20_entry_execution_submission_check"
		CHECK (("state" = 'submitted') = ("submission_id" IS NOT NULL))
);
--> statement-breakpoint

-- One run per plan. A second would mean two executions claiming one prepared
-- set of calls.
CREATE UNIQUE INDEX "b20_entry_execution_plan_unique"
	ON "b20_entry_executions" ("prepared_plan_id");
--> statement-breakpoint

CREATE INDEX "b20_entry_execution_wallet_state_idx"
	ON "b20_entry_executions" ("tenant_id", "wallet_address", "state", "created_at" DESC);
