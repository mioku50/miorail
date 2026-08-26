-- Phase 9B.2/9C: stable underlying identity and a second reviewed issuer.
--
-- Backed's public bTokens API binds an issuer UUID and certificate ISIN to an
-- exact Base address and separately carries the underlying ISIN. That is a
-- machine-readable address-first trust root; display symbols never enter a
-- key. Coinbase joins remain absent unless exact-address B20 metadata exposes
-- an identifier that a reviewed issuer prospectus also names.

ALTER TABLE official_asset_sources DROP CONSTRAINT IF EXISTS official_asset_sources_kind;
ALTER TABLE official_asset_sources ADD CONSTRAINT official_asset_sources_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'backed_assets_api'));

ALTER TABLE official_assets DROP CONSTRAINT IF EXISTS official_assets_kind;
ALTER TABLE official_assets ADD CONSTRAINT official_assets_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'backed_assets_api'));

ALTER TABLE underlying_asset
  ADD COLUMN IF NOT EXISTS display_symbol text,
  ADD COLUMN IF NOT EXISTS identifier_scheme text,
  ADD COLUMN IF NOT EXISTS identifier_value text,
  ADD COLUMN IF NOT EXISTS source_hash text;

ALTER TABLE underlying_asset DROP CONSTRAINT IF EXISTS underlying_asset_source;
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_source CHECK (
  source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata'));
ALTER TABLE underlying_asset DROP CONSTRAINT IF EXISTS underlying_asset_class;
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_class CHECK (
  asset_class IN ('equity', 'fund_share', 'other', 'unknown'));
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_identifier_pair CHECK (
  (identifier_scheme IS NULL) = (identifier_value IS NULL));
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_identifier_scheme CHECK (
  identifier_scheme IS NULL OR identifier_scheme IN ('isin', 'dinari_stock_id', 'composite_figi'));
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_source_hash CHECK (
  source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE representation_underlying
  ADD COLUMN IF NOT EXISTS source_hash text,
  ADD COLUMN IF NOT EXISTS issuer_id text,
  ADD COLUMN IF NOT EXISTS issuer_instrument_key text,
  ADD COLUMN IF NOT EXISTS caip10 text,
  ADD COLUMN IF NOT EXISTS representation_kind text,
  ADD COLUMN IF NOT EXISTS evidence_strength text,
  ADD COLUMN IF NOT EXISTS observed_block_number text,
  ADD COLUMN IF NOT EXISTS observed_block_hash text;

ALTER TABLE representation_underlying DROP CONSTRAINT IF EXISTS representation_underlying_source;
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_source CHECK (
  source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata'));
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_source_hash CHECK (
  source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_base_chain CHECK (
  chain_id = 8453);
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_issuer CHECK (
  issuer_id IS NULL OR issuer_id IN ('coinbase', 'dinari', 'backed'));
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_kind CHECK (
  representation_kind IS NULL OR representation_kind IN (
    'b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper'));
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_evidence CHECK (
  evidence_strength IS NULL OR evidence_strength IN (
    'reviewed_issuer_identifier',
    'reviewed_machine_address_mapping',
    'reviewed_machine_mapping_with_onchain_cross_check'));
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_caip10 CHECK (
  caip10 IS NULL OR caip10 = 'eip155:8453:' || token_address);
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_block_pair CHECK (
  (observed_block_number IS NULL) = (observed_block_hash IS NULL));
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_block_hash CHECK (
  observed_block_hash IS NULL OR observed_block_hash ~ '^0x[0-9a-f]{64}$');

-- Every successful identity edge is also append-only evidence. The current
-- table remains the fast projection; this table prevents a later refresh from
-- erasing which source hash previously established the join.
CREATE TABLE IF NOT EXISTS underlying_identity_observation (
  chain_id               integer       NOT NULL,
  token_address          text          NOT NULL,
  underlying_key         text          NOT NULL REFERENCES underlying_asset (underlying_key),
  source_kind            text          NOT NULL,
  source_ref             text          NOT NULL,
  source_hash            text          NOT NULL,
  issuer_id              text          NOT NULL,
  issuer_instrument_key  text          NOT NULL,
  caip10                  text          NOT NULL,
  representation_kind    text          NOT NULL,
  evidence_strength      text          NOT NULL,
  observed_block_number  text,
  observed_block_hash    text,
  observed_at            timestamptz   NOT NULL,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT underlying_identity_observation_pk PRIMARY KEY (
    chain_id, token_address, underlying_key, source_hash),
  CONSTRAINT underlying_identity_observation_address CHECK (
    token_address = lower(token_address) AND token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT underlying_identity_observation_base_chain CHECK (chain_id = 8453),
  CONSTRAINT underlying_identity_observation_hash CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT underlying_identity_observation_source CHECK (
    source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata')),
  CONSTRAINT underlying_identity_observation_caip10 CHECK (
    caip10 = 'eip155:8453:' || token_address),
  CONSTRAINT underlying_identity_observation_issuer CHECK (
    issuer_id IN ('coinbase', 'dinari', 'backed')),
  CONSTRAINT underlying_identity_observation_kind CHECK (
    representation_kind IN ('b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper')),
  CONSTRAINT underlying_identity_observation_evidence CHECK (
    evidence_strength IN (
      'reviewed_issuer_identifier',
      'reviewed_machine_address_mapping',
      'reviewed_machine_mapping_with_onchain_cross_check')),
  CONSTRAINT underlying_identity_observation_block_pair CHECK (
    (observed_block_number IS NULL) = (observed_block_hash IS NULL)),
  CONSTRAINT underlying_identity_observation_block_number CHECK (
    observed_block_number IS NULL OR observed_block_number ~ '^(0|[1-9][0-9]*)$'),
  CONSTRAINT underlying_identity_observation_block_hash CHECK (
    observed_block_hash IS NULL OR observed_block_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS underlying_identity_by_underlying_idx
  ON underlying_identity_observation (chain_id, underlying_key, observed_at DESC);

ALTER TABLE representation_ratio DROP CONSTRAINT IF EXISTS representation_ratio_kind;
ALTER TABLE representation_ratio ADD CONSTRAINT representation_ratio_kind CHECK (
  ratio_kind IN ('b20_multiplier', 'dinari_balance_per_share', 'backed_evm_multiplier'));

ALTER TABLE representation_ratio_change DROP CONSTRAINT IF EXISTS representation_ratio_change_kind;
ALTER TABLE representation_ratio_change ADD CONSTRAINT representation_ratio_change_kind CHECK (
  ratio_kind IN ('b20_multiplier', 'dinari_balance_per_share', 'backed_evm_multiplier'));
