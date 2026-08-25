-- Signals: what CHANGED about an official asset, recorded when it changed.
--
-- WHY A TABLE AND NOT A QUERY
--
-- Every fact this feed reports is already derivable from state we store.
-- `official_assets.first_seen_at` would give "added"; `currently_listed` false
-- would give "removed"; the earliest stored transfer would give "the market
-- started". All three would be wrong in the same way, and it is the way this
-- product exists to avoid: they describe when MIORAIL first looked, not when
-- the thing happened.
--
-- The corpus was first read on 2026-08-25. Deriving "added" from state would
-- announce thirteen brand-new listings that day, for assets Coinbase had
-- issued weeks earlier. So a signal is written at the moment a writer observes
-- a transition against a state it had already stored -- never reconstructed
-- afterwards from the state itself.
--
-- WHY THE WATCH TABLE
--
-- A transition can only be observed by somebody who was already watching. The
-- first pass of any emitter sees everything as new, and none of it is. So each
-- emitter opens its watch BEFORE it looks, the pass that opens the watch emits
-- nothing, and every later pass compares against a state that exists.
--
-- `watching_since` is also what an empty feed means. "No signals" and "nothing
-- has been watched yet" are the same empty list and opposite facts, and the
-- surface prints the date rather than leaving a reader to assume the market is
-- quiet.
--
-- WHAT IS DELIBERATELY NOT A SIGNAL HERE
--
-- A movement through a venue. Migration 0051 measured the gap: of 34
-- transactions moving a tracked asset through the Uniswap v4 singleton, 32
-- carried a Swap event and 2 did not. A "first trade" signal firing because
-- somebody seeded a pool would be a false statement about the asset, so the
-- market kinds below are driven by the cash-exit measurement -- a round trip
-- that either completed or did not -- and not by the ledger tail.

CREATE TABLE IF NOT EXISTS rwa_signal_watch (
  chain_id        integer     NOT NULL,
  kind            text        NOT NULL,
  -- When this emitter first ran. Nothing before it can be reported, and the
  -- feed says so instead of implying silence.
  watching_since  timestamptz NOT NULL,
  CONSTRAINT rwa_signal_watch_pk PRIMARY KEY (chain_id, kind),
  CONSTRAINT rwa_signal_watch_kind CHECK (kind IN (
    'official_source_added_asset',
    'official_source_removed_asset',
    'official_asset_lookalike_created',
    'official_asset_market_became_active',
    'official_asset_market_became_unreachable',
    'official_asset_cash_exit_changed'
  ))
);

CREATE TABLE IF NOT EXISTS rwa_signals (
  id                bigserial   PRIMARY KEY,
  chain_id          integer     NOT NULL,
  kind              text        NOT NULL,
  -- The contract the signal is about. For a lookalike that is the resembling
  -- contract, not the official one -- the subject of the sentence.
  subject_address   text        NOT NULL,
  -- The official asset involved, when the signal is about a relationship.
  official_address  text,
  -- When the transition happened, as the emitter observed it.
  occurred_at       timestamptz NOT NULL,
  -- When we wrote it. Never the same field as the above: a backfilled pass
  -- would otherwise date its findings to the moment it caught up.
  recorded_at       timestamptz NOT NULL,
  -- One transition, one row, forever. The key names the transition, so an
  -- emitter that re-runs over the same window writes nothing.
  dedupe_key        text        NOT NULL,
  -- The kind's own typed facts, validated by the repository on both sides.
  facts             jsonb       NOT NULL,
  CONSTRAINT rwa_signals_dedupe UNIQUE (chain_id, dedupe_key),
  CONSTRAINT rwa_signals_chain CHECK (chain_id = 8453),
  CONSTRAINT rwa_signals_kind CHECK (kind IN (
    'official_source_added_asset',
    'official_source_removed_asset',
    'official_asset_lookalike_created',
    'official_asset_market_became_active',
    'official_asset_market_became_unreachable',
    'official_asset_cash_exit_changed'
  )),
  CONSTRAINT rwa_signals_subject_lower CHECK (subject_address = lower(subject_address)),
  CONSTRAINT rwa_signals_subject_shape CHECK (subject_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT rwa_signals_official_lower CHECK (official_address IS NULL OR official_address = lower(official_address)),
  CONSTRAINT rwa_signals_official_shape CHECK (official_address IS NULL OR official_address ~ '^0x[0-9a-f]{40}$'),
  -- A lookalike signal compares two contracts. Without the second address it
  -- renders as a comparison against nothing.
  CONSTRAINT rwa_signals_lookalike_names_official CHECK (
    kind <> 'official_asset_lookalike_created' OR official_address IS NOT NULL
  ),
  -- ...and the two are never the same contract, which is the same rule
  -- migration 0053 enforces on the table this signal is emitted from.
  CONSTRAINT rwa_signals_official_is_not_the_subject CHECK (
    official_address IS NULL OR official_address <> subject_address
  ),
  CONSTRAINT rwa_signals_facts_object CHECK (jsonb_typeof(facts) = 'object'),
  CONSTRAINT rwa_signals_recorded_after_occurred CHECK (recorded_at >= occurred_at)
);

-- The feed: newest first, optionally narrowed to one kind.
CREATE INDEX IF NOT EXISTS rwa_signals_feed_idx
  ON rwa_signals (chain_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS rwa_signals_kind_feed_idx
  ON rwa_signals (chain_id, kind, occurred_at DESC, id DESC);

-- One asset's own history, for the card that shows it.
CREATE INDEX IF NOT EXISTS rwa_signals_subject_idx
  ON rwa_signals (chain_id, subject_address, occurred_at DESC);
