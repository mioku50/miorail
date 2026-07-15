CREATE TABLE "route_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"intent_hash" text NOT NULL,
	"intent_payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "route_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_runs_chain_check" CHECK ("route_runs"."chain_id" IN (8453, 84532)),
	CONSTRAINT "route_runs_status_check" CHECK ("route_runs"."status" IN ('draft', 'ready', 'needs_clarification', 'collecting_candidates', 'collecting_evidence', 'scoring', 'card_ready', 'blueprint_ready', 'awaiting_approval', 'executing', 'reconciling', 'completed', 'partial_failure', 'failed', 'cancelled', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_runs_user_idempotency_unique" ON "route_runs" USING btree ("user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "route_runs_user_status_created_idx" ON "route_runs" USING btree ("user_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "route_runs_intent_hash_idx" ON "route_runs" USING btree ("intent_hash");
--> statement-breakpoint
CREATE TABLE "route_candidates" (
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
	CONSTRAINT "route_candidates_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_candidates_status_check" CHECK ("route_candidates"."status" IN ('quoted', 'selected', 'expired', 'invalid', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_candidates_run_hash_unique" ON "route_candidates" USING btree ("route_run_id", "candidate_hash");
--> statement-breakpoint
CREATE INDEX "route_candidates_run_status_idx" ON "route_candidates" USING btree ("route_run_id", "status");
--> statement-breakpoint
CREATE INDEX "route_candidates_provider_idx" ON "route_candidates" USING btree ("provider_id");
--> statement-breakpoint
CREATE TABLE "route_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"candidate_id" text,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"evidence_type" text NOT NULL,
	"provider_id" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"validation_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_evidence_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_candidate_id_route_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_status_check" CHECK ("route_evidence"."status" IN ('observed', 'expired', 'rejected', 'unavailable')),
	CONSTRAINT "route_evidence_validation_status_check" CHECK ("route_evidence"."validation_status" IN ('valid', 'stale', 'invalid', 'unavailable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_evidence_run_hash_unique" ON "route_evidence" USING btree ("route_run_id", "evidence_hash");
--> statement-breakpoint
CREATE INDEX "route_evidence_candidate_idx" ON "route_evidence" USING btree ("candidate_id");
--> statement-breakpoint
CREATE INDEX "route_evidence_provider_idx" ON "route_evidence" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX "route_evidence_type_idx" ON "route_evidence" USING btree ("evidence_type");
--> statement-breakpoint
CREATE INDEX "route_evidence_expires_idx" ON "route_evidence" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "route_evidence_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"evidence_set_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_evidence_sets_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_sets_candidate_id_route_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_evidence_sets_status_check" CHECK ("route_evidence_sets"."status" IN ('collecting', 'complete', 'partial', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_evidence_sets_run_hash_unique" ON "route_evidence_sets" USING btree ("route_run_id", "evidence_set_hash");
--> statement-breakpoint
CREATE INDEX "route_evidence_sets_run_status_idx" ON "route_evidence_sets" USING btree ("route_run_id", "status");
--> statement-breakpoint
CREATE INDEX "route_evidence_sets_candidate_idx" ON "route_evidence_sets" USING btree ("candidate_id");
--> statement-breakpoint
CREATE TABLE "route_score_snapshots" (
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
	CONSTRAINT "route_score_snapshots_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_score_snapshots_candidate_id_route_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_score_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_score_snapshots_status_check" CHECK ("route_score_snapshots"."status" IN ('scored', 'partially_scored', 'not_scored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_score_snapshots_candidate_hash_unique" ON "route_score_snapshots" USING btree ("candidate_id", "score_hash");
--> statement-breakpoint
CREATE INDEX "route_score_snapshots_run_candidate_idx" ON "route_score_snapshots" USING btree ("route_run_id", "candidate_id");
--> statement-breakpoint
CREATE TABLE "route_cards" (
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
	CONSTRAINT "route_cards_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_cards_selected_candidate_id_route_candidates_id_fk" FOREIGN KEY ("selected_candidate_id") REFERENCES "public"."route_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_cards_status_check" CHECK ("route_cards"."status" IN ('ready', 'selected', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_cards_run_hash_unique" ON "route_cards" USING btree ("route_run_id", "route_card_hash");
--> statement-breakpoint
CREATE INDEX "route_cards_run_created_idx" ON "route_cards" USING btree ("route_run_id", "created_at");
--> statement-breakpoint
CREATE TABLE "execution_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"selected_candidate_hash" text NOT NULL,
	"evidence_set_hash" text NOT NULL,
	"calls_hash" text NOT NULL,
	"approved_calls_hash" text,
	"prepared_transaction_action_id" text,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_blueprints_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "execution_blueprints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "execution_blueprints_prepared_transaction_action_id_prepared_transaction_intents_action_id_fk" FOREIGN KEY ("prepared_transaction_action_id") REFERENCES "public"."prepared_transaction_intents"("action_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "execution_blueprints_chain_check" CHECK ("execution_blueprints"."chain_id" IN (8453, 84532)),
	CONSTRAINT "execution_blueprints_status_check" CHECK ("execution_blueprints"."status" IN ('draft', 'ready_for_review', 'approved', 'expired', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_blueprints_run_hash_unique" ON "execution_blueprints" USING btree ("route_run_id", "blueprint_hash");
--> statement-breakpoint
CREATE INDEX "execution_blueprints_wallet_status_expiry_idx" ON "execution_blueprints" USING btree ("wallet_address", "status", "expires_at");
--> statement-breakpoint
CREATE TABLE "route_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"proof_hash" text NOT NULL,
	"approved_calls_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "route_proofs_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proofs_blueprint_id_execution_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."execution_blueprints"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proofs_status_check" CHECK ("route_proofs"."status" IN ('pending', 'completed', 'partial_failure', 'failed', 'cancelled', 'reconciliation_required'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_proofs_run_hash_unique" ON "route_proofs" USING btree ("route_run_id", "proof_hash");
--> statement-breakpoint
CREATE INDEX "route_proofs_run_status_idx" ON "route_proofs" USING btree ("route_run_id", "status");
--> statement-breakpoint
CREATE TABLE "route_proof_events" (
	"id" text PRIMARY KEY NOT NULL,
	"route_proof_id" text NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"event_type" text NOT NULL,
	"event_hash" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_proof_events_route_proof_id_route_proofs_id_fk" FOREIGN KEY ("route_proof_id") REFERENCES "public"."route_proofs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proof_events_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proof_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "route_proof_events_sequence_check" CHECK ("route_proof_events"."sequence" >= 0),
	CONSTRAINT "route_proof_events_status_check" CHECK ("route_proof_events"."status" = 'recorded')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "route_proof_events_proof_sequence_unique" ON "route_proof_events" USING btree ("route_proof_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "route_proof_events_proof_hash_unique" ON "route_proof_events" USING btree ("route_proof_id", "event_hash");
--> statement-breakpoint
CREATE INDEX "route_proof_events_run_created_idx" ON "route_proof_events" USING btree ("route_run_id", "created_at");
--> statement-breakpoint
CREATE TABLE "intelligence_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"evidence_id" text,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"charge_hash" text NOT NULL,
	"spend_permission_id" text,
	"x402_receipt_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intelligence_charges_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charges_evidence_id_route_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."route_evidence"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charges_spend_permission_id_spend_permissions_id_fk" FOREIGN KEY ("spend_permission_id") REFERENCES "public"."spend_permissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charges_x402_receipt_id_x402_receipts_id_fk" FOREIGN KEY ("x402_receipt_id") REFERENCES "public"."x402_receipts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charges_status_check" CHECK ("intelligence_charges"."status" IN ('quoted', 'reserved', 'payment_pending', 'settled', 'failed', 'reconciliation_required', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_charges_run_hash_unique" ON "intelligence_charges" USING btree ("route_run_id", "charge_hash");
--> statement-breakpoint
CREATE INDEX "intelligence_charges_run_status_idx" ON "intelligence_charges" USING btree ("route_run_id", "status");
