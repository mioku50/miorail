-- Contracts dressed as an official asset.
--
-- WHAT A ROW MEANS, EXACTLY
--
-- This contract's declared name or symbol matches one an official asset also
-- answers to, and its ADDRESS does not match that asset's. Nothing more. It is
-- not a claim about who deployed it, what they intended, or whether anyone was
-- deceived -- none of which is on chain.
--
-- The table therefore has no severity, no score and no `is_scam`. There is
-- nothing to sort by that would rank one resemblance above another as a
-- judgement, which is the strongest form the rule can take: a later query
-- cannot ORDER BY a column that does not exist. `match_kind` is ordered by how
-- the strings matched, not by how bad it is.
--
-- WHY A NAME IS ALLOWED TO MATTER HERE AND NOWHERE ELSE
--
-- Everywhere else in Miorail a name is refused as identity, because that is
-- precisely what an impostor supplies. Here the conclusion runs the other way:
-- the name is used to say a contract is NOT the official one while looking
-- like it. Identity is still the address, and the two rules below keep it that
-- way.
--
-- WHY BOTH ADDRESSES ARE STORED
--
-- A comparison with one address in it is the shape that gets misread. The row
-- carries the resembling contract AND the official it resembles, so any
-- surface rendering it has both to show and none has to look the other up.
--
-- WHY THE LAUNCH'S OWN WORDS ARE COPIED IN
--
-- B20 name and symbol are mutable on chain. A row that pointed at the launch
-- index for them would silently change its own evidence the day the impostor
-- renames itself. `launch_symbol` and `launch_name` are what it declared when
-- it was flagged, and `matched_value` is the normalized string that actually
-- matched -- so a reader can see WHY it was flagged rather than trust that it
-- was.

CREATE TABLE IF NOT EXISTS official_asset_lookalikes (
  id                bigserial   PRIMARY KEY,
  chain_id          integer     NOT NULL,
  -- The resembling contract.
  token_address     text        NOT NULL,
  -- The official asset it resembles. One row per contract: a contract keeps
  -- only its strongest match, because "resembles four things" is a list nobody
  -- can act on.
  official_address  text        NOT NULL,
  match_kind        text        NOT NULL,
  matched_value     text        NOT NULL,
  launch_symbol     text        NOT NULL,
  launch_name       text        NOT NULL,
  -- When the contract was launched, from the index. Null when the index does
  -- not know -- which is different from a launch at the epoch.
  launched_at       timestamptz,
  first_flagged_at  timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  CONSTRAINT official_asset_lookalikes_token_unique UNIQUE (chain_id, token_address),
  CONSTRAINT official_asset_lookalikes_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT official_asset_lookalikes_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT official_asset_lookalikes_official_lower CHECK (official_address = lower(official_address)),
  CONSTRAINT official_asset_lookalikes_official_shape CHECK (official_address ~ '^0x[0-9a-f]{40}$'),
  -- The rule that makes the whole feature safe: the official contract can
  -- never be recorded as an impostor of itself. Enforced here as well as in
  -- the repository, because a backfill script does not go through one.
  CONSTRAINT official_asset_lookalikes_is_not_the_official
    CHECK (token_address <> official_address),
  CONSTRAINT official_asset_lookalikes_match_kind
    CHECK (match_kind IN ('symbol_exact', 'symbol_normalized', 'name_normalized')),
  CONSTRAINT official_asset_lookalikes_matched_value_present
    CHECK (length(matched_value) > 0),
  CONSTRAINT official_asset_lookalikes_seen_order CHECK (last_seen_at >= first_flagged_at)
);

CREATE INDEX IF NOT EXISTS official_asset_lookalikes_official_idx
  ON official_asset_lookalikes (chain_id, official_address, first_flagged_at DESC);

CREATE INDEX IF NOT EXISTS official_asset_lookalikes_flagged_idx
  ON official_asset_lookalikes (chain_id, first_flagged_at DESC);
