-- T43: bind the existing single production tenant to the Web wallet that owns
-- those records. This migration intentionally never assigns data to 0x8e52… .
ALTER TABLE "x402_receipts" ADD COLUMN IF NOT EXISTS "user_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_receipts" ADD CONSTRAINT "x402_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "x402_receipts_user_created_idx" ON "x402_receipts" USING btree ("user_id", "created_at");
--> statement-breakpoint
INSERT INTO "users" ("id") VALUES ('eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70') ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_settings" WHERE "user_id" = 'default-user')
     AND EXISTS (SELECT 1 FROM "user_settings" WHERE "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70') THEN
    RAISE EXCEPTION 'T43 migration conflict: both default-user and target wallet have user_settings';
  END IF;
  IF EXISTS (SELECT 1 FROM "autonomy_policies" WHERE "user_id" = 'default-user')
     AND EXISTS (SELECT 1 FROM "autonomy_policies" WHERE "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70') THEN
    RAISE EXCEPTION 'T43 migration conflict: both default-user and target wallet have autonomy policies';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "chats" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "actions" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "workflows" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "user_settings" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "spend_permissions" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "audit_logs" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "autonomy_policies" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70', "wallet_address" = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "autonomy_execution_reservations" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "base_mcp_oauth_states" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70' WHERE "user_id" = 'default-user';
UPDATE "base_mcp_oauth_tokens" SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70', "id" = replace("id", 'default-user:', 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70:') WHERE "user_id" = 'default-user';
UPDATE "x402_receipts"
SET "user_id" = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70',
    "receipt" = jsonb_set("receipt", '{userId}', to_jsonb('eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70'::text), true)
WHERE "receipt"->>'userId' = 'default-user' AND COALESCE("receipt"->>'direction', '') = 'outgoing_buyer_payment';
-- Keep an empty compatibility identity for explicit test/DEV_SINGLE_USER mode.
-- Production middleware can never resolve it without that opt-in.
INSERT INTO "users" ("id") VALUES ('default-user') ON CONFLICT DO NOTHING;
