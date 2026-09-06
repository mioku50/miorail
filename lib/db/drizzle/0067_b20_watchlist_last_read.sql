-- A failed sweep must stop erasing the last successful reading.
--
-- `b20_watchlist` has carried ONE clock since T68B: `last_swept_at`, written on
-- every sweep whatever it concluded. So a token read successfully three weeks
-- ago and unreachable this morning reports "Last tried, this morning" and the
-- three-week-old reading — the one still on screen, the one the change list is
-- diffed against — has no timestamp anywhere. The row then sits beside the
-- market watch's "last measured 6m ago", and a reader takes the two clocks for
-- one and concludes something is broken.
--
-- Two columns, two subjects:
--
--   last_swept_at  the last ATTEMPT, any outcome. Unchanged: it is what the
--                  due-order index sorts on, and a failed attempt still costs
--                  the endpoint a call and still defers the next one.
--
--   last_read_at   the last attempt that actually READ the controls. This is
--                  the age of the evidence on screen, and it is the only one a
--                  reader should ever be shown as "read N ago".
--
-- `not_b20` is deliberately NOT a read. It is a true answer about the address
-- and it establishes nothing about any control, so it must not refresh the
-- evidence clock.
ALTER TABLE "b20_watchlist"
	ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone;
--> statement-breakpoint

-- Backfill only what is actually known. A row whose last outcome was a read was
-- read at `last_swept_at`; a row whose last outcome was a failure was last read
-- at an instant this table never recorded, and inventing one would be worse
-- than the null. Null renders as "not read yet", which is what we can prove.
UPDATE "b20_watchlist"
	SET "last_read_at" = "last_swept_at"
	WHERE "last_outcome" = 'read' AND "last_swept_at" IS NOT NULL;
--> statement-breakpoint

-- A reading cannot predate the table's knowledge of it, and cannot exist
-- without an attempt having happened.
ALTER TABLE "b20_watchlist"
	DROP CONSTRAINT IF EXISTS "b20_watchlist_read_clock_check";
--> statement-breakpoint
ALTER TABLE "b20_watchlist"
	ADD CONSTRAINT "b20_watchlist_read_clock_check" CHECK (
		"last_read_at" IS NULL
		OR ("last_swept_at" IS NOT NULL AND "last_read_at" <= "last_swept_at")
	);
--> statement-breakpoint

-- The successful case is pinned: if the newest attempt read the controls, then
-- the evidence clock IS that attempt. Without this the two could drift apart
-- and the screen would age a reading older than the sweep that produced it.
ALTER TABLE "b20_watchlist"
	DROP CONSTRAINT IF EXISTS "b20_watchlist_read_matches_sweep_check";
--> statement-breakpoint
ALTER TABLE "b20_watchlist"
	ADD CONSTRAINT "b20_watchlist_read_matches_sweep_check" CHECK (
		"last_outcome" IS DISTINCT FROM 'read' OR "last_read_at" = "last_swept_at"
	);
