-- Still: a Loop card's Bitrefill invoice, kept to read its delivery (2026-11-21, audit LOOP-1).
--
-- Bitrefill reads an invoice back only with its access token, and Still held
-- that token with the open order: half an hour, in memory, gone on a restart.
-- A Loop whose card was delivered after that stayed "on its way" for good,
-- uncounted and off the wall, while the draw counted it.
--
-- For an invoice of a Loop brand's card, and only that, one row holds
-- {invoice id, access token} encrypted with a key the database does not hold
-- (read_enc). It is deleted once Bitrefill's word on the card is in, and
-- 14 days after it was opened at the latest. Nothing else of the order is
-- here: not the email, not a number.
-- Applied as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS still_loop_invoice_reads (
  order_id        uuid         PRIMARY KEY,
  wallet_address  text         NOT NULL,
  read_enc        text         NOT NULL,
  created_at      timestamptz  NOT NULL,
  read_at         timestamptz,
  CONSTRAINT still_loop_invoice_reads_wallet CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT still_loop_invoice_reads_enc CHECK (length(read_enc) BETWEEN 16 AND 4000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS still_loop_invoice_reads_created ON still_loop_invoice_reads (created_at);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE still_loop_invoice_reads OWNER TO miorail_user';
  END IF;
END
$$;
