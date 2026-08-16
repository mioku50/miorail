-- How a launch row got here: read by the live lane, or filled in afterwards.
--
-- WHY THIS IS NEEDED
--
-- Measurement candidates are ordered `detected_at DESC` — newest FOUND first,
-- which is right, because Discover lists launches newest-first and oldest-first
-- made the top of the home screen the part the worker reached last.
--
-- A backfill writes `detected_at = now()`, and that is honest: Miorail did find
-- the row just now. But it means a historical launch is indistinguishable from
-- one that just happened, and the 2026-08-16 gap is ~740,000 blocks — roughly
-- 11,000-12,000 launches at the measured density of 16 per 1,000 blocks.
-- Filling it would put twelve thousand tokens from July at the head of the
-- measurement queue and starve every B20 launched today. A backlog that pushes
-- out live work is worse than the gap it repairs.
--
-- WHY NOT JUST WRITE THE LAUNCH TIMESTAMP INTO `detected_at`
--
-- Because `detected_at` means "when Miorail found this", and it would stop
-- being true. The block timestamp is already stored, in `block_timestamp`,
-- where it belongs. Two facts, two columns; scheduling is the thing that has to
-- learn the difference, not the record.
--
-- WHY A COLUMN AND NOT ITS OWN TABLE
--
-- Migration 0044 gave the launch SENDER its own table, and the reasoning there
-- was that it comes from a different read, taken later, against an endpoint
-- that can be down — so it has three states (read / absent / failed) that a
-- nullable column would collapse. Ingestion source has one state, known with
-- certainty by the writer at INSERT time and never revised. It sits beside
-- `detected_at` and `confirmation_count`, which are also facts about our read
-- rather than fields decoded from the log.
--
-- NOT IN THE IMMUTABILITY TRIGGER, on purpose. That trigger protects chain
-- evidence. This column is a statement about Miorail's own bookkeeping, in the
-- same category as `canonical` / `non_canonical_at`, which the trigger already
-- allows to change.

ALTER TABLE "b20_launches"
	ADD COLUMN IF NOT EXISTS "ingestion_source" text NOT NULL DEFAULT 'live';
--> statement-breakpoint

ALTER TABLE "b20_launches"
	DROP CONSTRAINT IF EXISTS "b20_launches_ingestion_source_check";
--> statement-breakpoint

ALTER TABLE "b20_launches"
	ADD CONSTRAINT "b20_launches_ingestion_source_check"
	CHECK ("ingestion_source" IN ('live', 'backfill'));
--> statement-breakpoint

-- The rows already backfilled on 2026-08-16, labelled from the one thing that
-- identifies them without ambiguity: they sit below the block the live lane
-- ever started at, so the live lane cannot have written them. Bounded by that
-- comparison rather than by a date, so re-running this migration on a database
-- where the backfill has already been labelled changes nothing.
--
-- 49401132 is B20_DISCOVER_START_BLOCK as configured in production on
-- 2026-08-16. It is written as a literal because it is being used as a
-- historical fact about what was already scanned, not as live configuration.
UPDATE "b20_launches"
	SET "ingestion_source" = 'backfill'
	WHERE "block_number" < 49401132
	  AND "ingestion_source" = 'live';
--> statement-breakpoint

-- Live candidates come first, and within each group the newest found. Without
-- the leading key a full backfill reorders the entire measurement queue.
CREATE INDEX IF NOT EXISTS "b20_launches_measure_priority_idx"
	ON "b20_launches" ("ingestion_source", "detected_at" DESC, "id" DESC);
