-- T68B: the watchlist a background sweep reads. Additive only.
--
-- One table, and the reason it has to exist at all: until now the set of
-- watched tokens lived in the browser's localStorage, so a sweep running on a
-- timer had no way to learn WHICH tokens to read. "Watch" that only runs while
-- a page is open is not watching, it is checking.
--
-- WHAT THE SCHEMA ENFORCES:
--
--   * One row per account per token. A double-click, two tabs or two devices
--     cannot turn one watched token into two recurring on-chain reads.
--
--   * `last_swept_at` is the SWEEP CLOCK, not a queue. There is no backlog
--     column and no attempt counter: a run that misses a token owes it nothing
--     later, it simply reads it next time, and the page states the age of what
--     it has. This is what keeps a failing endpoint from accumulating work that
--     must eventually be paid for all at once.
--
--   * `last_outcome` keeps `not_b20` separate from `unreadable`. Most addresses
--     are not B20, and folding that ordinary answer into failure would teach a
--     reader to ignore the failures that matter.
--
--   * There is no score, no verdict and no "watch reason" column. The table
--     answers which tokens to read and when they were last read. Anything a
--     user should act on lives in the snapshots, which are immutable.
--
-- The per-account cap is NOT here, because SQL cannot express "at most N rows
-- per user" in a CHECK. It lives in `b20WatchlistAddEffectV1`, which both the
-- Postgres repository and the in-memory one call.

CREATE TABLE "b20_watchlist" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Null until a sweep has actually reached this token. Null is not "never
	-- changed" — it is "never read", and the two must never render alike.
	"last_swept_at" timestamp with time zone,
	"last_outcome" text,
	CONSTRAINT "b20_watchlist_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_watchlist_address_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_watchlist_outcome_check" CHECK (
		"last_outcome" IS NULL OR "last_outcome" IN ('read', 'not_b20', 'unreadable')
	),
	-- An outcome without a reading, or a reading without an outcome, would be a
	-- half-written sweep result. Neither is a state this table may hold.
	CONSTRAINT "b20_watchlist_sweep_pair_check" CHECK (
		("last_swept_at" IS NULL AND "last_outcome" IS NULL)
		OR ("last_swept_at" IS NOT NULL AND "last_outcome" IS NOT NULL)
	)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "b20_watchlist_user_token_unique"
	ON "b20_watchlist" ("user_id", "token_address");--> statement-breakpoint

-- The background sweep's only query: never-read first, then longest-unread.
-- NULLS FIRST is the whole ordering — a token somebody just added has no
-- reading at all, and showing them nothing for it is the worst outcome here.
CREATE INDEX "b20_watchlist_due_idx"
	ON "b20_watchlist" ("last_swept_at" ASC NULLS FIRST, "created_at" ASC);
