-- Canonical RouteProofV1 projections for the B20 opportunity-entry family.
-- Separate tables preserve the generic route_runs trusted-asset boundary while
-- the payload remains the same versioned RouteProofV1 used by swap and earn.

CREATE TABLE "b20_entry_route_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"plan_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"proof_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"evidence_set_hash" text NOT NULL,
	"blueprint_hash" text NOT NULL,
	"approved_calls_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "b20_entry_route_proof_plan_fk" FOREIGN KEY ("plan_id")
		REFERENCES "public"."b20_entry_plans"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "b20_entry_route_proof_attempt_fk" FOREIGN KEY ("attempt_id")
		REFERENCES "public"."b20_entry_submissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "b20_entry_route_proof_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_entry_route_proof_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_entry_route_proof_schema_check" CHECK ("schema_version" = 'route-proof/v1'),
	CONSTRAINT "b20_entry_route_proof_status_check" CHECK ("status" IN (
		'pending', 'completed', 'partial_failure', 'failed', 'cancelled', 'reconciliation_required'
	)),
	CONSTRAINT "b20_entry_route_proof_hashes_check" CHECK (
		"proof_hash" ~ '^0x[0-9a-f]{64}$'
		AND "intent_hash" ~ '^0x[0-9a-f]{64}$'
		AND "candidate_hash" ~ '^0x[0-9a-f]{64}$'
		AND "evidence_set_hash" ~ '^0x[0-9a-f]{64}$'
		AND "blueprint_hash" ~ '^0x[0-9a-f]{64}$'
		AND "approved_calls_hash" ~ '^0x[0-9a-f]{64}$'
	)
);
--> statement-breakpoint

CREATE INDEX "b20_entry_route_proof_plan_created_idx"
	ON "b20_entry_route_proofs" ("plan_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX "b20_entry_route_proof_attempt_unique"
	ON "b20_entry_route_proofs" ("attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "b20_entry_route_proof_hash_unique"
	ON "b20_entry_route_proofs" ("proof_hash");
--> statement-breakpoint
CREATE INDEX "b20_entry_route_proof_wallet_status_idx"
	ON "b20_entry_route_proofs" ("tenant_id", "wallet_address", "status", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "b20_entry_route_proof_events" (
	"id" text PRIMARY KEY NOT NULL,
	"route_proof_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"event_type" text NOT NULL,
	"event_hash" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "b20_entry_route_proof_event_proof_fk" FOREIGN KEY ("route_proof_id")
		REFERENCES "public"."b20_entry_route_proofs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "b20_entry_route_proof_event_schema_check" CHECK ("schema_version" = 'route-proof-event/v1'),
	CONSTRAINT "b20_entry_route_proof_event_hash_check" CHECK ("event_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_entry_route_proof_event_sequence_check" CHECK ("sequence" >= 0),
	CONSTRAINT "b20_entry_route_proof_event_type_check" CHECK ("event_type" IN (
		'blueprint_created', 'calls_approved', 'submitted', 'receipt_observed',
		'completed', 'partial_failure', 'reconciliation_updated'
	))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "b20_entry_route_proof_event_sequence_unique"
	ON "b20_entry_route_proof_events" ("route_proof_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "b20_entry_route_proof_event_hash_unique"
	ON "b20_entry_route_proof_events" ("event_hash");
--> statement-breakpoint
CREATE INDEX "b20_entry_route_proof_event_tenant_idx"
	ON "b20_entry_route_proof_events" ("tenant_id", "created_at");
