-- A Spend Permission charge is an external side effect. The Base Account SDK
-- does not accept an application idempotency key, so Miorail must durably own
-- the attempt before calling it and must never automatically repeat an
-- uncertain outcome.

CREATE TABLE "intelligence_charge_attempts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"spend_permission_id" text NOT NULL,
	"expected_payer" text NOT NULL,
	"amount_atomic" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"proof" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "intelligence_charge_attempts_charge_fk" FOREIGN KEY ("charge_id")
		REFERENCES "public"."intelligence_charges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charge_attempts_user_fk" FOREIGN KEY ("user_id")
		REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charge_attempts_permission_fk" FOREIGN KEY ("spend_permission_id")
		REFERENCES "public"."spend_permissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
	CONSTRAINT "intelligence_charge_attempts_charge_unique" UNIQUE ("charge_id"),
	CONSTRAINT "intelligence_charge_attempts_status_check" CHECK ("status" IN (
		'claimed', 'settled', 'outcome_unknown'
	)),
	CONSTRAINT "intelligence_charge_attempts_payer_check" CHECK (
		"expected_payer" ~ '^0x[0-9a-f]{40}$'
	),
	CONSTRAINT "intelligence_charge_attempts_amount_check" CHECK ("amount_atomic" > 0),
	CONSTRAINT "intelligence_charge_attempts_proof_check" CHECK (
		("status" = 'settled' AND "proof" IS NOT NULL AND "settled_at" IS NOT NULL)
		OR ("status" <> 'settled' AND "settled_at" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX "intelligence_charge_attempts_user_status_idx"
	ON "intelligence_charge_attempts" ("user_id", "status", "updated_at" DESC);
--> statement-breakpoint

-- The coordinator resolves one active budget by tenant + wallet + chain. Make
-- that invariant authoritative in PostgreSQL, including concurrent onboarding
-- with two different Spend Permissions.
CREATE UNIQUE INDEX "intelligence_budgets_active_wallet_unique"
	ON "intelligence_budgets" ("user_id", lower("wallet_address"), "chain_id")
	WHERE "status" = 'active';
