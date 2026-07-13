CREATE TABLE IF NOT EXISTS "prepared_transaction_intents" (
  "action_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "normalized_intent_hash" text NOT NULL,
  "prepared_payload_hash" text NOT NULL,
  "normalized_intent" jsonb NOT NULL,
  "prepared_payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prepared_transaction_intents" ADD CONSTRAINT "prepared_transaction_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepared_transaction_intents_user_status_idx" ON "prepared_transaction_intents" USING btree ("user_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prepared_transaction_intents_expires_idx" ON "prepared_transaction_intents" USING btree ("expires_at");
