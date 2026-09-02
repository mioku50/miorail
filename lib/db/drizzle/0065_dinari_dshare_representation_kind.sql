-- A Dinari dShare is a fourth kind of representation.
--
-- The three kinds this constraint knew were the three that existed: a B20
-- asset, a rebasing ERC-20, and Backed's non-rebasing ERC-4626 wrapper. A
-- dShare is none of them — it does not rebase, it is not a wrapper, and it is
-- not a B20 — and approximating it by the nearest existing value would be a lie
-- told in an enum, on a hundred contracts at once.
--
-- The TypeScript union was extended first and the write failed here, which is
-- the constraint doing its job: the database refuses what the types allow until
-- somebody decides the kind exists. This is that decision.
ALTER TABLE representation_underlying
  DROP CONSTRAINT IF EXISTS representation_underlying_kind;

ALTER TABLE representation_underlying
  ADD CONSTRAINT representation_underlying_kind
  CHECK (
    representation_kind IS NULL
    OR representation_kind = ANY (
      ARRAY['b20_asset'::text, 'rebasing_erc20'::text, 'non_rebasing_erc4626_wrapper'::text, 'dinari_dshare'::text]
    )
  );

-- Three tables carry this list, not one.
--
-- `representation_underlying` is the binding, `underlying_identity_observation`
-- is the append-only record of how each binding was established, and
-- `market_reality_radar_watches` is a tenant's exact market question. A kind
-- accepted by one and refused by the next is a write that half-lands, which is
-- how the first run of this migration got a binding written and its own
-- provenance row rejected.

ALTER TABLE underlying_identity_observation
  DROP CONSTRAINT IF EXISTS underlying_identity_observation_kind;

ALTER TABLE underlying_identity_observation
  ADD CONSTRAINT underlying_identity_observation_kind
  CHECK (
    representation_kind = ANY (
      ARRAY['b20_asset'::text, 'rebasing_erc20'::text, 'non_rebasing_erc4626_wrapper'::text, 'dinari_dshare'::text]
    )
  );

ALTER TABLE market_reality_radar_watches
  DROP CONSTRAINT IF EXISTS market_reality_radar_watch_kind;

ALTER TABLE market_reality_radar_watches
  ADD CONSTRAINT market_reality_radar_watch_kind
  CHECK (
    representation_kind = ANY (
      ARRAY['b20_asset'::text, 'rebasing_erc20'::text, 'non_rebasing_erc4626_wrapper'::text, 'dinari_dshare'::text]
    )
  );
