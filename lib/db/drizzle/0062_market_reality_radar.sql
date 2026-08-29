-- Phase 12.2: tenant-scoped watches over one exact Market Reality question.
--
-- The immutable observations stay in official_cash_exit_runs. Radar stores a
-- subscription, one compact comparison cursor, and deduplicated transitions.
-- A provider failure has nowhere to become an event: only the evaluator may
-- write this table, and every event names two successful source snapshots.

-- A watch cannot pair an underlying with some other reviewed address. The
-- existing representation key is address-first, so expose the exact triple as
-- a reviewed candidate key for the composite foreign key below.
CREATE UNIQUE INDEX IF NOT EXISTS representation_underlying_exact_identity_unique
  ON representation_underlying (chain_id, token_address, underlying_key);

CREATE TABLE IF NOT EXISTS market_reality_radar_watches (
  watch_id                 text        PRIMARY KEY,
  user_id                  text        NOT NULL,
  watch_slot               smallint    NOT NULL,
  chain_id                 integer     NOT NULL,
  underlying_key           text        NOT NULL,
  token_address            text        NOT NULL,
  issuer_id                text        NOT NULL,
  representation_kind      text        NOT NULL,
  direction                text        NOT NULL,
  requested_cash_atomic    text        NOT NULL,
  destination              text        NOT NULL,
  route_policy_key         text        NOT NULL,
  approved_sources         jsonb       NOT NULL,
  created_at               timestamptz NOT NULL,
  -- The worker reached this watch, whatever the measurement produced.
  last_evaluated_at        timestamptz,
  -- The worker established a successful comparable point. Failures never
  -- advance this clock.
  last_comparable_at       timestamptz,
  last_evaluation_outcome  text,
  CONSTRAINT market_reality_radar_watch_chain CHECK (chain_id = 8453),
  CONSTRAINT market_reality_radar_watch_slot CHECK (watch_slot BETWEEN 1 AND 25),
  CONSTRAINT market_reality_radar_watch_id CHECK (watch_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT market_reality_radar_watch_address CHECK (
    token_address = lower(token_address) AND token_address ~ '^0x[0-9a-f]{40}$'
  ),
  CONSTRAINT market_reality_radar_watch_direction CHECK (direction IN ('buy', 'sell')),
  CONSTRAINT market_reality_radar_watch_cash CHECK (requested_cash_atomic ~ '^[1-9][0-9]*$'),
  CONSTRAINT market_reality_radar_watch_destination CHECK (destination IN ('USDC', 'ETH')),
  CONSTRAINT market_reality_radar_watch_policy CHECK (route_policy_key ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT market_reality_radar_watch_issuer CHECK (issuer_id IN ('coinbase', 'dinari', 'backed')),
  CONSTRAINT market_reality_radar_watch_kind CHECK (
    representation_kind IN ('b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper')
  ),
  CONSTRAINT market_reality_radar_watch_sources CHECK (
    jsonb_typeof(approved_sources) = 'array' AND jsonb_array_length(approved_sources) > 0
  ),
  CONSTRAINT market_reality_radar_watch_outcome CHECK (
    last_evaluation_outcome IS NULL OR last_evaluation_outcome IN (
      'baseline', 'compared', 'measurement_failed', 'unsized', 'policy_changed'
    )
  ),
  CONSTRAINT market_reality_radar_watch_evaluation_pair CHECK (
    (last_evaluated_at IS NULL) = (last_evaluation_outcome IS NULL)
  ),
  CONSTRAINT market_reality_radar_watch_comparable_is_evaluation CHECK (
    last_comparable_at IS NULL OR last_evaluated_at IS NOT NULL
  ),
  CONSTRAINT market_reality_radar_watch_underlying_fk FOREIGN KEY (underlying_key)
    REFERENCES underlying_asset (underlying_key) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT market_reality_radar_watch_representation_fk FOREIGN KEY (
    chain_id, token_address, underlying_key
  ) REFERENCES representation_underlying (chain_id, token_address, underlying_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS market_reality_radar_watch_user_slot_unique
  ON market_reality_radar_watches (user_id, watch_slot);

CREATE UNIQUE INDEX IF NOT EXISTS market_reality_radar_watch_identity_unique
  ON market_reality_radar_watches (watch_id, chain_id, token_address);

CREATE UNIQUE INDEX IF NOT EXISTS market_reality_radar_watch_exact_unique
  ON market_reality_radar_watches (
    user_id, underlying_key, token_address, direction, requested_cash_atomic,
    destination, route_policy_key
  );

CREATE INDEX IF NOT EXISTS market_reality_radar_watch_user_idx
  ON market_reality_radar_watches (user_id, created_at ASC, watch_id ASC);

CREATE INDEX IF NOT EXISTS market_reality_radar_watch_token_idx
  ON market_reality_radar_watches (chain_id, token_address, created_at ASC);

CREATE TABLE IF NOT EXISTS market_reality_radar_state (
  watch_id       text        PRIMARY KEY,
  point          jsonb       NOT NULL,
  snapshot_hash  text        NOT NULL,
  observed_at    timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  CONSTRAINT market_reality_radar_state_watch_fk FOREIGN KEY (watch_id)
    REFERENCES market_reality_radar_watches (watch_id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT market_reality_radar_state_point CHECK (jsonb_typeof(point) = 'object'),
  CONSTRAINT market_reality_radar_state_snapshot CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS market_reality_radar_events (
  event_id                 text        PRIMARY KEY,
  watch_id                 text        NOT NULL,
  chain_id                 integer     NOT NULL,
  token_address            text        NOT NULL,
  kind                     text        NOT NULL,
  previous_snapshot_hash   text        NOT NULL,
  snapshot_hash            text        NOT NULL,
  previous_observed_at     timestamptz NOT NULL,
  occurred_at              timestamptz NOT NULL,
  approved_sources         jsonb       NOT NULL,
  facts                    jsonb       NOT NULL,
  recorded_at              timestamptz NOT NULL,
  CONSTRAINT market_reality_radar_event_watch_fk FOREIGN KEY (
    watch_id, chain_id, token_address
  ) REFERENCES market_reality_radar_watches (watch_id, chain_id, token_address)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT market_reality_radar_event_chain CHECK (chain_id = 8453),
  CONSTRAINT market_reality_radar_event_id CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT market_reality_radar_event_address CHECK (
    token_address = lower(token_address) AND token_address ~ '^0x[0-9a-f]{40}$'
  ),
  CONSTRAINT market_reality_radar_event_kind CHECK (kind IN (
    'sell_exit_cost_changed',
    'buy_effective_price_changed',
    'route_became_unavailable',
    'route_became_available',
    'market_session_changed',
    'reference_became_stale',
    'representation_ratio_changed'
  )),
  CONSTRAINT market_reality_radar_event_previous_snapshot CHECK (
    previous_snapshot_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT market_reality_radar_event_snapshot CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT market_reality_radar_event_time CHECK (
    previous_observed_at < occurred_at AND occurred_at <= recorded_at
  ),
  CONSTRAINT market_reality_radar_event_sources CHECK (
    jsonb_typeof(approved_sources) = 'array' AND jsonb_array_length(approved_sources) > 0
  ),
  CONSTRAINT market_reality_radar_event_facts CHECK (jsonb_typeof(facts) = 'object')
);

CREATE INDEX IF NOT EXISTS market_reality_radar_event_watch_idx
  ON market_reality_radar_events (watch_id, occurred_at DESC, event_id DESC);
