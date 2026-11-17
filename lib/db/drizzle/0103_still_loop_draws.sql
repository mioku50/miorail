-- Still: the Loop draws (2026-11-17).
--
-- The draws themselves (when each is open, the prize) are fixed in code,
-- lib/still-engine/src/loopDraws.ts, with the arithmetic anybody can check.
-- Here is only what happened in them.
--
-- still_loop_free_entries: one free entry per wallet per draw, written only
-- while the draw is open and its list not yet fixed. `code` is the entry's
-- public name ("Entry K3F9X2"): it says nothing of the wallet.
--
-- still_loop_draws: one row per draw, written once when its list is fixed.
-- `entries` is that list in order, each entry's label with the wallet it
-- belongs to; only the labels are ever served, and `entries_hash` is
-- keccak256 of what is served. `winner_count` entries win `prize_atomic`
-- each. The block that picks, and the winners' numbers in the list in the
-- order picked, are written once afterwards; `payouts` holds one
-- {no, tx, at} per winner whose prize was sent, each written once. A draw
-- nobody entered has no block and no winner.
-- Applied as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS still_loop_free_entries (
  draw_id         text         NOT NULL,
  wallet_address  text         NOT NULL,
  code            text         NOT NULL,
  entered_at      timestamptz  NOT NULL,
  PRIMARY KEY (draw_id, wallet_address),
  CONSTRAINT still_loop_free_entries_code UNIQUE (draw_id, code),
  CONSTRAINT still_loop_free_entries_draw CHECK (draw_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT still_loop_free_entries_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT still_loop_free_entries_code_shape CHECK (code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS still_loop_draws (
  draw_id         text           PRIMARY KEY,
  opens_at        timestamptz    NOT NULL,
  closes_at       timestamptz    NOT NULL,
  prize_atomic    numeric(20, 0) NOT NULL,
  winner_count    integer        NOT NULL,
  entries         jsonb          NOT NULL,
  entry_count     integer        NOT NULL,
  entries_hash    text           NOT NULL,
  locked_at       timestamptz    NOT NULL,
  block_number    bigint,
  block_hash      text,
  block_time      timestamptz,
  winner_nos      jsonb,
  drawn_at        timestamptz,
  payouts         jsonb          NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT still_loop_draws_id CHECK (draw_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT still_loop_draws_times CHECK (opens_at < closes_at AND closes_at <= locked_at),
  CONSTRAINT still_loop_draws_prize CHECK (prize_atomic >= 1000000 AND winner_count BETWEEN 1 AND 20),
  CONSTRAINT still_loop_draws_list CHECK (
    jsonb_typeof(entries) = 'array' AND entry_count >= 0 AND jsonb_array_length(entries) = entry_count
    AND entries_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT still_loop_draws_block CHECK (
    (block_hash IS NULL) = (block_number IS NULL) AND (block_hash IS NULL) = (block_time IS NULL)
    AND (block_hash IS NULL OR (block_hash ~ '^0x[0-9a-f]{64}$' AND block_number >= 0 AND drawn_at IS NOT NULL))),
  CONSTRAINT still_loop_draws_winner CHECK (
    (winner_nos IS NULL OR (block_hash IS NOT NULL AND jsonb_typeof(winner_nos) = 'array'
      AND jsonb_array_length(winner_nos) = LEAST(winner_count, entry_count)))
    AND (drawn_at IS NULL OR entry_count = 0 OR winner_nos IS NOT NULL)
    AND (drawn_at IS NULL OR drawn_at >= locked_at)),
  CONSTRAINT still_loop_draws_paid CHECK (
    jsonb_typeof(payouts) = 'array'
    AND (jsonb_array_length(payouts) = 0 OR winner_nos IS NOT NULL)
    AND jsonb_array_length(payouts) <= winner_count)
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loop_free_entries OWNER TO miorail_user';
    EXECUTE 'ALTER TABLE still_loop_draws OWNER TO miorail_user';
  END IF;
END
$$;
