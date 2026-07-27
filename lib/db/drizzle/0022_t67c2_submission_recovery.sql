-- T67C.2: submission recovery and public proof shares. Additive only.
--
-- Neither table is financial truth. RouteProof, the NFT proof and their
-- append-only event chains remain the only record of what happened onchain;
-- these two tables are control-plane metadata, and the schema is written so
-- they cannot quietly become something more:
--
--   * submission_attempts has NO receipt, NO transaction hash, NO calldata and
--     NO amount column. An attempt can therefore never assert that an execution
--     succeeded — it can only carry the handle (batch_id) needed to go and ASK
--     the wallet what happened. Recovery reads; it never re-sends.
--
--   * public_proof_shares has NO copy of the proof. It maps an unguessable
--     public id onto a proof that already exists, so revoking a link removes
--     access and nothing else. A share cannot drift from the proof it points
--     at because it holds none of its content.
--
-- One batch id belongs to at most one attempt, and one blueprint has at most
-- one attempt still in flight. Both are unique indexes rather than checks in
-- application code, because "we already sent this" is exactly the fact a race
-- would otherwise let us lose.

CREATE TABLE "submission_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"goal" text NOT NULL,
	"route_run_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	-- Null until a proof exists for this blueprint; set once the submission
	-- route has recorded against one.
	"proof_id" text,
	"approved_calls_hash" text NOT NULL,
	-- Null until the wallet has handed back a batch id. Its ABSENCE is the
	-- honest unrecoverable state: without it there is nothing to ask about.
	"batch_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "submission_attempts_chain_check" CHECK ("chain_id" = 8453),
	-- Lowercase in the column, not merely lowercase by convention: a mixed-case
	-- duplicate would defeat every wallet-scoped lookup below.
	CONSTRAINT "submission_attempts_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "submission_attempts_goal_check" CHECK ("goal" IN ('swap', 'earn', 'nft')),
	CONSTRAINT "submission_attempts_calls_hash_check" CHECK ("approved_calls_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "submission_attempts_status_check" CHECK ("status" IN (
		'wallet_pending',
		'batch_observed',
		'submitted',
		'submitted_unknown',
		'confirmed',
		'failed',
		'cancelled',
		'abandoned'
	)),
	-- A state that presupposes a wallet batch cannot exist without its id.
	CONSTRAINT "submission_attempts_batch_presence_check" CHECK (
		"status" NOT IN ('batch_observed', 'submitted', 'submitted_unknown', 'confirmed')
		OR "batch_id" IS NOT NULL
	)
);
--> statement-breakpoint

-- One wallet batch belongs to exactly one attempt. Two attempts claiming the
-- same batch would make "which route did this transaction execute?" ambiguous,
-- and that question has one answer.
CREATE UNIQUE INDEX "submission_attempts_batch_unique"
	ON "submission_attempts" ("batch_id") WHERE "batch_id" IS NOT NULL;--> statement-breakpoint

-- At most one attempt per tenant + blueprint is still open. A terminal attempt
-- (failed / cancelled / abandoned) frees the blueprint for a genuinely new
-- attempt; an open one is resumed instead of duplicated.
CREATE UNIQUE INDEX "submission_attempts_active_unique"
	ON "submission_attempts" ("user_id", "blueprint_id")
	WHERE "status" IN ('wallet_pending', 'batch_observed', 'submitted', 'submitted_unknown', 'confirmed');--> statement-breakpoint

CREATE INDEX "submission_attempts_user_status_idx" ON "submission_attempts" ("user_id", "status");--> statement-breakpoint
CREATE INDEX "submission_attempts_user_blueprint_idx" ON "submission_attempts" ("user_id", "blueprint_id");--> statement-breakpoint
CREATE INDEX "submission_attempts_proof_idx" ON "submission_attempts" ("proof_id");--> statement-breakpoint
CREATE INDEX "submission_attempts_updated_idx" ON "submission_attempts" ("updated_at" DESC);--> statement-breakpoint

CREATE TABLE "public_proof_shares" (
	-- 24 random bytes as hex. Not a sequence, and not derived from the proof id:
	-- a public id must not be reachable by counting or by guessing at internals.
	"public_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"proof_family" text NOT NULL,
	"proof_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Set once, never cleared. Re-sharing mints a NEW id, so a revoked link can
	-- never come back to life.
	"revoked_at" timestamp with time zone,
	"bundle_schema_version" text NOT NULL,
	CONSTRAINT "public_proof_shares_family_check" CHECK ("proof_family" IN ('route', 'nft')),
	CONSTRAINT "public_proof_shares_id_check" CHECK ("public_id" ~ '^[0-9a-f]{48,}$')
);
--> statement-breakpoint

-- One live link per proof. A second Share returns the existing one rather than
-- scattering several public ids that all have to be revoked separately.
CREATE UNIQUE INDEX "public_proof_shares_active_unique"
	ON "public_proof_shares" ("proof_family", "proof_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "public_proof_shares_user_idx" ON "public_proof_shares" ("user_id", "created_at" DESC);
