-- T65.1 Final §3: two submission outcomes the blueprint could not previously
-- express.
--
--   'cancelled'         — the user refused in the wallet. Nothing was sent.
--   'submitted_unknown' — the batch left the wallet but what became of it could
--                         not be established.
--
-- Both are kept DISTINCT from 'submitted' on purpose. Folding a refusal or an
-- unreadable batch into 'submitted' would put a row on the screen that claims
-- a transaction is pending when no transaction is known to exist — the exact
-- shape of overclaiming this family is built to refuse.
--
-- Additive: it only widens a CHECK. No existing row can violate the new one,
-- because the new set is a strict superset of the old.

ALTER TABLE "nft_purchase_blueprints" DROP CONSTRAINT IF EXISTS "nft_purchase_blueprints_status_check";--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_status_check" CHECK ("status" IN ('draft', 'simulated', 'awaiting_approval', 'approved', 'submitted', 'submitted_unknown', 'confirmed', 'failed', 'cancelled', 'expired'));--> statement-breakpoint

-- A cancelled blueprint is one where nothing went out. The row must not also
-- claim a submission: no batch id, no transaction hash, no submitted_at.
ALTER TABLE "nft_purchase_blueprints" DROP CONSTRAINT IF EXISTS "nft_purchase_blueprints_cancelled_check";--> statement-breakpoint
ALTER TABLE "nft_purchase_blueprints" ADD CONSTRAINT "nft_purchase_blueprints_cancelled_check" CHECK ("status" <> 'cancelled' OR ("submitted_at" IS NULL AND "submission_batch_id" IS NULL AND "submitted_transaction_hash" IS NULL));
