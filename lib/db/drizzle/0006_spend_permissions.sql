CREATE TABLE IF NOT EXISTS "spend_permissions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "chain_id" integer NOT NULL,
  "asset" text,
  "limit" integer NOT NULL,
  "spent" integer DEFAULT 0 NOT NULL,
  "whitelist" jsonb NOT NULL,
  "expires_at" timestamp NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "spend_permissions" ADD CONSTRAINT "spend_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "spend_permissions_user_chain_active_idx" ON "spend_permissions" USING btree ("user_id","chain_id","is_active");
CREATE INDEX IF NOT EXISTS "spend_permissions_expires_idx" ON "spend_permissions" USING btree ("expires_at");
