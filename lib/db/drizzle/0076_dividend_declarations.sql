-- Dividend declarations Miorail read from the companies themselves.
--
-- The calendar's declarations were a registry in code, changed by deploy. A
-- watcher now reads each company's own release as it comes out: Apple,
-- Alphabet and NVIDIA from their 8-K exhibits on EDGAR, Microsoft from its
-- newsroom, Meta from its release on PR Newswire. A release counts only when
-- the company's standing sentence matches in full, and the sentence is kept as
-- the row's quote. The registry still wins for a payment it already names.
--
-- One row per company and payment date, never rewritten: a release that says
-- something else for the same payment is logged and left for review, not
-- merged.
--
-- A new declaration is also a signal: `official_asset_dividend_declared`, one
-- per Coinbase token of that company, which the notifier sends to everyone
-- opted in, and to a holder with what it means for their tokens.
--
-- Applied by hand, as the app user, like every migration here. Re-runnable.

CREATE TABLE IF NOT EXISTS dividend_declarations (
  underlying_key    text        NOT NULL,
  pay_date          date        NOT NULL,
  record_date       date        NOT NULL,
  ex_date           date,
  -- The New York date the release went out.
  declared_on       date        NOT NULL,
  -- As the company wrote it: "0.525". Text, so no rounding ever touches it.
  amount_per_share  text        NOT NULL,
  symbol            text        NOT NULL,
  company           text        NOT NULL,
  source_kind       text        NOT NULL,
  source_publisher  text        NOT NULL,
  source_url        text        NOT NULL,
  -- The sentence the amount and both dates were read from, verbatim.
  source_quote      text        NOT NULL,
  -- When the release went out, and when Miorail first read it.
  published_at      timestamptz NOT NULL,
  observed_at       timestamptz NOT NULL,
  CONSTRAINT dividend_declarations_pk PRIMARY KEY (underlying_key, pay_date),
  CONSTRAINT dividend_declarations_kind CHECK (source_kind IN ('sec_8k', 'company_newsroom', 'press_wire')),
  CONSTRAINT dividend_declarations_amount CHECK (amount_per_share ~ '^[0-9]+\.[0-9]{2,4}$'),
  CONSTRAINT dividend_declarations_record_before_pay CHECK (record_date <= pay_date),
  CONSTRAINT dividend_declarations_declared_before_record CHECK (declared_on <= record_date),
  CONSTRAINT dividend_declarations_https CHECK (source_url ~ '^https://'),
  CONSTRAINT dividend_declarations_quote CHECK (length(source_quote) BETWEEN 20 AND 1200),
  CONSTRAINT dividend_declarations_observed_after_published CHECK (observed_at >= published_at)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miorail_user') THEN
    EXECUTE 'ALTER TABLE dividend_declarations OWNER TO miorail_user';
  END IF;
END
$$;

-- The eleventh kind: a company declared a dividend. A fact about the
-- underlying, stated once per token that will convert it.
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
  'official_asset_multiplier_change_cancelled',
  'official_asset_dividend_declared'
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
  'official_asset_multiplier_change_cancelled',
  'official_asset_dividend_declared'
));
