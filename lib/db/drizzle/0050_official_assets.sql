-- The OFFICIAL trust root: which contract addresses a reviewed source says are
-- officially issued, and the snapshot of that source that says so.
--
-- WHY THIS CANNOT COME FROM THE FACTORY FEED
--
-- Every B20 token in the index announced itself. Name, symbol and variant are
-- all typed by whoever launched it, so the launch feed is the one place where
-- a lookalike is INDISTINGUISHABLE from the asset it imitates -- that is what
-- a lookalike is. Officialness is therefore not a property Miorail can read
-- off the chain; it is a claim made by a source outside the chain, and the
-- only honest way to hold it is to store the source's own words and the moment
-- they were read.
--
-- WHY TWO TABLES
--
-- The snapshot is evidence with a timestamp; the membership is what that
-- evidence currently asserts. Collapsing them would make "the source went
-- down" and "the source removed the asset" the same row, and those are
-- opposite facts: one is our failure, the other is an event about the asset.
-- A snapshot row is written on EVERY check, including a failed one, so an
-- outage is recorded as an outage instead of as a silent gap.
--
-- WHY MEMBERSHIP IS PER SOURCE
--
-- Base publishes the complete technical corpus (thirteen tokenized equities on
-- 2026-08-25); the product-facing list carried four of them on the same day.
-- Neither is wrong. Reconciling them into one row would delete exactly the
-- fact worth showing, so both memberships are stored and the disagreement is
-- a query, not a merge.
--
-- WHY NOTHING IS EVER DELETED
--
-- A source dropping an asset is an event about the asset. Removing the row
-- would erase it, so the row stays and last_seen_at stops advancing: currently
-- listed means last_seen_at equals the newest ok snapshot for that source.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No ticker uniqueness and no index that would make a ticker lookup cheap.
-- Base's own guidance is that a B20 is identified by address, metadata is
-- mutable onchain, and 61.7% of indexed launches already share a symbol with
-- another contract. A schema that made symbol convenient to join on would make
-- the wrong join the easy one.

CREATE TABLE IF NOT EXISTS official_asset_sources (
  id             bigserial PRIMARY KEY,
  source_kind    text        NOT NULL,
  source_url     text        NOT NULL,
  observed_at    timestamptz NOT NULL,
  status         text        NOT NULL,
  -- What the document said, byte for byte, and what it CLAIMED after parsing.
  -- Two hashes because they answer different questions: the document changes
  -- whenever the site is rebuilt, the corpus changes only when the reviewed
  -- membership actually moved.
  document_hash  text,
  corpus_hash    text,
  asset_count    integer     NOT NULL,
  -- Why a check failed, in our own words. Never a URL with credentials and
  -- never a raw provider response.
  detail         text,
  CONSTRAINT official_asset_sources_kind
    CHECK (source_kind IN ('base_docs_technical', 'base_product_list')),
  CONSTRAINT official_asset_sources_status
    CHECK (status IN ('ok', 'unreachable', 'unparsable')),
  CONSTRAINT official_asset_sources_url_https CHECK (source_url LIKE 'https://%'),
  CONSTRAINT official_asset_sources_document_hash_shape
    CHECK (document_hash IS NULL OR document_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT official_asset_sources_corpus_hash_shape
    CHECK (corpus_hash IS NULL OR corpus_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT official_asset_sources_count_nonnegative CHECK (asset_count >= 0),
  -- An ok snapshot that named nothing is the shape a silently changed page
  -- takes, and it is the row that would empty the official set. It is refused
  -- here so the ingestion has to call that outcome what it is: unparsable.
  CONSTRAINT official_asset_sources_ok_is_complete
    CHECK (status <> 'ok' OR (asset_count > 0 AND document_hash IS NOT NULL AND corpus_hash IS NOT NULL)),
  CONSTRAINT official_asset_sources_failed_claims_nothing
    CHECK (status = 'ok' OR asset_count = 0)
);

CREATE INDEX IF NOT EXISTS official_asset_sources_kind_observed_idx
  ON official_asset_sources (source_kind, observed_at DESC);

CREATE TABLE IF NOT EXISTS official_assets (
  id                     bigserial   PRIMARY KEY,
  chain_id               integer     NOT NULL,
  token_address          text        NOT NULL,
  source_kind            text        NOT NULL,
  -- Display metadata, carried because the source carries it. Never identity.
  ticker                 text        NOT NULL,
  display_name           text,
  -- The issuer as the source itself frames the corpus, not as we infer it.
  issuer                 text        NOT NULL,
  -- The Chainlink proxy the same reviewed document binds to this asset. Null
  -- when the document names no feed for it -- which is a different fact from
  -- a feed that exists and is stale.
  reference_feed_address text,
  first_seen_at          timestamptz NOT NULL,
  last_seen_at           timestamptz NOT NULL,
  source_id              bigint      NOT NULL
    REFERENCES official_asset_sources (id) ON DELETE RESTRICT,
  CONSTRAINT official_assets_membership UNIQUE (chain_id, source_kind, token_address),
  CONSTRAINT official_assets_kind
    CHECK (source_kind IN ('base_docs_technical', 'base_product_list')),
  CONSTRAINT official_assets_address_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT official_assets_address_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT official_assets_feed_lower
    CHECK (reference_feed_address IS NULL OR reference_feed_address = lower(reference_feed_address)),
  CONSTRAINT official_assets_feed_shape
    CHECK (reference_feed_address IS NULL OR reference_feed_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT official_assets_ticker_shape CHECK (ticker ~ '^[A-Za-z0-9.-]{1,16}$'),
  CONSTRAINT official_assets_seen_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS official_assets_address_idx
  ON official_assets (chain_id, token_address);
