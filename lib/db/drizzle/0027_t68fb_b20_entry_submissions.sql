-- T68F-B: submission attempts for prepared B20 entry plans. Additive only.
--
-- WHY NOT `submission_attempts`:
--
--   That table requires `route_run_id` and `blueprint_id` (both NOT NULL,
--   both foreign keys) and pins `goal IN ('swap','earn','nft')`. This family
--   has neither a route run nor an execution blueprint, because a B20 token
--   cannot form a `RouteIntentV1`. Reusing it would have meant nullable
--   foreign keys and a widened goal CHECK on the table three other families
--   depend on for submission recovery.
--
-- WHY THE PLAN IS NOT UPDATED IN PLACE:
--
--   Migration 0026 stores the plan as immutable evidence. The outcome of an
--   execution is not a property of the plan that authorised it, and writing it
--   there would mean the record justifying a signature changes after the
--   signature. Everything that happens lives here instead.
--
-- WHAT THE SCHEMA ENFORCES:
--
--   * ONE LIVE ATTEMPT PER PLAN. The partial unique index below is the whole
--     defence against the failure that costs real money: a double click, a
--     remount or a retried fetch producing a second wallet batch. It is a
--     database guarantee, not an application promise.
--
--   * A STATE THAT PRESUPPOSES A BATCH CANNOT EXIST WITHOUT ITS ID. Without a
--     batch id there is nothing to ask a status provider about, so `submitted`
--     and `reconciling` require one.
--
--   * TERMINAL OUTCOMES ARE NAMED, NEVER GENERIC. `user_rejected` and
--     `entry_reverted` are both "not succeeded" and mean entirely different
--     things; collapsing them to `failed` would let a declined wallet prompt
--     read as a token that reverts on chain.
--
--   * AN OUTCOME MUST MATCH WHETHER ANYTHING WAS SENT. A pre-submission
--     outcome cannot carry a batch id, and a post-submission outcome cannot
--     exist without one.
--
--   * NO CREDENTIALS. `error_code` is a short code, never a provider message:
--     provider messages carry endpoints, and endpoints carry keys. There is no
--     column for a raw body, an RPC URL, a header or a signature.

CREATE TABLE "b20_entry_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"plan_id" text NOT NULL,
	"clearance_id" text NOT NULL,
	-- Must equal the plan's own calls hash. This is what makes "the wallet was
	-- handed exactly what was simulated" checkable rather than assumed.
	"submitted_calls_hash" text NOT NULL,
	-- Null until the wallet returns one. Its ABSENCE is the honest
	-- unrecoverable state.
	"batch_id" text,
	"status" text NOT NULL,
	"terminal_outcome" text,
	"error_code" text,
	"submitted_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_entry_submission_plan_fk" FOREIGN KEY ("plan_id")
		REFERENCES "public"."b20_entry_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "b20_entry_submission_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_entry_submission_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_entry_submission_calls_hash_check"
		CHECK ("submitted_calls_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_submission_status_check" CHECK ("status" IN (
		'awaiting_wallet_approval',
		'submitted',
		'reconciling',
		'terminal'
	)),
	CONSTRAINT "b20_entry_submission_outcome_values_check" CHECK (
		"terminal_outcome" IS NULL OR "terminal_outcome" IN (
			'entry_succeeded',
			'entry_reverted',
			'submitted_unknown',
			'reconciliation_required',
			'user_rejected',
			'cancelled_before_submission'
		)
	),
	-- An outcome exists exactly when the attempt is terminal.
	CONSTRAINT "b20_entry_submission_outcome_check"
		CHECK (("status" = 'terminal') = ("terminal_outcome" IS NOT NULL)),
	-- A state that presupposes a wallet batch cannot exist without its id.
	CONSTRAINT "b20_entry_submission_batch_presence_check" CHECK (
		"status" NOT IN ('submitted', 'reconciling') OR "batch_id" IS NOT NULL
	),
	CONSTRAINT "b20_entry_submission_submitted_at_check"
		CHECK ("batch_id" IS NULL OR "submitted_at" IS NOT NULL),
	-- An outcome must match whether anything was actually sent.
	CONSTRAINT "b20_entry_submission_outcome_batch_check" CHECK (
		"terminal_outcome" IS NULL
		OR ("terminal_outcome" IN ('user_rejected', 'cancelled_before_submission'))
			= ("batch_id" IS NULL)
	)
);
--> statement-breakpoint

-- THE guarantee: at most one attempt per plan that is still live or that ever
-- reached the chain. A declined prompt sent nothing, so it does not hold the
-- slot and the user may return to Review and try again.
CREATE UNIQUE INDEX "b20_entry_submission_live_unique"
	ON "b20_entry_submissions" ("plan_id")
	WHERE "terminal_outcome" IS NULL
		OR "terminal_outcome" NOT IN ('user_rejected', 'cancelled_before_submission');
--> statement-breakpoint

-- One wallet batch belongs to exactly one attempt. Two attempts naming one
-- batch would make "which submission is this transaction?" ambiguous, and that
-- question has one answer.
CREATE UNIQUE INDEX "b20_entry_submission_batch_unique"
	ON "b20_entry_submissions" ("batch_id")
	WHERE "batch_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX "b20_entry_submission_wallet_status_idx"
	ON "b20_entry_submissions" ("tenant_id", "wallet_address", "status", "created_at" DESC);
