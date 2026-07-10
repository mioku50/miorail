CREATE TABLE IF NOT EXISTS "autonomy_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "chain_id" integer NOT NULL,
  "wallet_address" text NOT NULL,
  "daily_limit" numeric(18, 6) NOT NULL,
  "max_per_action" numeric(18, 6) NOT NULL,
  "spent_today" numeric(18, 6) DEFAULT 0 NOT NULL,
  "reserved_today" numeric(18, 6) DEFAULT 0 NOT NULL,
  "period_started_at" timestamp DEFAULT now() NOT NULL,
  "whitelist" jsonb NOT NULL,
  "scope" text DEFAULT 'bounded-approval' NOT NULL,
  "expires_at" timestamp NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "kill_switch" boolean DEFAULT false NOT NULL,
  "mainnet_opt_in" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_user_chain_unique" ON "autonomy_policies" USING btree ("user_id", "chain_id");
CREATE INDEX IF NOT EXISTS "autonomy_policies_active_idx" ON "autonomy_policies" USING btree ("user_id", "chain_id", "is_active");
CREATE INDEX IF NOT EXISTS "autonomy_policies_expires_idx" ON "autonomy_policies" USING btree ("expires_at");

DO $$ BEGIN
 ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_limits_check" CHECK ("daily_limit" > 0 AND "max_per_action" > 0 AND "max_per_action" <= "daily_limit");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "autonomy_policies" ADD CONSTRAINT "autonomy_policies_accounting_check" CHECK ("spent_today" >= 0 AND "reserved_today" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "autonomy_execution_reservations" (
  "id" text PRIMARY KEY NOT NULL,
  "policy_id" text NOT NULL,
  "user_id" text NOT NULL,
  "action_id" text NOT NULL,
  "amount" numeric(18, 6) NOT NULL,
  "status" text DEFAULT 'reserved' NOT NULL,
  "proof" jsonb,
  "expires_at" timestamp NOT NULL,
  "settled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "autonomy_execution_reservations" ADD CONSTRAINT "autonomy_execution_reservations_policy_id_autonomy_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."autonomy_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "autonomy_execution_reservations" ADD CONSTRAINT "autonomy_execution_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_execution_reservations_action_unique" ON "autonomy_execution_reservations" USING btree ("action_id");
CREATE INDEX IF NOT EXISTS "autonomy_execution_reservations_policy_status_idx" ON "autonomy_execution_reservations" USING btree ("policy_id", "status");
CREATE INDEX IF NOT EXISTS "autonomy_execution_reservations_expires_idx" ON "autonomy_execution_reservations" USING btree ("expires_at");

DO $$ BEGIN
 ALTER TABLE "autonomy_execution_reservations" ADD CONSTRAINT "autonomy_execution_reservations_amount_check" CHECK ("amount" >= 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "autonomy_execution_reservations" ADD CONSTRAINT "autonomy_execution_reservations_status_check" CHECK ("status" IN ('reserved', 'settled', 'released', 'expired'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
