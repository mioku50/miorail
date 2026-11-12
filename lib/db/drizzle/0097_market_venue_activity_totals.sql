-- All-time venue activity per token, kept apart from the rows it counts
-- (audit OPS-7, 2026-11-12).
--
-- market_venue_transfers had no retention: 10.4 million rows and 5.2 GB on
-- 2026-11-12, growing by about 250,000 rows a day. Nothing reads a row older
-- than about an hour (the dossier's window) except one count: the Discover
-- overview shows how many movements were ever observed for each stock, and it
-- got that number by reading the whole table on every request (6.7 s, 2.8 GB
-- of pages each time).
--
-- This table holds that count. A statement trigger on the transfers table adds
-- every stored row to it in the same transaction, whichever worker wrote the
-- row, so the count is exact and independent of the rows: old rows can then be
-- removed without changing any number a person sees.
--
-- Re-runnable. The existing rows are counted once, under a lock that holds
-- writers (not readers) off for those seconds, and only where the trigger is
-- not there yet: a second run finds the trigger and changes nothing.

CREATE TABLE IF NOT EXISTS market_venue_activity_totals (
  chain_id      integer     NOT NULL,
  token_address text        NOT NULL,
  transfers     bigint      NOT NULL,
  acquired      bigint      NOT NULL,
  disposed      bigint      NOT NULL,
  first_block   bigint      NOT NULL,
  last_block    bigint      NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, token_address),
  CONSTRAINT market_venue_activity_totals_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  -- A total with no movement behind it would read as a measured zero.
  CONSTRAINT market_venue_activity_totals_counts
    CHECK (transfers > 0 AND acquired >= 0 AND disposed >= 0 AND transfers = acquired + disposed),
  CONSTRAINT market_venue_activity_totals_blocks CHECK (first_block > 0 AND first_block <= last_block)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION market_venue_activity_totals_add() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO market_venue_activity_totals AS total (
    chain_id, token_address, transfers, acquired, disposed, first_block, last_block, updated_at
  )
  SELECT chain_id, token_address,
         count(*),
         count(*) FILTER (WHERE direction = 'out_of_venue'),
         count(*) FILTER (WHERE direction = 'into_venue'),
         min(block_number), max(block_number), now()
    FROM added
   GROUP BY chain_id, token_address
  ON CONFLICT (chain_id, token_address) DO UPDATE SET
    transfers   = total.transfers + EXCLUDED.transfers,
    acquired    = total.acquired + EXCLUDED.acquired,
    disposed    = total.disposed + EXCLUDED.disposed,
    first_block = LEAST(total.first_block, EXCLUDED.first_block),
    last_block  = GREATEST(total.last_block, EXCLUDED.last_block),
    updated_at  = EXCLUDED.updated_at;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'market_venue_transfers_totals'
       AND tgrelid = 'market_venue_transfers'::regclass
  ) THEN
    -- Writers wait, readers do not. Without it a row committed between the
    -- count and the trigger would be in neither.
    LOCK TABLE market_venue_transfers IN SHARE ROW EXCLUSIVE MODE;
    IF NOT EXISTS (SELECT 1 FROM market_venue_activity_totals) THEN
      INSERT INTO market_venue_activity_totals (
        chain_id, token_address, transfers, acquired, disposed, first_block, last_block, updated_at
      )
      SELECT chain_id, token_address,
             count(*),
             count(*) FILTER (WHERE direction = 'out_of_venue'),
             count(*) FILTER (WHERE direction = 'into_venue'),
             min(block_number), max(block_number), now()
        FROM market_venue_transfers
       GROUP BY chain_id, token_address;
    END IF;
    CREATE TRIGGER market_venue_transfers_totals
      AFTER INSERT ON market_venue_transfers
      REFERENCING NEW TABLE AS added
      FOR EACH STATEMENT EXECUTE FUNCTION market_venue_activity_totals_add();
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE market_venue_activity_totals OWNER TO miorail_user';
    EXECUTE 'ALTER FUNCTION market_venue_activity_totals_add() OWNER TO miorail_user';
  END IF;
END
$$;
