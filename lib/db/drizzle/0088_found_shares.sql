-- Found's share cards: a completed Aerodrome claim or Uniswap collect, made
-- into a link its owner can post on X or Farcaster.
--
-- One card per Action Receipt, made by the owner's click. A card holds what
-- its picture shows: the protocol, the dollar value of what arrived when the
-- card was made, up to four amounts as written on it, and the block the
-- transaction landed in. No wallet and no transaction hash: the person posting
-- chooses to say how much, not who.
--
-- Applied as the app user, like every migration here: a table created as
-- postgres is one the service cannot write. Re-runnable.

CREATE TABLE IF NOT EXISTS found_shares (
  code          text        PRIMARY KEY,
  receipt_id    text        NOT NULL REFERENCES base_mcp_action_receipts (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  tenant_id     text        NOT NULL,
  protocol      text        NOT NULL,
  usd_cents     integer     NOT NULL,
  tokens        jsonb       NOT NULL,
  block_number  text        NOT NULL,
  created_at    timestamptz NOT NULL,
  CONSTRAINT found_shares_receipt_unique UNIQUE (receipt_id),
  CONSTRAINT found_shares_code CHECK (code ~ '^[A-Za-z0-9_-]{12}$'),
  CONSTRAINT found_shares_protocol CHECK (protocol IN ('aerodrome', 'uniswap')),
  CONSTRAINT found_shares_usd_cents CHECK (usd_cents BETWEEN 0 AND 100000000),
  CONSTRAINT found_shares_tokens CHECK (jsonb_typeof(tokens) = 'array' AND jsonb_array_length(tokens) BETWEEN 1 AND 4),
  CONSTRAINT found_shares_block CHECK (block_number ~ '^[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE found_shares OWNER TO miorail_user;
