-- A scheduled multiplier change is a plan, and the record could not hold one.
--
-- WHAT WAS MISSING
--
-- Cobalt (Base mainnet, 2026-09-30) makes `updateUIMultiplier(newMultiplier,
-- effectiveAt)` the canonical path for splits and reinvested dividends. Three
-- of its properties are load-bearing here:
--
--   * the log fires when the change is SCHEDULED, not when it takes effect;
--   * NOTHING FIRES AT MATURATION -- `multiplier()` simply starts returning the
--     new value once `block.timestamp >= effectiveAt`, and no indexer is told;
--   * a live pending update can be cancelled, or superseded by the instant
--     emergency setter, and then it never happens at all.
--
-- Until now this table stored the new multiplier and threw the schedule away.
-- Every one of those three properties then collapses into the same defect: a
-- row that says a corporate action HAPPENED, when what the issuer published was
-- an intention to make one happen later -- possibly never. On the one number
-- that states how many real shares a token is.
--
-- TWO COLUMNS' WORTH OF FIX, AND ONE NEW EVENT
--
-- `effective_at` is the field that separates a plan from an event. With it, the
-- lifecycle is arithmetic anyone can check: `effective_at > block_time` is a
-- scheduled change and the token still converts with the OLD multiplier;
-- `effective_at <= block_time` is the instant setter, in force in its own
-- block. The deprecated `MultiplierUpdated` declares no schedule at all, so it
-- keeps a NULL -- meaning "this event has no schedule", never "we could not
-- read one".
--
-- `ui_multiplier_update_cancelled` is the withdrawal. Its two arguments name
-- the PLAN being called off -- (cancelledMultiplier, cancelledEffectiveAt) --
-- rather than any state the token is in, which is exactly what is needed to
-- match a cancellation to the change it retires. Without the event, a plan the
-- issuer called off stays on the record looking identical to one that will
-- happen.
--
-- WHAT IS NOT STORED, DELIBERATELY
--
-- The lifecycle STATE is not a column. It depends on the clock and on a reading
-- of the token's own `multiplier()`, so a stored state would be a cache of a
-- clock, and a clock cache is wrong for exactly as long as nobody looks. It is
-- derived on read, in `b20MultiplierStandingV1`, from these rows plus one
-- measurement.
--
-- SAFE ON A LIVE DATABASE. The column is nullable and every existing row keeps
-- a NULL, which is the correct value for all seven of them: three
-- `multiplier_updated` (no schedule declared) and four announcement brackets.
-- Cobalt is not live, so no `ui_multiplier_updated` row exists anywhere yet.

ALTER TABLE b20_corporate_actions
  ADD COLUMN IF NOT EXISTS effective_at timestamptz;

-- The event vocabulary gains the withdrawal.
ALTER TABLE b20_corporate_actions
  DROP CONSTRAINT IF EXISTS b20_corporate_actions_event;
ALTER TABLE b20_corporate_actions
  ADD CONSTRAINT b20_corporate_actions_event CHECK (event IN (
    'announcement',
    'end_announcement',
    'multiplier_updated',
    'ui_multiplier_updated',
    'ui_multiplier_update_cancelled'
  ));

-- A decoded row carries every argument its event declares, and nothing that
-- belongs to another event. The two scheduled events now need BOTH the
-- multiplier and the schedule: a multiplier with no date beside it is exactly
-- the half-read that would be published as executed.
ALTER TABLE b20_corporate_actions
  DROP CONSTRAINT IF EXISTS b20_corporate_actions_decoded_is_complete;
ALTER TABLE b20_corporate_actions
  ADD CONSTRAINT b20_corporate_actions_decoded_is_complete CHECK (
    payload_state <> 'decoded'
    OR (event = 'announcement' AND announcement_id IS NOT NULL AND caller IS NOT NULL
        AND description IS NOT NULL AND uri IS NOT NULL AND multiplier_wad IS NULL
        AND effective_at IS NULL)
    OR (event = 'end_announcement' AND announcement_id IS NOT NULL AND caller IS NULL
        AND description IS NULL AND uri IS NULL AND multiplier_wad IS NULL
        AND effective_at IS NULL)
    -- The deprecated instant setter. It publishes a multiplier and no date.
    OR (event = 'multiplier_updated' AND multiplier_wad IS NOT NULL
        AND effective_at IS NULL
        AND announcement_id IS NULL AND caller IS NULL AND description IS NULL AND uri IS NULL)
    -- Both ERC-8056 events carry the pair, and the pair is what identifies one
    -- plan across its announcement and its withdrawal.
    OR (event IN ('ui_multiplier_updated', 'ui_multiplier_update_cancelled')
        AND multiplier_wad IS NOT NULL AND effective_at IS NOT NULL
        AND announcement_id IS NULL AND caller IS NULL AND description IS NULL AND uri IS NULL)
  );

-- ...and a row that says it read nothing must not carry anything either. The
-- schedule joins that list for the same reason the multiplier is already on it.
ALTER TABLE b20_corporate_actions
  DROP CONSTRAINT IF EXISTS b20_corporate_actions_topic_only_is_empty;
ALTER TABLE b20_corporate_actions
  ADD CONSTRAINT b20_corporate_actions_topic_only_is_empty CHECK (
    payload_state <> 'topic_only'
    OR (announcement_id IS NULL AND caller IS NULL AND description IS NULL
        AND uri IS NULL AND multiplier_wad IS NULL AND effective_at IS NULL)
  );

-- Finding the pending changes for a token is the read every surface does, and
-- it is by token and schedule rather than by block.
CREATE INDEX IF NOT EXISTS b20_corporate_actions_schedule_idx
  ON b20_corporate_actions (chain_id, token_address, effective_at)
  WHERE effective_at IS NOT NULL;

-- TWO NEW SIGNAL KINDS, BECAUSE ONE OF THEM WAS SAYING SOMETHING FALSE
--
-- The signal feed mapped every non-announcement multiplier event to
-- `official_asset_multiplier_changed`. Under Cobalt that sentence becomes wrong
-- in two different ways at once: a SCHEDULED change would be reported as a
-- change that has happened, and a CANCELLATION -- the issuer calling one off --
-- would be reported as a change too. This feed is what answers "did anything
-- change today", so both would reach an agent as a fact about the asset.
--
-- Three kinds, three true sentences: it changed, it is planned for a date, the
-- plan was withdrawn. `official_asset_multiplier_changed` keeps its exact
-- meaning and its existing rows -- it now covers only changes that are in
-- force, which is what every row on file already is.
ALTER TABLE rwa_signal_watch DROP CONSTRAINT IF EXISTS rwa_signal_watch_kind;
ALTER TABLE rwa_signal_watch ADD CONSTRAINT rwa_signal_watch_kind CHECK (kind IN (
  'official_source_added_asset',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
  'official_asset_multiplier_change_scheduled',
  'official_asset_multiplier_change_cancelled'
));

ALTER TABLE rwa_signals DROP CONSTRAINT IF EXISTS rwa_signals_kind;
ALTER TABLE rwa_signals ADD CONSTRAINT rwa_signals_kind CHECK (kind IN (
  'official_source_added_asset',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
  'official_asset_multiplier_change_scheduled',
  'official_asset_multiplier_change_cancelled'
));
