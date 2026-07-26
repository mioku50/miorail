-- T65.1 §4: what the client reported after calling the wallet.
--
-- Kept on the blueprint, NOT on the proof, because they are different claims.
-- A batch id and a transaction hash returned by wallet_sendCalls are what the
-- CLIENT says happened. `nft_proofs.transaction_hash` is what the server read
-- from Base. Storing both in one column would let an unverified client claim
-- become the record of an onchain fact, which is the one thing this family
-- exists to prevent.
--
-- Additive: three nullable columns on a table that has no rows in production.

ALTER TABLE "nft_purchase_blueprints" ADD COLUMN IF NOT EXISTS "submission_batch_id" text;--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD COLUMN IF NOT EXISTS "submitted_transaction_hash" text;--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;--> statement-breakpoint

-- A submission is recorded only against an approved blueprint. `submitted_at`
-- is the marker, so a row cannot claim a wallet was called before anyone
-- approved the calls.
ALTER TABLE "nft_purchase_blueprints" DROP CONSTRAINT IF EXISTS "nft_purchase_blueprints_submission_check";--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_submission_check" CHECK ("submitted_at" IS NULL OR "approved_calls_hash" IS NOT NULL);--> statement-breakpoint

-- One submission per blueprint: a duplicate POST returns the recorded one
-- instead of registering a second transaction for the same purchase.
CREATE UNIQUE INDEX IF NOT EXISTS "nft_purchase_blueprints_tx_unique" ON "nft_purchase_blueprints" ("submitted_transaction_hash") WHERE "submitted_transaction_hash" IS NOT NULL;
