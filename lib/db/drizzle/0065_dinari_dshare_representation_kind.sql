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
