-- Still: a Loop draw's entries, and the time-stamps of its list (2026-11-18).
--
-- still_loop_entries (was still_loop_free_entries): every entry is made by
-- its owner, with the same confirmations, one per wallet per draw. `kind`
-- 'loop' entered with that wallet's Loop of the draw and is named by its
-- number; 'free' needed no loan and no purchase and is named by its code.
-- Every entry keeps a code unique in its draw.
--
-- still_loop_draws.stamps: the RFC 3161 time-stamps public authorities gave
-- the list's hash once it was fixed, before the block that picks: one
-- {tsa, genTime, token} per authority, at most four, each written once.
-- Applied as the app user, like every migration here. Re-runnable.

DO $$
BEGIN
  IF to_regclass('public.still_loop_free_entries') IS NOT NULL AND to_regclass('public.still_loop_entries') IS NULL THEN
    ALTER TABLE still_loop_free_entries RENAME TO still_loop_entries;
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE still_loop_entries ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE still_loop_entries ADD COLUMN IF NOT EXISTS loop_no integer;
--> statement-breakpoint
ALTER TABLE still_loop_draws ADD COLUMN IF NOT EXISTS stamps jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'still_loop_entries_kind') THEN
    ALTER TABLE still_loop_entries ADD CONSTRAINT still_loop_entries_kind
      CHECK ((kind = 'free' AND loop_no IS NULL) OR (kind = 'loop' AND loop_no >= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'still_loop_draws_stamps') THEN
    ALTER TABLE still_loop_draws ADD CONSTRAINT still_loop_draws_stamps
      CHECK (jsonb_typeof(stamps) = 'array' AND jsonb_array_length(stamps) <= 4);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loop_entries OWNER TO miorail_user';
  END IF;
END
$$;
