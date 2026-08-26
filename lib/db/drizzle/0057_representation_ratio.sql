-- The ratio between one token and one underlying share, per REPRESENTATION.
--
-- WHY THIS IS NOT A COINBASE TABLE
--
-- Base Docs open the tokenized-stocks page with a warning: "One B20 token does
-- not permanently equal one share. Always apply the current multiplier when
-- converting between token units and the number of underlying shares." Every
-- Coinbase representation reads exactly 1e18 today, and that is precisely why
-- this exists now rather than after the first dividend — a value that is 1.0
-- everywhere is indistinguishable from a value nobody reads, right up until
-- the day it moves.
--
-- But the ratio is not a B20 idea. Measured 2026-08-26, the three issuers with
-- representations on Base do three different things:
--
--   * Coinbase B20 stores balances RAW and publishes `multiplier()`. The
--     caller applies it: `scaledBalance = raw * multiplier / WAD_PRECISION`.
--   * Backed and Dinari REBASE. Their tokens publish a ratio too
--     (`balancePerShare()` on a dShare), but `balanceOf()` has already applied
--     it. Applying it again double-counts every corporate action.
--   * Centrifuge has no ratio at all; SPXA is a NAV-priced fund share.
--
-- So the discriminator is not the issuer, it is `application`: does the caller
-- apply this, or has the token already? That single column is what stops one
-- issuer's convention from being read through another issuer's adapter. A new
-- issuer lands as a new `ratio_kind`, not a new table and not a new column.
--
-- WHY THERE ARE TWO TABLES
--
-- The first observation of a representation is NOT a change. Deriving "the
-- multiplier moved" from state would have announced thirteen corporate actions
-- on the day this first ran, for thirteen assets that have never had one. So
-- state lives here and transitions live in `representation_ratio_change`,
-- which is only ever written when a writer SEES a value differ from the one it
-- stored. Same rule as `rwa_signals`; same reason.
--
-- WHAT A FAILED READ DOES
--
-- Nothing. There is no row for an unreadable ratio, and `last_checked_at` only
-- advances on a read that produced a value. An absent row means "not read",
-- which is not "1.0", and no surface may render it as one.

CREATE TABLE IF NOT EXISTS representation_ratio (
  chain_id          integer       NOT NULL,
  token_address     text          NOT NULL,
  -- Which issuer contract family this ratio was read from. The adapter's name,
  -- not the issuer's: two issuers could share a standard.
  ratio_kind        text          NOT NULL,
  -- The load-bearing column. See the header.
  application       text          NOT NULL,
  -- As the chain returned it, in `scale` units. Text because a uint256 does
  -- not fit a bigint and this is a quantity we compare exactly, never round.
  raw_value         text          NOT NULL,
  -- Read from the contract (`WAD_PRECISION()`), never assumed to be 1e18.
  scale             text          NOT NULL,
  block_number      text          NOT NULL,
  block_hash        text          NOT NULL,
  evidence_hash     text          NOT NULL,
  observed_at       timestamptz   NOT NULL,
  -- When a read last produced a value. A failed read does not move it.
  last_checked_at   timestamptz   NOT NULL,
  -- When the value last DIFFERED from what was stored. Null until it has.
  last_changed_at   timestamptz,
  reads             bigint        NOT NULL DEFAULT 1,
  changes           bigint        NOT NULL DEFAULT 0,
  created_at        timestamptz   NOT NULL,
  CONSTRAINT representation_ratio_pk PRIMARY KEY (chain_id, token_address, ratio_kind),
  CONSTRAINT representation_ratio_chain CHECK (chain_id = 8453),
  CONSTRAINT representation_ratio_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT representation_ratio_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT representation_ratio_kind CHECK (ratio_kind IN ('b20_multiplier')),
  CONSTRAINT representation_ratio_application CHECK (
    application IN ('apply_to_raw_balance', 'already_applied_by_token')
  ),
  CONSTRAINT representation_ratio_value_digits CHECK (raw_value ~ '^[1-9][0-9]*$'),
  CONSTRAINT representation_ratio_scale_digits CHECK (scale ~ '^[1-9][0-9]*$'),
  CONSTRAINT representation_ratio_block_digits CHECK (block_number ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT representation_ratio_block_hash_shape CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT representation_ratio_evidence_shape CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  -- A change count with no timestamp behind it is a count of nothing.
  CONSTRAINT representation_ratio_change_has_a_time CHECK (
    (changes = 0) = (last_changed_at IS NULL)
  ),
  CONSTRAINT representation_ratio_changes_within_reads CHECK (changes < reads OR changes = 0)
);

CREATE TABLE IF NOT EXISTS representation_ratio_change (
  id                bigserial     PRIMARY KEY,
  chain_id          integer       NOT NULL,
  token_address     text          NOT NULL,
  ratio_kind        text          NOT NULL,
  -- What was stored before this writer looked. Never null: the first
  -- observation is not a change and does not reach this table.
  from_raw_value    text          NOT NULL,
  to_raw_value      text          NOT NULL,
  scale             text          NOT NULL,
  block_number      text          NOT NULL,
  block_hash        text          NOT NULL,
  evidence_hash     text          NOT NULL,
  observed_at       timestamptz   NOT NULL,
  recorded_at       timestamptz   NOT NULL,
  CONSTRAINT representation_ratio_change_chain CHECK (chain_id = 8453),
  CONSTRAINT representation_ratio_change_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT representation_ratio_change_kind CHECK (ratio_kind IN ('b20_multiplier')),
  CONSTRAINT representation_ratio_change_moved CHECK (from_raw_value <> to_raw_value),
  CONSTRAINT representation_ratio_change_values CHECK (
    from_raw_value ~ '^[1-9][0-9]*$' AND to_raw_value ~ '^[1-9][0-9]*$' AND scale ~ '^[1-9][0-9]*$'
  ),
  CONSTRAINT representation_ratio_change_recorded_after CHECK (recorded_at >= observed_at),
  -- Re-reading the same block must not produce a second transition.
  CONSTRAINT representation_ratio_change_once_per_block
    UNIQUE (chain_id, token_address, ratio_kind, block_number)
);

CREATE INDEX IF NOT EXISTS representation_ratio_change_recent_idx
  ON representation_ratio_change (chain_id, recorded_at DESC);
