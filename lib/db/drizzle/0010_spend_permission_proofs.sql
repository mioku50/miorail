-- Audit fix: idempotency ledger for incrementSpent. Neon HTTP driver retries any
-- fetch failure (including AbortController timeouts) up to DATABASE_FETCH_ATTEMPTS
-- times; without a proof-keyed ledger, a timeout after a committed UPDATE causes
-- the same spend increment to be replayed. See lib/autonomy/src/repository.ts.
CREATE TABLE IF NOT EXISTS "spend_permission_proofs" (
  "proof" text PRIMARY KEY NOT NULL,
  "permission_id" text NOT NULL,
  "amount" numeric(18, 6) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spend_permission_proofs" ADD CONSTRAINT "spend_permission_proofs_permission_id_spend_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."spend_permissions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spend_permission_proofs_permission_idx" ON "spend_permission_proofs" USING btree ("permission_id");
