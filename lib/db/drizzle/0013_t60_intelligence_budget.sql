CREATE TABLE "intelligence_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"spend_permission_id" text NOT NULL,
	"status" text NOT NULL,
	"period_type" text NOT NULL,
	"period_limit_atomic" numeric(78, 0) NOT NULL,
	"period_spent_atomic" numeric(78, 0) DEFAULT '0' NOT NULL,
	"reserved_atomic" numeric(78, 0) DEFAULT '0' NOT NULL,
	"max_per_call_atomic" numeric(78, 0) NOT NULL,
	"allowed_categories" jsonb NOT NULL,
	"period_started_at" timestamp with time zone,
	"period_ends_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"budget_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intelligence_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_budgets_spend_permission_id_spend_permissions_id_fk" FOREIGN KEY ("spend_permission_id") REFERENCES "public"."spend_permissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_budgets_status_check" CHECK ("intelligence_budgets"."status" IN ('active', 'paused', 'revoked', 'expired')),
	CONSTRAINT "intelligence_budgets_period_type_check" CHECK ("intelligence_budgets"."period_type" IN ('monthly')),
	CONSTRAINT "intelligence_budgets_amounts_check" CHECK ("intelligence_budgets"."period_limit_atomic" >= 0 AND "intelligence_budgets"."period_spent_atomic" >= 0 AND "intelligence_budgets"."reserved_atomic" >= 0 AND "intelligence_budgets"."max_per_call_atomic" >= 0 AND "intelligence_budgets"."max_per_call_atomic" <= "intelligence_budgets"."period_limit_atomic")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_budgets_active_permission_unique" ON "intelligence_budgets" USING btree ("spend_permission_id") WHERE "intelligence_budgets"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "intelligence_budgets_user_wallet_chain_idx" ON "intelligence_budgets" USING btree ("user_id","wallet_address","chain_id");
--> statement-breakpoint
CREATE TABLE "intelligence_budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" text NOT NULL,
	"budget_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount_atomic" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intelligence_budget_reservations_budget_id_intelligence_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."intelligence_budgets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_budget_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_budget_reservations_status_check" CHECK ("intelligence_budget_reservations"."status" IN ('reserved', 'settled', 'released', 'expired')),
	CONSTRAINT "intelligence_budget_reservations_amount_check" CHECK ("intelligence_budget_reservations"."amount_atomic" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_budget_reservations_idempotency_key_unique" ON "intelligence_budget_reservations" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "intelligence_budget_reservations_budget_status_idx" ON "intelligence_budget_reservations" USING btree ("budget_id","status");
