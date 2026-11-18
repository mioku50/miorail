-- Coinbase only (2026-11-18): Backed's and Dinari's tokens are no part of
-- Miorail any more, so every row about them goes and the constraints stop
-- admitting them.
--
-- An address leaves when Backed or Dinari named it and no Coinbase source
-- does. The companies Backed's source happened to declare first that Coinbase
-- contracts also stand for (seven on production: GOOGL, COIN, GME, MSFT, MSTR,
-- NVDA, TSLA) stay, attributed to the Coinbase source that binds them, with
-- that binding's own evidence. Dinari's membership tables are dropped whole:
-- nothing else ever wrote to them.
-- Applied as the app user, like every migration here. Re-runnable.

DO $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS coinbase_only_gone (token_address text PRIMARY KEY);
  TRUNCATE coinbase_only_gone;

  INSERT INTO coinbase_only_gone (token_address)
  SELECT DISTINCT theirs.token_address
    FROM (
      SELECT lower(token_address) AS token_address FROM representation_underlying
       WHERE issuer_id IN ('backed', 'dinari')
      UNION SELECT lower(token_address) FROM official_assets
       WHERE source_kind = 'backed_assets_api'
      UNION SELECT lower(token_address) FROM underlying_identity_observation
       WHERE issuer_id IN ('backed', 'dinari') OR source_kind IN ('backed_assets_api', 'dinari_stock_api')
      UNION SELECT lower(token_address) FROM representation_ratio
       WHERE ratio_kind <> 'b20_multiplier'
    ) AS theirs
   WHERE theirs.token_address IS NOT NULL;

  IF to_regclass('public.issuer_representation') IS NOT NULL THEN
    INSERT INTO coinbase_only_gone (token_address)
    SELECT DISTINCT lower(token_address) FROM issuer_representation WHERE token_address IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  -- Never an address a Coinbase source names, whoever else named it too.
  DELETE FROM coinbase_only_gone g
   WHERE EXISTS (SELECT 1 FROM representation_underlying b
                  WHERE b.issuer_id = 'coinbase' AND lower(b.token_address) = g.token_address)
      OR EXISTS (SELECT 1 FROM official_assets o
                  WHERE o.source_kind <> 'backed_assets_api' AND lower(o.token_address) = g.token_address);

  -- What was measured about those addresses. Every stored address is lowercase
  -- (each repository writes it so), so the indexes on token_address serve.
  DELETE FROM official_cash_exit_runs WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM representation_supply_observation WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM representation_supply_change WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM representation_supply WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM pool_yield_readings WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  -- Six million rows: by the (chain_id, token_address) index, not a scan.
  DELETE FROM market_venue_transfers WHERE chain_id = 8453 AND token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM market_venue_activity_totals WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM market_pool_readings WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM b20_corporate_actions WHERE token_address IN (SELECT token_address FROM coinbase_only_gone);
  -- A signal about one of them, or about a contract that resembled one.
  DELETE FROM stock_inbox_reads WHERE signal_id IN (
    SELECT id FROM rwa_signals
     WHERE subject_address IN (SELECT token_address FROM coinbase_only_gone)
        OR official_address IN (SELECT token_address FROM coinbase_only_gone));
  DELETE FROM rwa_signals
   WHERE subject_address IN (SELECT token_address FROM coinbase_only_gone)
      OR official_address IN (SELECT token_address FROM coinbase_only_gone);
  -- A resemblance to one of them is a resemblance to nothing Miorail lists.
  DELETE FROM official_asset_lookalikes
   WHERE official_address IN (SELECT token_address FROM coinbase_only_gone)
      OR token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM representation_ratio_change
   WHERE ratio_kind <> 'b20_multiplier' OR token_address IN (SELECT token_address FROM coinbase_only_gone);
  DELETE FROM representation_ratio
   WHERE ratio_kind <> 'b20_multiplier' OR token_address IN (SELECT token_address FROM coinbase_only_gone);

  -- Who they were.
  DELETE FROM market_reality_radar_watches WHERE issuer_id IN ('backed', 'dinari');
  DELETE FROM underlying_identity_observation
   WHERE issuer_id IN ('backed', 'dinari') OR source_kind IN ('backed_assets_api', 'dinari_stock_api');
  DELETE FROM representation_underlying
   WHERE issuer_id IN ('backed', 'dinari') OR source_kind IN ('backed_assets_api', 'dinari_stock_api');

  -- A company a Coinbase contract still stands for keeps its row, declared by
  -- the Coinbase source that binds it.
  UPDATE underlying_asset u
     SET source_kind = b.source_kind, source_ref = b.source_ref, source_hash = b.source_hash, observed_at = b.observed_at
    FROM (
      SELECT DISTINCT ON (underlying_key) underlying_key, source_kind, source_ref, source_hash, observed_at
        FROM representation_underlying
       WHERE issuer_id = 'coinbase' OR source_kind IN ('coinbase_b20_metadata', 'coinbase_stocks_api')
       ORDER BY underlying_key, observed_at DESC
    ) b
   WHERE u.underlying_key = b.underlying_key
     AND u.source_kind IN ('backed_assets_api', 'dinari_stock_api');
  DELETE FROM underlying_identity_observation o
   WHERE o.underlying_key IN (
     SELECT u.underlying_key FROM underlying_asset u
      WHERE (u.source_kind IN ('backed_assets_api', 'dinari_stock_api') OR u.identifier_scheme IN ('dinari_stock_id', 'composite_figi'))
        AND NOT EXISTS (SELECT 1 FROM representation_underlying b WHERE b.underlying_key = u.underlying_key));
  DELETE FROM underlying_asset u
   WHERE (u.source_kind IN ('backed_assets_api', 'dinari_stock_api') OR u.identifier_scheme IN ('dinari_stock_id', 'composite_figi'))
     AND NOT EXISTS (SELECT 1 FROM representation_underlying b WHERE b.underlying_key = u.underlying_key);

  -- Backed's API as an official source.
  DELETE FROM official_assets WHERE source_kind = 'backed_assets_api';
  DELETE FROM official_asset_sources WHERE source_kind = 'backed_assets_api';

  DROP TABLE coinbase_only_gone;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS issuer_membership_check;
--> statement-breakpoint
DROP TABLE IF EXISTS issuer_representation;
--> statement-breakpoint
ALTER TABLE official_assets DROP CONSTRAINT IF EXISTS official_assets_kind;
--> statement-breakpoint
ALTER TABLE official_assets ADD CONSTRAINT official_assets_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'coinbase_stocks_api'));
--> statement-breakpoint
ALTER TABLE official_asset_sources DROP CONSTRAINT IF EXISTS official_asset_sources_kind;
--> statement-breakpoint
ALTER TABLE official_asset_sources ADD CONSTRAINT official_asset_sources_kind
  CHECK (source_kind IN ('base_docs_technical', 'base_product_list', 'coinbase_stocks_api'));
--> statement-breakpoint
ALTER TABLE underlying_asset DROP CONSTRAINT IF EXISTS underlying_asset_source;
--> statement-breakpoint
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_source
  CHECK (source_kind IN ('coinbase_b20_metadata', 'coinbase_stocks_api'));
--> statement-breakpoint
ALTER TABLE underlying_asset DROP CONSTRAINT IF EXISTS underlying_asset_identifier_scheme;
--> statement-breakpoint
ALTER TABLE underlying_asset ADD CONSTRAINT underlying_asset_identifier_scheme
  CHECK (identifier_scheme IS NULL OR identifier_scheme IN ('isin'));
--> statement-breakpoint
ALTER TABLE representation_underlying DROP CONSTRAINT IF EXISTS representation_underlying_source;
--> statement-breakpoint
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_source
  CHECK (source_kind IN ('coinbase_b20_metadata', 'coinbase_stocks_api'));
--> statement-breakpoint
ALTER TABLE representation_underlying DROP CONSTRAINT IF EXISTS representation_underlying_issuer;
--> statement-breakpoint
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_issuer
  CHECK (issuer_id IS NULL OR issuer_id IN ('coinbase'));
--> statement-breakpoint
ALTER TABLE representation_underlying DROP CONSTRAINT IF EXISTS representation_underlying_kind;
--> statement-breakpoint
ALTER TABLE representation_underlying ADD CONSTRAINT representation_underlying_kind
  CHECK (representation_kind IS NULL OR representation_kind IN ('b20_asset'));
--> statement-breakpoint
ALTER TABLE underlying_identity_observation DROP CONSTRAINT IF EXISTS underlying_identity_observation_source;
--> statement-breakpoint
ALTER TABLE underlying_identity_observation ADD CONSTRAINT underlying_identity_observation_source
  CHECK (source_kind IN ('coinbase_b20_metadata', 'coinbase_stocks_api'));
--> statement-breakpoint
ALTER TABLE underlying_identity_observation DROP CONSTRAINT IF EXISTS underlying_identity_observation_issuer;
--> statement-breakpoint
ALTER TABLE underlying_identity_observation ADD CONSTRAINT underlying_identity_observation_issuer
  CHECK (issuer_id IN ('coinbase'));
--> statement-breakpoint
ALTER TABLE underlying_identity_observation DROP CONSTRAINT IF EXISTS underlying_identity_observation_kind;
--> statement-breakpoint
ALTER TABLE underlying_identity_observation ADD CONSTRAINT underlying_identity_observation_kind
  CHECK (representation_kind IN ('b20_asset'));
--> statement-breakpoint
ALTER TABLE representation_ratio DROP CONSTRAINT IF EXISTS representation_ratio_kind;
--> statement-breakpoint
ALTER TABLE representation_ratio ADD CONSTRAINT representation_ratio_kind
  CHECK (ratio_kind IN ('b20_multiplier'));
--> statement-breakpoint
ALTER TABLE representation_ratio_change DROP CONSTRAINT IF EXISTS representation_ratio_change_kind;
--> statement-breakpoint
ALTER TABLE representation_ratio_change ADD CONSTRAINT representation_ratio_change_kind
  CHECK (ratio_kind IN ('b20_multiplier'));
--> statement-breakpoint
ALTER TABLE market_reality_radar_watches DROP CONSTRAINT IF EXISTS market_reality_radar_watch_issuer;
--> statement-breakpoint
ALTER TABLE market_reality_radar_watches ADD CONSTRAINT market_reality_radar_watch_issuer
  CHECK (issuer_id IN ('coinbase'));
--> statement-breakpoint
ALTER TABLE market_reality_radar_watches DROP CONSTRAINT IF EXISTS market_reality_radar_watch_kind;
--> statement-breakpoint
ALTER TABLE market_reality_radar_watches ADD CONSTRAINT market_reality_radar_watch_kind
  CHECK (representation_kind IN ('b20_asset'));
