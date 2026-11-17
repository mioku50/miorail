-- Still: Loops (2026-11-17).
--
-- A Loop is a Still loan against one company's stock that paid, in the same
-- batch, a Bitrefill card of that same company (lib/still-engine/src/loops.ts):
-- the stock stays pledged, the card arrives. One row per confirmed attempt,
-- written once, numbered in the order the loans were confirmed. The number is
-- public and kept forever: one statement takes the next one, and a race for
-- the same number writes nothing, so numbers have no gap and never repeat.
-- execution_id names the lending_executions attempt; it is not a foreign key,
-- so a Loop outlives any later clean-up of attempts.
--
-- - via: who prepared it. 'web' for Still's own pages; 'claude', 'chatgpt' or
--   'grok' when the draft's signed origin says so (lib/mcpClientKind.ts reads
--   it from where the connector's codes go, never from a name); 'assistant'
--   for any other connected client.
-- - team: a wallet of the Still team (STILL_TEAM_WALLETS when written). Team
--   Loops are shown as such and never counted.
-- - delivered_at / undelivered: Bitrefill's own word on the card. A Loop is
--   complete, and may go on the wall, only once the invoice read 'complete';
--   'blocked', 'denied' or 'payment_error' means the card did not arrive.
-- - on_wall / wall_label / walled_at: the owner's own choice to show it on the
--   public wall, under their checked Basename or as "Loop #N". Nothing is
--   public until they press it.
--
-- Stored: the wallet (never served), the product and package as the receipt
-- named them, the price rounded to a whole dollar (shareAmountAtomicV1), the
-- venue and the times. No hash, no order id, no email.
-- Applied as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS still_loops (
  execution_id          uuid         PRIMARY KEY,
  loop_no               integer      NOT NULL,
  wallet_address        text         NOT NULL,
  brand                 text         NOT NULL,
  collateral            text         NOT NULL,
  product_id            text         NOT NULL,
  product_name          text         NOT NULL,
  package_label         text         NOT NULL,
  price_rounded_atomic  numeric(20, 0) NOT NULL,
  venue                 text         NOT NULL,
  via                   text         NOT NULL,
  team                  boolean      NOT NULL DEFAULT false,
  confirmed_at          timestamptz  NOT NULL,
  delivered_at          timestamptz,
  undelivered           text,
  on_wall               boolean      NOT NULL DEFAULT false,
  wall_label            text,
  walled_at             timestamptz,
  CONSTRAINT still_loops_no UNIQUE (loop_no),
  CONSTRAINT still_loops_number CHECK (loop_no >= 1),
  CONSTRAINT still_loops_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT still_loops_brand CHECK (
    (brand, collateral) IN (('apple', 'AAPLc'), ('amazon', 'AMZNc'), ('google', 'GOOGLc'), ('meta', 'METAc'), ('microsoft', 'MSFTc'))),
  CONSTRAINT still_loops_product CHECK (product_id ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'
    AND length(btrim(product_name)) BETWEEN 1 AND 120 AND length(btrim(package_label)) BETWEEN 1 AND 84),
  CONSTRAINT still_loops_price CHECK (price_rounded_atomic >= 1000000 AND price_rounded_atomic % 1000000 = 0),
  CONSTRAINT still_loops_venue CHECK (venue IN ('aave-v4', 'morpho')),
  CONSTRAINT still_loops_via CHECK (via IN ('web', 'claude', 'chatgpt', 'grok', 'assistant')),
  CONSTRAINT still_loops_delivery CHECK (
    (delivered_at IS NULL OR undelivered IS NULL)
    AND (undelivered IS NULL OR undelivered IN ('blocked', 'denied', 'payment_error'))),
  CONSTRAINT still_loops_wall CHECK (
    (on_wall = (walled_at IS NOT NULL))
    AND (NOT on_wall OR (delivered_at IS NOT NULL AND NOT team))
    AND (wall_label IS NULL OR (on_wall AND wall_label ~ '^[a-z0-9-]{1,63}\.base\.eth$')))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_loops_wall_idx ON still_loops (walled_at DESC) WHERE on_wall;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_loops_confirmed_idx ON still_loops (confirmed_at);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loops OWNER TO miorail_user';
  END IF;
END
$$;
