CREATE TABLE IF NOT EXISTS "base_mcp_oauth_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "encrypted_tokens" text,
  "encrypted_client_info" text,
  "encrypted_discovery_state" text,
  "token_expires_at" timestamp,
  "status" text NOT NULL,
  "last_error" text,
  "connected_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "base_mcp_oauth_states" (
  "state_hash" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "encrypted_code_verifier" text NOT NULL,
  "return_to" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "base_mcp_oauth_tokens" ADD CONSTRAINT "base_mcp_oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "base_mcp_oauth_states" ADD CONSTRAINT "base_mcp_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "base_mcp_oauth_tokens_user_provider_idx" ON "base_mcp_oauth_tokens" USING btree ("user_id","provider");
CREATE INDEX IF NOT EXISTS "base_mcp_oauth_states_user_expires_idx" ON "base_mcp_oauth_states" USING btree ("user_id","expires_at");
