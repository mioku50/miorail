-- WHO ISSUED THIS CONTRACT, and WHAT SHARE IT STANDS FOR, are two questions.
--
-- Phase 9A.5 established that Dinari's own factory on Base answers
-- `isTokenDShare(address)` — a public, address-first membership predicate on a
-- contract the issuer published. That is a defensible trust root, and it is
-- the reason this table exists: a `true` from the issuer's own factory is
-- evidence that Dinari issued this exact address.
--
-- It is NOT evidence of which stock the address represents.
--
-- The token declares `symbol() = "AAPL"`, and Dinari's own integration guide
-- says the opposite of what that invites: "Key off `stock_id`, never the
-- ticker symbol. Treat `symbol` as a display field." Symbol and name are
-- admin-settable on the deployed contract (`setName`, `setSymbol`), exactly as
-- they are on a B20. So the underlying is a SEPARATE axis with a SEPARATE
-- source, and it lives in `underlying_asset` / `representation_underlying`
-- below — where the honest current state is no rows at all.
--
-- Splitting them is the whole point. Collapsing them is how a reviewed
-- issuer's contract silently becomes a claim about Apple that nobody reviewed.
--
-- WHY A ROOT IS PINNED WITH ITS ENVIRONMENT
--
-- Measured 2026-08-26, TWO Dinari factories are live on Base and they disagree:
--
--   0xbce6…bc4d   releases/v0.4.0  production.8453   isTokenDShare(AAPL) = true
--   0x4cdb…15a9   releases/v1.0.0  staging.8453      isTokenDShare(AAPL) = false
--
-- Neither is wrong. They are different environments of the same issuer, and
-- the newest release file names NO production factory for Base at all. A row
-- therefore carries the root it came from, and membership under one root is
-- never read as membership under another.
--
-- WHY MEMBERSHIP IS STORED, NOT DERIVED
--
-- `getDShares()` reverts on both factories although both release ABIs declare
-- it. There is no enumerable list. Membership can only be established one
-- candidate at a time, which makes this a verify-a-candidate registry: a row
-- exists because somebody asked the root about that exact address and the root
-- answered. An address with no row was never asked.

CREATE TABLE IF NOT EXISTS issuer_membership_check (
  id                  text          PRIMARY KEY,
  issuer_id           text          NOT NULL,
  -- Which pinned root was asked. Reviewed in code, stored here so a row
  -- outlives a later re-pin instead of silently re-attributing itself.
  root_key            text          NOT NULL,
  chain_id            integer       NOT NULL,
  root_address        text          NOT NULL,
  predicate_selector  text          NOT NULL,
  status              text          NOT NULL,
  block_number        text,
  block_hash          text,
  -- What this pass asked and what came back. `unread` is ours, and it is
  -- counted apart so an endpoint outage can never read as a refutation.
  candidates          integer       NOT NULL,
  established         integer       NOT NULL,
  refuted             integer       NOT NULL,
  unread              integer       NOT NULL,
  observed_at         timestamptz   NOT NULL,
  -- Why a check did not complete, in our words. Never a URL, never a key.
  detail              text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT issuer_membership_check_status CHECK (
    status IN ('ok', 'root_unreadable', 'endpoint_unavailable')),
  CONSTRAINT issuer_membership_check_addresses CHECK (
    root_address = lower(root_address) AND root_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT issuer_membership_check_selector CHECK (
    predicate_selector ~ '^0x[0-9a-f]{8}$'),
  CONSTRAINT issuer_membership_check_counts CHECK (
    candidates >= 0 AND established >= 0 AND refuted >= 0 AND unread >= 0
    AND established + refuted + unread = candidates),
  -- A check that did not complete cannot have decided anything.
  CONSTRAINT issuer_membership_check_incomplete_decides_nothing CHECK (
    status = 'ok' OR (established = 0 AND refuted = 0)),
  -- An answer from the chain has a block behind it.
  CONSTRAINT issuer_membership_check_anchored CHECK (
    (status = 'ok') = (block_number IS NOT NULL AND block_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS issuer_membership_check_recent_idx
  ON issuer_membership_check (issuer_id, root_key, observed_at DESC);

CREATE TABLE IF NOT EXISTS issuer_representation (
  chain_id          integer       NOT NULL,
  token_address     text          NOT NULL,
  issuer_id         text          NOT NULL,
  root_key          text          NOT NULL,
  root_address      text          NOT NULL,
  -- What the root said about this exact address. There is no third value: a
  -- read that failed writes no row, so "we could not ask" is the absence of
  -- this row and never a value inside it.
  membership        text          NOT NULL,
  block_number      text          NOT NULL,
  block_hash        text          NOT NULL,
  evidence_hash     text          NOT NULL,
  first_seen_at     timestamptz   NOT NULL,
  last_checked_at   timestamptz   NOT NULL,
  last_changed_at   timestamptz,
  reads             bigint        NOT NULL DEFAULT 1,
  changes           bigint        NOT NULL DEFAULT 0,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT issuer_representation_pk PRIMARY KEY (chain_id, token_address, issuer_id, root_key),
  CONSTRAINT issuer_representation_membership CHECK (
    membership IN ('established', 'refuted')),
  CONSTRAINT issuer_representation_issuer CHECK (
    issuer_id IN ('coinbase', 'dinari')),
  CONSTRAINT issuer_representation_addresses CHECK (
    token_address = lower(token_address) AND token_address ~ '^0x[0-9a-f]{40}$'
    AND root_address = lower(root_address) AND root_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT issuer_representation_hashes CHECK (
    block_hash ~ '^0x[0-9a-f]{64}$' AND evidence_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT issuer_representation_counts CHECK (reads >= 1 AND changes >= 0 AND changes < reads),
  -- The first sighting is never a change. Same rule as representation_ratio,
  -- for the same reason: a first pass that announced 50 issuer changes would
  -- be reporting our own cold start as the issuer's activity.
  CONSTRAINT issuer_representation_change_has_a_time CHECK (
    (changes = 0) = (last_changed_at IS NULL)),
  CONSTRAINT issuer_representation_seen_before_checked CHECK (last_checked_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS issuer_representation_by_issuer_idx
  ON issuer_representation (chain_id, issuer_id, membership, token_address);

-- ---------------------------------------------------------------------------
-- The underlying axis. Deliberately empty.
--
-- No reviewed source currently binds a Base address to a stable identifier for
-- the security it represents. Dinari publishes one — `stock_id`, a uuid that
-- survives ticker and CUSIP changes — but it is behind an organization-only
-- partner key, so nothing here can be filled without credentials that do not
-- exist for an individual. Base Docs bind a token ticker to a Chainlink feed
-- label, which is another ticker, not a stable identifier.
--
-- Empty is therefore the correct state, and it is the precise thing that
-- blocks a cross-issuer comparison: you cannot put two issuers' Apple side by
-- side until somebody reviewed which two contracts those are. Writing this
-- table now, with the foreign key, is what stops that gap from being closed by
-- inference later.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS underlying_asset (
  -- Namespaced by the source that issued it: `dinari:stock_id:<uuid>`. Never a
  -- bare ticker — a ticker is a display field that the issuer itself says to
  -- refresh rather than key off.
  underlying_key    text          PRIMARY KEY,
  asset_class       text          NOT NULL,
  canonical_name    text          NOT NULL,
  source_kind       text          NOT NULL,
  source_ref        text          NOT NULL,
  observed_at       timestamptz   NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT underlying_asset_key_namespaced CHECK (underlying_key ~ '^[a-z0-9_]+:[a-z0-9_]+:.+$'),
  CONSTRAINT underlying_asset_class CHECK (
    asset_class IN ('equity', 'fund_share', 'other')),
  CONSTRAINT underlying_asset_source CHECK (
    source_kind IN ('dinari_stock_api'))
);

CREATE TABLE IF NOT EXISTS representation_underlying (
  chain_id          integer       NOT NULL,
  token_address     text          NOT NULL,
  underlying_key    text          NOT NULL REFERENCES underlying_asset (underlying_key),
  source_kind       text          NOT NULL,
  source_ref        text          NOT NULL,
  observed_at       timestamptz   NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT representation_underlying_pk PRIMARY KEY (chain_id, token_address),
  CONSTRAINT representation_underlying_address CHECK (
    token_address = lower(token_address) AND token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT representation_underlying_source CHECK (
    source_kind IN ('dinari_stock_api'))
);

-- ---------------------------------------------------------------------------
-- The ratio store gains Dinari, and learns to say where the scale came from.
--
-- A B20 publishes its own scale (`WAD_PRECISION()`), so the reader READS it. A
-- dShare does not: the scale is a constant in the issuer's published source
-- ("This amount is assumed to have 18 decimals and is divided by 10**18 when
-- applied" — ERC20Rebasing.sol), so a reviewed adapter declares it.
--
-- Both end up as the same text in `scale`, and the difference between them is
-- the difference between measured and reviewed. A column, so a surface can
-- never claim we read something we were told.
-- ---------------------------------------------------------------------------

ALTER TABLE representation_ratio
  ADD COLUMN IF NOT EXISTS scale_source text NOT NULL DEFAULT 'read_from_contract';

ALTER TABLE representation_ratio DROP CONSTRAINT IF EXISTS representation_ratio_scale_source;
ALTER TABLE representation_ratio ADD CONSTRAINT representation_ratio_scale_source CHECK (
  scale_source IN ('read_from_contract', 'reviewed_constant'));

ALTER TABLE representation_ratio DROP CONSTRAINT IF EXISTS representation_ratio_kind;
ALTER TABLE representation_ratio ADD CONSTRAINT representation_ratio_kind CHECK (
  ratio_kind IN ('b20_multiplier', 'dinari_balance_per_share'));

ALTER TABLE representation_ratio_change DROP CONSTRAINT IF EXISTS representation_ratio_change_kind;
ALTER TABLE representation_ratio_change ADD CONSTRAINT representation_ratio_change_kind CHECK (
  ratio_kind IN ('b20_multiplier', 'dinari_balance_per_share'));
