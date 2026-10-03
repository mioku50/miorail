-- Coinbase's public issuer API is independent of Base's docs/product tables.
-- It also publishes exact-address ISIN mappings; no price/supply is copied
-- into our separately pinned onchain evidence and no existing row is deleted.
ALTER TABLE official_asset_sources DROP CONSTRAINT IF EXISTS official_asset_sources_kind;
ALTER TABLE official_asset_sources ADD CONSTRAINT official_asset_sources_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'backed_assets_api', 'coinbase_stocks_api'));

ALTER TABLE official_assets DROP CONSTRAINT IF EXISTS official_assets_kind;
ALTER TABLE official_assets ADD CONSTRAINT official_assets_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'backed_assets_api', 'coinbase_stocks_api'));

ALTER TABLE underlying_asset DROP CONSTRAINT IF EXISTS underlying_asset_source;
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_source
  CHECK (source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata', 'coinbase_stocks_api'));

ALTER TABLE representation_underlying DROP CONSTRAINT IF EXISTS representation_underlying_source;
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_source
  CHECK (source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata', 'coinbase_stocks_api'));

ALTER TABLE underlying_identity_observation DROP CONSTRAINT IF EXISTS underlying_identity_observation_source;
ALTER TABLE underlying_identity_observation ADD CONSTRAINT underlying_identity_observation_source
  CHECK (source_kind IN ('dinari_stock_api', 'backed_assets_api', 'coinbase_b20_metadata', 'coinbase_stocks_api'));
