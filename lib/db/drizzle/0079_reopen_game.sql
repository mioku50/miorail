-- Call the reopen: one round per weekend, the players and their picks.
--
-- A round is written in three stages, each once: the stocks and their Friday
-- close when it opens, Base's calls after picks close, the results after the
-- feeds reopen. The checks below are the order those happen in, so a stage can
-- never be stored ahead of its moment or overwritten after it.
--
-- A player is a wallet (w:<address>) or a device that played without signing
-- in (d:<sha256 of a token only the device holds>). Signing in merges the
-- device into the wallet: its picks move over and it stops being a player.
-- Nothing about a person is stored beyond that: no IP, no name, no cookie.
--
-- Applied by the deploy, as the app user, inside the migrator's own
-- transaction. Re-runnable.
CREATE TABLE IF NOT EXISTS reopen_rounds (
  round_id text PRIMARY KEY CHECK (round_id ~ '^\d{4}-\d{2}-\d{2}$'),
  round_number integer NOT NULL UNIQUE CHECK (round_number > 0),
  close_at timestamptz NOT NULL,
  opens_at timestamptz NOT NULL,
  locks_at timestamptz NOT NULL,
  expected_reopen_at timestamptz NOT NULL,
  next_session_close_at timestamptz NOT NULL,
  stocks jsonb NOT NULL CHECK (jsonb_typeof(stocks) = 'array'),
  calls jsonb CHECK (calls IS NULL OR jsonb_typeof(calls) = 'array'),
  called_at timestamptz,
  results jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'array'),
  settled_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (close_at < opens_at AND opens_at < locks_at AND locks_at < expected_reopen_at
         AND expected_reopen_at < next_session_close_at),
  CHECK ((calls IS NULL) = (called_at IS NULL)),
  CHECK ((results IS NULL) = (settled_at IS NULL)),
  CHECK (results IS NULL OR calls IS NOT NULL),
  CHECK (called_at IS NULL OR called_at >= locks_at),
  CHECK (settled_at IS NULL OR settled_at >= expected_reopen_at)
);
CREATE TABLE IF NOT EXISTS reopen_players (
  player_id text PRIMARY KEY CHECK (player_id ~ '^(w:0x[0-9a-f]{40}|d:[0-9a-f]{64})$'),
  created_at timestamptz NOT NULL,
  merged_into text REFERENCES reopen_players(player_id),
  merged_at timestamptz,
  CHECK ((merged_into IS NULL) = (merged_at IS NULL)),
  CHECK (merged_into IS NULL OR (player_id LIKE 'd:%' AND merged_into LIKE 'w:%'))
);
CREATE TABLE IF NOT EXISTS reopen_picks (
  round_id text NOT NULL REFERENCES reopen_rounds(round_id),
  player_id text NOT NULL REFERENCES reopen_players(player_id),
  picks jsonb NOT NULL CHECK (jsonb_typeof(picks) = 'object'),
  picked_at timestamptz NOT NULL,
  PRIMARY KEY (round_id, player_id)
);
CREATE INDEX IF NOT EXISTS reopen_picks_player_idx ON reopen_picks (player_id);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    ALTER TABLE reopen_rounds OWNER TO miorail_user;
    ALTER TABLE reopen_players OWNER TO miorail_user;
    ALTER TABLE reopen_picks OWNER TO miorail_user;
  END IF;
END $$;
