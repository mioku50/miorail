-- T65.1 §1: OpenSea NFT purchase storage. Additive only.
--
-- An NFT purchase shares nothing structural with a swap, an earn deposit or a
-- gift card: one indivisible token, one order hash, one native-ETH call, and a
-- proof whose success condition is an ONCHAIN OWNERSHIP READ. Forcing it into
-- the swap-shaped tables would mean storing a token id in a column named for
-- an amount, and a `goal` check that does not describe it.
--
-- Route runs are still shared (goal = 'nft'), because a run is a run. The
-- payloads are not.

ALTER TABLE "route_runs" DROP CONSTRAINT IF EXISTS "route_runs_goal_check";--> statement-breakpoint
ALTER TABLE "route_runs" ADD CONSTRAINT "route_runs_goal_check" CHECK ("goal" IN ('swap', 'earn', 'commerce', 'nft'));--> statement-breakpoint

CREATE TABLE "nft_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"asset_hash" text NOT NULL,
	"contract_address" text NOT NULL,
	"token_id" text NOT NULL,
	"order_hash" text NOT NULL,
	"protocol_address" text NOT NULL,
	"listing_price_wei" text NOT NULL,
	"listing_status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"listing_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_candidates_status_check" CHECK ("status" IN ('quoted', 'selected', 'expired', 'invalid', 'rejected')),
	-- V1 buys one ERC-721 with native ETH. A row that says otherwise cannot exist.
	CONSTRAINT "nft_candidates_price_check" CHECK ("listing_price_wei" ~ '^[1-9][0-9]*$')
);--> statement-breakpoint

CREATE TABLE "nft_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"candidate_id" text,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"asset_hash" text NOT NULL,
	"provider_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_evidence_status_check" CHECK ("status" IN ('recorded', 'stale', 'rejected'))
);--> statement-breakpoint

CREATE TABLE "nft_route_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"candidate_hash" text,
	"asset_hash" text NOT NULL,
	"max_spend_wei" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_route_cards_status_check" CHECK ("status" IN ('ready', 'constrained', 'degraded', 'failed'))
);--> statement-breakpoint

CREATE TABLE "nft_purchase_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"route_card_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"order_hash" text NOT NULL,
	"protocol_address" text NOT NULL,
	"asset_hash" text NOT NULL,
	"contract_address" text NOT NULL,
	"token_id" text NOT NULL,
	"buyer" text NOT NULL,
	"listing_price_wei" text NOT NULL,
	"max_spend_wei" text NOT NULL,
	"calls_hash" text NOT NULL,
	"approved_calls_hash" text,
	"fulfillment_response_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_purchase_blueprints_status_check" CHECK ("status" IN ('draft', 'simulated', 'awaiting_approval', 'approved', 'submitted', 'confirmed', 'failed', 'expired')),
	-- The database refuses a blueprint that costs more than was authorized.
	-- The kernel checks this too; neither one alone is the guarantee.
	CONSTRAINT "nft_purchase_blueprints_ceiling_check" CHECK (("listing_price_wei")::numeric <= ("max_spend_wei")::numeric),
	-- Approved means approved of THESE calls. A row cannot record approval of
	-- a different batch than the one it holds.
	CONSTRAINT "nft_purchase_blueprints_approval_check" CHECK ("approved_calls_hash" IS NULL OR "approved_calls_hash" = "calls_hash")
);--> statement-breakpoint

CREATE TABLE "nft_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"proof_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"approved_calls_hash" text NOT NULL,
	"order_hash" text NOT NULL,
	"asset_hash" text NOT NULL,
	"contract_address" text NOT NULL,
	"token_id" text NOT NULL,
	"buyer" text NOT NULL,
	"seller" text NOT NULL,
	"final_status" text NOT NULL,
	"transaction_hash" text,
	"block_number" text,
	"gas_used" text,
	"actual_native_value_wei" text,
	"previous_owner" text,
	"new_owner" text,
	"ownership_block_number" text,
	"payload" jsonb NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_proofs_status_check" CHECK ("status" IN ('open', 'finalized')),
	CONSTRAINT "nft_proofs_final_status_check" CHECK ("final_status" IN ('pending', 'completed', 'reconciliation_required', 'transaction_failed', 'failed')),
	-- `completed` requires an ownership read naming a new owner. The rule that
	-- a successful receipt is not a purchase is enforced HERE too, not only in
	-- the contract — a migration or a direct write cannot bypass it.
	CONSTRAINT "nft_proofs_ownership_check" CHECK ("final_status" <> 'completed' OR ("new_owner" IS NOT NULL AND "ownership_block_number" IS NOT NULL)),
	-- A proof still waiting for reconciliation is not finalized.
	CONSTRAINT "nft_proofs_open_check" CHECK ("final_status" NOT IN ('pending', 'reconciliation_required') OR "status" = 'open')
);--> statement-breakpoint

CREATE TABLE "nft_proof_events" (
	"id" text PRIMARY KEY NOT NULL,
	"proof_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"event_hash" text NOT NULL,
	"proof_hash" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_kind" text NOT NULL,
	"final_status" text NOT NULL,
	"detail" text,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nft_proof_events_status_check" CHECK ("status" = 'recorded'),
	CONSTRAINT "nft_proof_events_kind_check" CHECK ("event_kind" IN ('blueprint_prepared', 'blueprint_approved', 'submission_recorded', 'receipt_observed', 'transfer_observed', 'ownership_read', 'reconciliation_attempted', 'finalized')),
	CONSTRAINT "nft_proof_events_sequence_check" CHECK ("sequence" >= 0)
);--> statement-breakpoint

ALTER TABLE "nft_candidates" ADD CONSTRAINT "nft_candidates_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_candidates" ADD CONSTRAINT "nft_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_evidence" ADD CONSTRAINT "nft_evidence_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_evidence" ADD CONSTRAINT "nft_evidence_candidate_id_nft_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."nft_candidates"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_evidence" ADD CONSTRAINT "nft_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_route_cards" ADD CONSTRAINT "nft_route_cards_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_route_cards" ADD CONSTRAINT "nft_route_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_route_card_id_nft_route_cards_id_fk" FOREIGN KEY ("route_card_id") REFERENCES "public"."nft_route_cards"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_proofs" ADD CONSTRAINT "nft_proofs_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_proofs" ADD CONSTRAINT "nft_proofs_blueprint_id_nft_purchase_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."nft_purchase_blueprints"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_proofs" ADD CONSTRAINT "nft_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_proof_events" ADD CONSTRAINT "nft_proof_events_proof_id_nft_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."nft_proofs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "nft_proof_events" ADD CONSTRAINT "nft_proof_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint

-- The real guarantees, as indexes.
--
-- One candidate per (run, order): re-comparing the same listing updates
-- nothing and duplicates nothing.
CREATE UNIQUE INDEX "nft_candidates_run_order_unique" ON "nft_candidates" ("route_run_id", "order_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_candidates_run_hash_unique" ON "nft_candidates" ("route_run_id", "candidate_hash");--> statement-breakpoint
CREATE INDEX "nft_candidates_user_token_idx" ON "nft_candidates" ("user_id", "contract_address", "token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_evidence_run_hash_unique" ON "nft_evidence" ("route_run_id", "evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_route_cards_run_hash_unique" ON "nft_route_cards" ("route_run_id", "route_card_hash");--> statement-breakpoint
-- ONE blueprint per Route Card. A second prepare returns the first; there is
-- no way to open two wallet prompts for the same purchase.
CREATE UNIQUE INDEX "nft_purchase_blueprints_card_unique" ON "nft_purchase_blueprints" ("route_card_id");--> statement-breakpoint
CREATE INDEX "nft_purchase_blueprints_user_status_idx" ON "nft_purchase_blueprints" ("user_id", "status", "created_at");--> statement-breakpoint
-- ONE proof per blueprint, and one per order: the same purchase cannot be
-- proven twice with two different answers.
CREATE UNIQUE INDEX "nft_proofs_blueprint_unique" ON "nft_proofs" ("blueprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nft_proofs_user_order_unique" ON "nft_proofs" ("user_id", "order_hash");--> statement-breakpoint
CREATE INDEX "nft_proofs_user_final_status_idx" ON "nft_proofs" ("user_id", "final_status", "created_at");--> statement-breakpoint
-- Append-only: a sequence number is claimed once and never rewritten.
CREATE UNIQUE INDEX "nft_proof_events_proof_sequence_unique" ON "nft_proof_events" ("proof_id", "sequence");
