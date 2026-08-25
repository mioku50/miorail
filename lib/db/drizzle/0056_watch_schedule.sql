-- The freshness promise, per ADDRESS.
--
-- WHY THIS IS NOT A COLUMN ON `b20_watchlist`
--
-- That table is a SUBSCRIPTION: one row per user per token, and its
-- `last_swept_at` is per row. Two people watching the same token therefore
-- produce two reads of the same contract at the same block, forever, and the
-- operator pays twice for one answer. The roadmap states the rule plainly —
-- one measurement serves every watcher of an address — and a per-user column
-- cannot express it.
--
-- So the subscription stays per user and the SCHEDULE lives here, keyed by the
-- address. A row exists while at least one account watches it.
--
-- WHY THE INTERVAL IS STORED RATHER THAN CONFIGURED
--
-- The interval is derived from how many distinct addresses are watched, what
-- one check costs, and what we are willing to spend per minute. It changes
-- when the corpus grows. Storing what was PROMISED at the time of the last
-- check is what lets a surface say "checked hourly, next check in 11 minutes"
-- and have both halves come from the same fact — rather than printing a
-- constant beside a timestamp and leaving a reader to discover they disagree.
--
-- WHAT A FAILED CHECK DOES
--
-- It moves the clock and nothing else. `last_outcome` records that the pass
-- did not complete, `last_checked_at` advances so a broken address cannot
-- monopolise the queue, and `last_completed_at` does NOT — so the promise a
-- surface renders is about the last read that actually established something.
-- The acceptance criterion for this phase is that a temporary provider failure
-- never becomes a change about an asset, and separating these two timestamps
-- is where that starts.

CREATE TABLE IF NOT EXISTS watch_schedule (
  chain_id            integer     NOT NULL,
  token_address       text        NOT NULL,
  -- What was promised when this row was last scheduled, in seconds. Derived,
  -- never configured: see the header.
  interval_seconds    integer     NOT NULL,
  -- When the sweep last REACHED this address, whatever came of it.
  last_checked_at     timestamptz,
  -- When a check last COMPLETED. A failed pass moves the line above and not
  -- this one, so freshness is never claimed from an outage.
  last_completed_at   timestamptz,
  -- What the last check produced.
  last_outcome        text,
  -- When the next check is owed. The queue reads this and nothing else.
  next_due_at         timestamptz NOT NULL,
  checks              bigint      NOT NULL DEFAULT 0,
  completed_checks    bigint      NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL,
  CONSTRAINT watch_schedule_pk PRIMARY KEY (chain_id, token_address),
  CONSTRAINT watch_schedule_chain CHECK (chain_id = 8453),
  CONSTRAINT watch_schedule_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT watch_schedule_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  -- A promise faster than fifteen minutes is one this product has never
  -- measured itself able to keep, and one slower than a day is not a promise.
  CONSTRAINT watch_schedule_interval_range CHECK (interval_seconds BETWEEN 900 AND 86400),
  CONSTRAINT watch_schedule_outcome CHECK (
    last_outcome IS NULL OR last_outcome IN ('measured', 'measurement_failed', 'unreadable')
  ),
  -- An outcome with no check behind it describes a read that never happened.
  CONSTRAINT watch_schedule_outcome_has_a_check CHECK (
    (last_outcome IS NULL) = (last_checked_at IS NULL)
  ),
  -- A completion is a check. The reverse is not true, and that asymmetry is
  -- the point of having two columns.
  CONSTRAINT watch_schedule_completion_implies_check CHECK (
    last_completed_at IS NULL OR (last_checked_at IS NOT NULL AND last_completed_at <= last_checked_at)
  ),
  CONSTRAINT watch_schedule_counts_nonnegative CHECK (checks >= 0 AND completed_checks >= 0),
  CONSTRAINT watch_schedule_completed_within_checks CHECK (completed_checks <= checks)
);

-- The queue: what is owed, oldest debt first.
CREATE INDEX IF NOT EXISTS watch_schedule_due_idx
  ON watch_schedule (chain_id, next_due_at);
