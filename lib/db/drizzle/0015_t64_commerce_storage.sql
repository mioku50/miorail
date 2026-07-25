-- T64.2: durable Commerce storage. Additive only — no swap or earn payload is
-- mutated. Commerce runs live in route_runs (goal='commerce'); every commerce
-- payload gets its own versioned table, because the family has no Execution
-- Blueprint and no swap-shaped Route Proof.
--
-- Nothing in these tables holds a redemption code, a PIN, an eSIM URL, or a
-- provider credential: orders and events carry states, amounts and ids only.

ALTER TABLE "route_runs" DROP CONSTRAINT "route_runs_goal_check";--> statement-breakpoint
ALTER TABLE "route_runs" ADD CONSTRAINT "route_runs_goal_check" CHECK ("route_runs"."goal" IN ('swap', 'earn', 'commerce'));--> statement-breakpoint
CREATE TABLE "commerce_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"product_id" text NOT NULL,
	"package_value" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_candidates_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_candidates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_candidates_status_check" CHECK ("commerce_candidates"."status" IN ('quoted', 'selected', 'expired', 'invalid', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_candidates_run_hash_unique" ON "commerce_candidates" USING btree ("route_run_id", "candidate_hash");--> statement-breakpoint
CREATE INDEX "commerce_candidates_run_product_idx" ON "commerce_candidates" USING btree ("route_run_id", "product_id");--> statement-breakpoint
CREATE TABLE "commerce_evidence" (
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
	CONSTRAINT "commerce_evidence_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_evidence_candidate_id_commerce_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."commerce_candidates"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_evidence_status_check" CHECK ("commerce_evidence"."status" IN ('fresh', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_evidence_run_hash_unique" ON "commerce_evidence" USING btree ("route_run_id", "evidence_hash");--> statement-breakpoint
CREATE INDEX "commerce_evidence_candidate_idx" ON "commerce_evidence" USING btree ("candidate_id");--> statement-breakpoint
CREATE TABLE "commerce_route_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_route_cards_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_route_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_route_cards_status_check" CHECK ("commerce_route_cards"."status" IN ('ready', 'degraded', 'selected', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_route_cards_run_hash_unique" ON "commerce_route_cards" USING btree ("route_run_id", "route_card_hash");--> statement-breakpoint
CREATE INDEX "commerce_route_cards_user_created_idx" ON "commerce_route_cards" USING btree ("user_id", "created_at");--> statement-breakpoint
CREATE TABLE "commerce_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"route_run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"route_card_hash" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"product_id" text NOT NULL,
	"package_value" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_status" text NOT NULL,
	"invoice_id" text,
	"exact_amount_atomic" text,
	"estimated_amount_atomic" text,
	"pay_to" text,
	"refund_address" text NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_orders_route_run_id_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."route_runs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_orders_status_check" CHECK ("commerce_orders"."status" IN ('pending', 'created', 'payment_pending', 'payment_confirmed', 'fulfilling', 'delivered', 'failed', 'expired', 'creation_unknown')),
	CONSTRAINT "commerce_orders_provider_status_check" CHECK ("commerce_orders"."provider_status" IN ('invoice_created', 'payment_pending', 'payment_settled', 'order_confirmed', 'delivery_pending', 'delivered', 'expired', 'cancelled', 'unknown'))
);
--> statement-breakpoint
-- The idempotency guard: tenant + wallet + routeCardHash + packageId +
-- requestId collapse into idempotency_key, so a repeated checkout can only
-- ever return the row that already exists.
CREATE UNIQUE INDEX "commerce_orders_user_idempotency_unique" ON "commerce_orders" USING btree ("user_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_orders_user_invoice_unique" ON "commerce_orders" USING btree ("user_id", "invoice_id");--> statement-breakpoint
CREATE INDEX "commerce_orders_user_created_idx" ON "commerce_orders" USING btree ("user_id", "created_at");--> statement-breakpoint
CREATE TABLE "commerce_order_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"payment_state" text NOT NULL,
	"delivery_state" text NOT NULL,
	"detail" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_order_events_order_id_commerce_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_order_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_order_events_status_check" CHECK ("commerce_order_events"."status" IN ('invoice_created', 'payment_pending', 'payment_settled', 'order_confirmed', 'delivery_pending', 'delivered', 'expired', 'cancelled', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX "commerce_order_events_order_observed_idx" ON "commerce_order_events" USING btree ("order_id", "observed_at");--> statement-breakpoint
CREATE TABLE "commerce_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"final_status" text NOT NULL,
	"proof_hash" text NOT NULL,
	"order_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commerce_proofs_order_id_commerce_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."commerce_orders"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "commerce_proofs_final_status_check" CHECK ("commerce_proofs"."final_status" IN ('pending', 'delivered', 'partial_delivery', 'order_unconfirmed', 'payment_failed', 'failed', 'reconciliation_required'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_proofs_order_unique" ON "commerce_proofs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "commerce_proofs_user_status_idx" ON "commerce_proofs" USING btree ("user_id", "final_status");
