-- The corporate-action record: what a tokenized stock announced about itself,
-- onchain, in the issuer's own words.
--
-- WHY NOW, WITH NOTHING TO SHOW
--
-- Base wraps every holder-impacting operation on a B20 asset in one call:
-- `announce` emits `Announcement`, runs the inner calls atomically, then emits
-- `EndAnnouncement`. A dividend, a split, a batch mint and a multiplier change
-- all execute inside that bracket, and Base's own integration page says what
-- the bracket is for: "integrators index these to catch corporate actions as
-- they execute".
--
-- Nothing has executed yet. Every Coinbase tokenized stock still reads a
-- multiplier of exactly 1.0 and no announcement has been emitted on any of
-- them. That is the reason to open this record now rather than on the day of
-- the first dividend. A reader started on that day can report the event it was
-- built for and cannot say whether it was the first, because it has no record
-- of the silence before it. A reader started while the record is empty can,
-- and the emptiness is then a measurement rather than an assumption.
--
-- WHY THE RAW LOG IS STORED BESIDE THE DECODED FIELDS
--
-- Base publishes topic0 for each of these events and does not publish which of
-- their parameters are indexed. An indexed `string` is stored as a hash of
-- itself and is unrecoverable, so a log whose layout this build cannot read is
-- recorded as `topic_only`: the event happened, in this transaction, at this
-- block, and its arguments were somewhere we could not read them. Keeping the
-- topics and data verbatim means a later reader that learns the layout can
-- decode a row this one could not -- and it means no field here was ever
-- assembled from bytes that did not line up.
--
-- WHAT `block_time` IS FOR
--
-- The block's own timestamp: when the action EXECUTED. `observed_at` is when
-- we read it. They are separate columns for the same reason `rwa_signals` has
-- both, and the reason is a bug this project has already shipped once: a pass
-- catching up after an outage otherwise dates every finding to the moment it
-- caught up.
--
-- REORG POLICY
--
-- Identical to migration 0051 and shared with it: the cursor lives in
-- `market_tail_cursors` under its own key, it never rewinds, ingestion stops
-- short of the head by a fixed confirmation depth, and (transaction, log index)
-- is unique so a re-read writes nothing.

CREATE TABLE IF NOT EXISTS b20_corporate_actions (
  id                bigserial   PRIMARY KEY,
  chain_id          integer     NOT NULL,
  token_address     text        NOT NULL,
  -- The four events Base publishes on IB20Asset. `announcement` opens the
  -- bracket, `end_announcement` closes it, and the two multiplier events are
  -- the deprecated setter and the scheduled one -- which setter an issuer used
  -- is not the holder's problem, so both are read.
  event             text        NOT NULL,
  -- The issuer's own id string, which brackets one action. Unique forever per
  -- the spec, so the open and the close of one action share it.
  announcement_id   text,
  -- Who called `announce`: an operator, never a holder.
  caller            text,
  description       text,
  uri               text,
  -- WAD-scaled, exactly as the contract published it. Never pre-divided: a
  -- ratio rounded on the way in cannot be un-rounded by a reader who needs the
  -- exact value.
  multiplier_wad    text,
  -- Whether the arguments came out of the data, or only the event did.
  payload_state     text        NOT NULL,
  -- The log, verbatim. See the header.
  topics            jsonb       NOT NULL,
  data              text        NOT NULL,
  block_number      bigint      NOT NULL,
  block_time        timestamptz NOT NULL,
  transaction_hash  text        NOT NULL,
  log_index         integer     NOT NULL,
  observed_at       timestamptz NOT NULL,
  CONSTRAINT b20_corporate_actions_log_unique UNIQUE (chain_id, transaction_hash, log_index),
  CONSTRAINT b20_corporate_actions_chain CHECK (chain_id = 8453),
  CONSTRAINT b20_corporate_actions_event CHECK (event IN (
    'announcement', 'end_announcement', 'multiplier_updated', 'ui_multiplier_updated'
  )),
  CONSTRAINT b20_corporate_actions_payload CHECK (payload_state IN ('decoded', 'topic_only')),
  CONSTRAINT b20_corporate_actions_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT b20_corporate_actions_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT b20_corporate_actions_caller_shape
    CHECK (caller IS NULL OR caller ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT b20_corporate_actions_tx_shape CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT b20_corporate_actions_multiplier_digits
    CHECK (multiplier_wad IS NULL OR multiplier_wad ~ '^[1-9][0-9]*$'),
  CONSTRAINT b20_corporate_actions_block_positive CHECK (block_number > 0),
  CONSTRAINT b20_corporate_actions_log_index_nonnegative CHECK (log_index >= 0),
  CONSTRAINT b20_corporate_actions_topics_array CHECK (jsonb_typeof(topics) = 'array'),
  CONSTRAINT b20_corporate_actions_data_hex CHECK (data ~ '^0x([0-9a-f][0-9a-f])*$'),
  -- A row that claims every argument was read must carry the ones its event
  -- declares. This is the constraint that stops a half-decoded log from
  -- reaching a screen as a complete announcement.
  CONSTRAINT b20_corporate_actions_decoded_is_complete CHECK (
    payload_state <> 'decoded'
    OR (event = 'announcement' AND announcement_id IS NOT NULL AND caller IS NOT NULL
        AND description IS NOT NULL AND uri IS NOT NULL AND multiplier_wad IS NULL)
    OR (event = 'end_announcement' AND announcement_id IS NOT NULL AND caller IS NULL
        AND description IS NULL AND uri IS NULL AND multiplier_wad IS NULL)
    OR (event IN ('multiplier_updated', 'ui_multiplier_updated') AND multiplier_wad IS NOT NULL
        AND announcement_id IS NULL AND caller IS NULL AND description IS NULL AND uri IS NULL)
  ),
  -- ...and a row that says it read nothing must not carry anything either.
  CONSTRAINT b20_corporate_actions_topic_only_is_empty CHECK (
    payload_state <> 'topic_only'
    OR (announcement_id IS NULL AND caller IS NULL AND description IS NULL
        AND uri IS NULL AND multiplier_wad IS NULL)
  ),
  CONSTRAINT b20_corporate_actions_observed_after_block CHECK (observed_at >= block_time)
);

-- One asset's own history, newest first: the card that shows it.
CREATE INDEX IF NOT EXISTS b20_corporate_actions_token_idx
  ON b20_corporate_actions (chain_id, token_address, block_time DESC, id DESC);

-- The market-wide feed.
CREATE INDEX IF NOT EXISTS b20_corporate_actions_feed_idx
  ON b20_corporate_actions (chain_id, block_time DESC, id DESC);

-- Where a tail STARTED, beside where it has got to.
--
-- `last_block` alone cannot say what a record covers. An empty corporate-action
-- feed is evidence of quiet only across a range somebody can name, and the
-- whole reason for opening this record before the first dividend is to be able
-- to name one. Nullable, because the ledger tail's row predates the column and
-- inventing a start for it would be worse than admitting we do not know.
ALTER TABLE market_tail_cursors ADD COLUMN IF NOT EXISTS first_block bigint;
ALTER TABLE market_tail_cursors DROP CONSTRAINT IF EXISTS market_tail_cursors_first_block_positive;
ALTER TABLE market_tail_cursors ADD CONSTRAINT market_tail_cursors_first_block_positive
  CHECK (first_block IS NULL OR first_block > 0);

-- Applied by hand, like every migration here, and a CREATE TABLE run as
-- `postgres` leaves the app with neither SELECT nor INSERT on it. That has cost
-- this project a month of unrecorded RPC spend once already; the `DO` block
-- makes the ownership correct without an operator remembering, and still
-- replays on a database that has no such role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE b20_corporate_actions OWNER TO miorail_user';
    EXECUTE 'ALTER SEQUENCE b20_corporate_actions_id_seq OWNER TO miorail_user';
  END IF;
END
$$;

-- Two new signal kinds. An announcement is a transition by construction -- the
-- log IS the event -- but the watch rule still applies unchanged: the tail
-- opens its watch before it reads, and anything dated before the watch opened
-- is history rather than news.
ALTER TABLE rwa_signal_watch DROP CONSTRAINT IF EXISTS rwa_signal_watch_kind;
ALTER TABLE rwa_signal_watch ADD CONSTRAINT rwa_signal_watch_kind CHECK (kind IN (
  'official_source_added_asset',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed'
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
  'official_asset_multiplier_changed'
));
