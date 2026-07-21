-- T62: persisted earn execution wiring. Additive only — no swap payload is
-- mutated. Earn runs live in route_runs (goal='earn') so the goal-agnostic
-- execution_blueprints / route_proofs / route_proof_events machinery is reused;
-- earn candidates/evidence/scores/cards get their own tables.

ALTER TABLE "route_runs" ADD COLUMN "goal" text DEFAULT 'swap' NOT NULL;--> statement-breakpoint
ALTER TABLE "route_runs" ADD CONSTRAINT "route_runs_goal_check" CHECK ("route_runs"."goal" IN ('swap', 'earn'));--> statement-breakpoint
ALTER TABLE "execution_blueprints" ADD COLUMN "goal" text DEFAULT 'swap' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_blueprints" ADD CONSTRAINT "execution_blueprints_goal_check" CHECK ("execution_blueprints"."goal" IN ('swap', 'earn'));--> statement-breakpoint
CREATE TABLE "earn_route_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earn_route_candidates_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_candidates_status_check" CHECK ("earn_route_candidates"."status" IN ('quoted', 'selected', 'expired', 'invalid', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earn_route_candidates_run_hash_unique" ON "earn_route_candidates" USING btree ("route_run_id", "candidate_hash");--> statement-breakpoint
CREATE INDEX "earn_route_candidates_run_status_idx" ON "earn_route_candidates" USING btree ("route_run_id", "status");--> statement-breakpoint
CREATE TABLE "earn_route_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"candidate_id" text,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"provider_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earn_route_evidence_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_evidence_candidate_id_earn_route_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."earn_route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_evidence_status_check" CHECK ("earn_route_evidence"."status" IN ('fresh', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earn_route_evidence_run_hash_unique" ON "earn_route_evidence" USING btree ("route_run_id", "evidence_hash");--> statement-breakpoint
CREATE INDEX "earn_route_evidence_candidate_idx" ON "earn_route_evidence" USING btree ("candidate_id");--> statement-breakpoint
CREATE TABLE "earn_score_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"score_hash" text NOT NULL,
	"scoring_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earn_score_snapshots_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_score_snapshots_candidate_id_earn_route_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."earn_route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_score_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_score_snapshots_status_check" CHECK ("earn_score_snapshots"."status" IN ('scored', 'partially_scored', 'not_scored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earn_score_snapshots_candidate_hash_unique" ON "earn_score_snapshots" USING btree ("candidate_id", "score_hash");--> statement-breakpoint
CREATE INDEX "earn_score_snapshots_run_candidate_idx" ON "earn_score_snapshots" USING btree ("route_run_id", "candidate_id");--> statement-breakpoint
CREATE TABLE "earn_route_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"selected_candidate_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earn_route_cards_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_cards_selected_candidate_id_earn_route_candidates_id_fk" FOREIGN KEY ("selected_candidate_id") REFERENCES "public"."earn_route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "earn_route_cards_status_check" CHECK ("earn_route_cards"."status" IN ('ready', 'degraded', 'selected', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "earn_route_cards_run_hash_unique" ON "earn_route_cards" USING btree ("route_run_id", "route_card_hash");--> statement-breakpoint
CREATE INDEX "earn_route_cards_run_created_idx" ON "earn_route_cards" USING btree ("route_run_id", "created_at");
