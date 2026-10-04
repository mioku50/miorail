-- Call the reopen: a player's settled round, shared.
--
-- A post on X or Farcaster previews as the picture its link names. The link
-- names a code, never a score: a picture drawn from numbers in the address
-- would draw whatever anybody typed. The code is random, made the first time
-- the player reads a settled round they picked in, and the picks are copied
-- into the row at that moment, so the picture never changes and a code made
-- by a device still draws after the device signs in and its picks move.
--
-- No name is kept here and none is drawn: the picture says how a call went,
-- not who made it.
--
-- Applied by the deploy, as the app user, inside the migrator's own
-- transaction. Re-runnable.
CREATE TABLE IF NOT EXISTS reopen_shares (
  code text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9_-]{12}$'),
  round_id text NOT NULL REFERENCES reopen_rounds(round_id),
  player_id text NOT NULL REFERENCES reopen_players(player_id),
  picks jsonb NOT NULL CHECK (jsonb_typeof(picks) = 'object' AND picks <> '{}'::jsonb),
  created_at timestamptz NOT NULL,
  UNIQUE (round_id, player_id)
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    ALTER TABLE reopen_shares OWNER TO miorail_user;
  END IF;
END $$;
