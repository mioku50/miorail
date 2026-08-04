-- T69-C.1 §1 — when a token was actually created.
--
-- The feed had only `detected_at`: when Miorail's ingestion worker reached the
-- block. With a cursor tens of thousands of blocks behind the head those are
-- not close, and presenting one as the other made every stored launch look
-- minutes old — on a surface whose entire premise is "this is new".
--
-- Nullable, with no backfill. Not every endpoint returns a block timestamp on
-- eth_getLogs, and rows written before this migration genuinely do not have
-- one. NULL is a real answer that the projection renders as "discovered by
-- Miorail at block N" rather than inventing a time.
--
-- Deliberately NOT added to the immutability trigger's identity set: a
-- timestamp learned later is new information about the same launch, not a
-- changed identity. Nothing in this migration touches the cursor, the
-- (chain_id, transaction_hash, log_index) uniqueness, or canonicality.

ALTER TABLE "b20_launches" ADD COLUMN IF NOT EXISTS "block_timestamp" timestamptz;
--> statement-breakpoint

-- A launch cannot predate the chain, and cannot be dated after Miorail saw it.
-- Both bounds are loose on purpose: this refuses a garbage word decoded out of
-- a malformed log, not a legitimately odd block.
ALTER TABLE "b20_launches" DROP CONSTRAINT IF EXISTS "b20_launches_block_timestamp_sane";
--> statement-breakpoint
ALTER TABLE "b20_launches" ADD CONSTRAINT "b20_launches_block_timestamp_sane" CHECK (
  "block_timestamp" IS NULL
  OR ("block_timestamp" > TIMESTAMPTZ '2023-06-01 00:00:00+00' AND "block_timestamp" <= "detected_at")
);
