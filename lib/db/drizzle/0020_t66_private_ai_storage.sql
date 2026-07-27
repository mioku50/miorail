-- T66C/T66D: Private AI (Venice) route storage. Additive only.
--
-- TWO tables, where NFT needed six. An AI route has no separate reconciliation
-- to model: the Route Card is self-contained and hash-verified, the candidates
-- and evidence live inside it, and the proof is final the moment the provider
-- answers. Splitting them into their own tables would add foreign keys that
-- guard nothing.
--
-- WHAT IS DELIBERATELY ABSENT FROM EVERY COLUMN HERE: the prompt, the
-- completion, and the commitment nonce. `prompt_commitment` is a hash that
-- cannot be opened without a nonce this schema has no column for and no code
-- path writes. That is the whole privacy claim, expressed as a table.
--
-- Route runs are still shared (goal = 'private_ai'), because a run is a run.

ALTER TABLE "route_runs" DROP CONSTRAINT IF EXISTS "route_runs_goal_check";--> statement-breakpoint
ALTER TABLE "route_runs" ADD CONSTRAINT "route_runs_goal_check" CHECK ("goal" IN ('swap', 'earn', 'commerce', 'nft', 'private_ai'));--> statement-breakpoint

CREATE TABLE "ai_route_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	-- The commitment, never the prompt. There is no nonce column on purpose:
	-- a stored nonce beside a stored commitment reduces it to a plain hash,
	-- which is guessable for a short prompt.
	"prompt_commitment" text NOT NULL,
	"task_kind" text NOT NULL,
	"selected_model_id" text,
	"selected_candidate_hash" text,
	"privacy_mode" text,
	"estimated_cost_usd" text,
	"max_spend_usd" text NOT NULL,
	"x402_metered" boolean NOT NULL,
	-- The intent and the full card, including candidates, evidence and the
	-- seven dimensions. Neither contract can hold prompt text.
	"intent_payload" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_route_cards_status_check" CHECK ("status" IN ('ready', 'constrained', 'degraded', 'failed')),
	-- A card that selected a model must name it. A card that did not must not.
	CONSTRAINT "ai_route_cards_selection_check" CHECK (
		("selected_model_id" IS NULL) = ("selected_candidate_hash" IS NULL)
	),
	CONSTRAINT "ai_route_cards_ready_check" CHECK (
		"status" <> 'ready' OR "selected_model_id" IS NOT NULL
	),
	CONSTRAINT "ai_route_cards_privacy_check" CHECK (
		"privacy_mode" IS NULL OR "privacy_mode" IN ('private', 'anonymized', 'unknown')
	)
);--> statement-breakpoint

CREATE TABLE "ai_inference_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"route_card_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"proof_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"prompt_commitment" text NOT NULL,
	"model_id" text NOT NULL,
	"privacy_mode" text NOT NULL,
	-- Over response METADATA. There is no column for the completion text and
	-- no hash of it: one would let anyone holding this row confirm a guessed
	-- answer.
	"response_hash" text NOT NULL,
	"response_chars" integer NOT NULL,
	"finish_reason" text NOT NULL,
	"schema_validation" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	-- NULL is not zero: it means the provider reported no cost.
	"actual_cost_usd" text,
	"estimated_cost_usd" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"x402_metered" boolean NOT NULL,
	"final_status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_inference_proofs_status_check" CHECK ("status" IN ('open', 'finalized')),
	CONSTRAINT "ai_inference_proofs_final_status_check" CHECK (
		"final_status" IN ('pending', 'completed', 'truncated', 'refused', 'failed')
	),
	CONSTRAINT "ai_inference_proofs_finish_reason_check" CHECK (
		"finish_reason" IN ('stop', 'length', 'tool_calls', 'content_filter', 'unknown')
	),
	CONSTRAINT "ai_inference_proofs_schema_validation_check" CHECK (
		"schema_validation" IN ('not_requested', 'passed', 'failed')
	),
	-- A finalized proof has a time. A pending one is not finalized.
	CONSTRAINT "ai_inference_proofs_finalized_check" CHECK (
		("status" = 'finalized') = ("finalized_at" IS NOT NULL)
	),
	CONSTRAINT "ai_inference_proofs_pending_check" CHECK (
		"final_status" <> 'pending' OR "status" = 'open'
	)
);--> statement-breakpoint

ALTER TABLE "ai_route_cards" ADD CONSTRAINT "ai_route_cards_route_run_id_fk"
	FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_inference_proofs" ADD CONSTRAINT "ai_inference_proofs_route_run_id_fk"
	FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_inference_proofs" ADD CONSTRAINT "ai_inference_proofs_route_card_id_fk"
	FOREIGN KEY ("route_card_id") REFERENCES "public"."ai_route_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ONE card per run. A second comparison opens a new run rather than quietly
-- replacing the card a user is looking at.
CREATE UNIQUE INDEX "ai_route_cards_run_unique" ON "ai_route_cards" USING btree ("route_run_id");--> statement-breakpoint
-- ONE proof per card. This is what makes a double-submitted execution a
-- conflict instead of a second charge.
CREATE UNIQUE INDEX "ai_inference_proofs_card_unique" ON "ai_inference_proofs" USING btree ("route_card_id");--> statement-breakpoint
CREATE INDEX "ai_route_cards_user_idx" ON "ai_route_cards" USING btree ("user_id", "created_at");--> statement-breakpoint
CREATE INDEX "ai_inference_proofs_user_idx" ON "ai_inference_proofs" USING btree ("user_id", "created_at");
