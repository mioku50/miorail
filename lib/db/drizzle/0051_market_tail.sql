-- The shadow market tail: what actually MOVED for a tracked asset, read from
-- the chain and mapped to the place it moved through.
--
-- WHY THE TOKEN'S OWN LEDGER AND NOT ONE VENUE'S EVENTS
--
-- The roadmap proposed tailing the Uniswap v4 singleton, which is the right
-- instrument for the launch corpus: one contract carries every v4 pool on Base.
-- It is the wrong instrument for the RWA vertical, and the measurement that
-- settled it is the same one that corrected the exit reading -- the official
-- tokenized equities trade mostly on Aerodrome, and a v4-only tail would have
-- reported a quiet market on assets doing hundreds of swaps an hour.
--
-- A token's own Transfer log has no such blind spot. Every venue, every
-- aggregator and every future venue moves the token, so the ledger sees all of
-- them without being told any of them exist. Measured 2026-08-25: ONE
-- eth_getLogs covering all thirteen official assets over 2,000 blocks (about
-- 67 minutes) returned 5,833 transfers in 1.5 seconds. That is roughly one
-- call per hour for the whole vertical, against ten to twelve per token for
-- the pool-by-pool measurement it replaces.
--
-- WHY VENUES ARE DISCOVERED RATHER THAN CONFIGURED
--
-- A pinned factory address is a guess that ages. The counterparties in the
-- ledger are the venues, and an address that both PAYS and RECEIVES the same
-- token is a pool by behaviour before it is a pool by address. Asking that
-- address what pair it holds turns the behaviour into an identity. Nothing
-- here needs to know that Aerodrome exists.
--
-- WHAT THIS DELIBERATELY DOES NOT CLAIM
--
-- Not a trade. A pool receives and pays the token when somebody swaps, and
-- also when somebody adds or removes liquidity. Measured over the shadow run's
-- own range on 2026-08-25: of 34 transactions where a tracked asset moved
-- through the Uniswap v4 singleton, 32 also carried a v4 Swap and 2 did not.
-- Six per cent is small and it is not nothing -- a first-trade signal firing
-- because somebody seeded a pool would be a false claim about the asset. The
-- table is therefore named for the movement, and confirming one as a swap is a
-- later and dearer read against the venue's own event.
--
-- Not who traded. The address on the other side is whatever the pool paid -- a
-- router, an aggregator's settlement contract, sometimes a wallet. The column
-- is called `counterparty` and it is never a trader. Measured over 2,170
-- observations: the busiest single counterparty accounted for 12.3% of them,
-- which is a router's share and not a person's.
--
-- Not a price. A transfer carries one side. The quote leg is a separate read,
-- and inventing it from a stored rate would be a number nobody measured.
--
-- REORG POLICY
--
-- The cursor never rewinds. Ingestion stops short of the head by a fixed
-- confirmation depth, and a re-read of the same range writes nothing because
-- (transaction, log index) is unique. A reorg deeper than that depth would
-- leave a row describing a transaction that no longer exists; the depth is the
-- only defence and it is stated rather than implied.

CREATE TABLE IF NOT EXISTS market_venues (
  id             bigserial   PRIMARY KEY,
  chain_id       integer     NOT NULL,
  address        text        NOT NULL,
  kind           text        NOT NULL,
  -- Only a paired pool has these. A singleton holds every pool in one
  -- contract, so its pair is a property of the swap, not of the address.
  token0         text,
  token1         text,
  -- When the ledger first showed this address handling a tracked token, and
  -- when we asked the address what it is. A gap between them is a candidate
  -- still waiting for its two calls.
  first_seen_at  timestamptz NOT NULL,
  identified_at  timestamptz,
  CONSTRAINT market_venues_address_unique UNIQUE (chain_id, address),
  CONSTRAINT market_venues_address_lower CHECK (address = lower(address)),
  CONSTRAINT market_venues_address_shape CHECK (address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT market_venues_kind CHECK (kind IN ('candidate', 'paired_pool', 'singleton', 'not_a_venue')),
  CONSTRAINT market_venues_token0_shape CHECK (token0 IS NULL OR token0 ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT market_venues_token1_shape CHECK (token1 IS NULL OR token1 ~ '^0x[0-9a-f]{40}$'),
  -- A paired pool without its pair is the row that would let a later join
  -- guess which side the asset was on.
  CONSTRAINT market_venues_pair_complete
    CHECK (kind <> 'paired_pool' OR (token0 IS NOT NULL AND token1 IS NOT NULL)),
  -- Everything except a candidate has been asked. `not_a_venue` is a stored
  -- answer, not an absence: it is what stops the same router being probed
  -- every hour forever.
  CONSTRAINT market_venues_identified
    CHECK (kind = 'candidate' OR identified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS market_venues_candidate_idx
  ON market_venues (chain_id, first_seen_at)
  WHERE kind = 'candidate';

CREATE TABLE IF NOT EXISTS market_venue_transfers (
  id                bigserial   PRIMARY KEY,
  chain_id          integer     NOT NULL,
  token_address     text        NOT NULL,
  venue_address     text        NOT NULL,
  -- What the log says, not what it means. `out_of_venue` is the asset leaving
  -- a pool; reading that as a purchase is a projection, and it lives in code
  -- where it can carry its caveats.
  direction         text        NOT NULL,
  -- The non-venue side. A router as often as a person -- see the header.
  counterparty      text        NOT NULL,
  amount_atomic     text        NOT NULL,
  block_number      bigint      NOT NULL,
  transaction_hash  text        NOT NULL,
  log_index         integer     NOT NULL,
  observed_at       timestamptz NOT NULL,
  CONSTRAINT market_venue_transfers_log_unique UNIQUE (chain_id, transaction_hash, log_index),
  CONSTRAINT market_venue_transfers_direction CHECK (direction IN ('out_of_venue', 'into_venue')),
  CONSTRAINT market_venue_transfers_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT market_venue_transfers_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT market_venue_transfers_venue_shape CHECK (venue_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT market_venue_transfers_counterparty_shape CHECK (counterparty ~ '^0x[0-9a-f]{40}$'),
  -- A venue on both sides is pool-to-pool routing, not a trade by anybody, and
  -- it is refused here rather than filtered by whoever remembers to.
  CONSTRAINT market_venue_transfers_counterparty_is_not_the_venue CHECK (counterparty <> venue_address),
  CONSTRAINT market_venue_transfers_amount_digits CHECK (amount_atomic ~ '^[0-9]+$'),
  CONSTRAINT market_venue_transfers_block_positive CHECK (block_number > 0),
  CONSTRAINT market_venue_transfers_log_index_nonnegative CHECK (log_index >= 0)
);

CREATE INDEX IF NOT EXISTS market_venue_transfers_token_block_idx
  ON market_venue_transfers (chain_id, token_address, block_number DESC);

CREATE TABLE IF NOT EXISTS market_tail_cursors (
  tail_key          text        PRIMARY KEY,
  chain_id          integer     NOT NULL,
  -- The last block whose logs are stored. The next pass starts after it and
  -- never before it: this cursor does not rewind.
  last_block        bigint      NOT NULL,
  last_run_at       timestamptz NOT NULL,
  -- What the tail has cost, cumulatively. A background reader with no recorded
  -- price is a budget nobody can defend.
  passes            bigint      NOT NULL DEFAULT 0,
  log_calls         bigint      NOT NULL DEFAULT 0,
  identity_calls    bigint      NOT NULL DEFAULT 0,
  events_written    bigint      NOT NULL DEFAULT 0,
  CONSTRAINT market_tail_cursors_block_positive CHECK (last_block > 0),
  CONSTRAINT market_tail_cursors_counts_nonnegative
    CHECK (passes >= 0 AND log_calls >= 0 AND identity_calls >= 0 AND events_written >= 0)
);
