-- Project claims, and the fundamental evidence hanging off them.
--
-- WHAT THIS ANSWERS
--
-- Discover says what a token MEASURED. It has never been able to say whether
-- there is a project behind it, and the reason is not effort — it is that the
-- question cannot be answered from a token. Everything in a launch log is typed
-- by whoever launched it, so resolving a project by name or symbol would hand
-- one project's record to whoever copied its ticker, with Miorail vouching.
--
-- So a project claims a token FROM A DOMAIN IT CONTROLS, and the claim is what
-- everything else hangs off:
--
--   token --(launch sender / domain file / project publication)--> domain
--   domain --(the project's own declaration)--> website, product, repo, docs
--
-- WHY TWO TABLES
--
-- The claim is an identity assertion with a status; the evidence is a set of
-- probe results that are replaced wholesale on every pass. Putting them in one
-- row would mean re-asserting the identity every time a website probe ran, and
-- a jsonb blob would make "which tokens have a live product" a filter nothing
-- can index.
--
-- WHY EVIDENCE HAS A FOREIGN KEY TO THE CLAIM
--
-- Because the claim is the PERMISSION to attach anything. Without the key, an
-- evidence row could outlive the claim that justified it — which is exactly a
-- copycat inheriting a real project's profile, written by a delete that missed
-- a table. ON DELETE CASCADE means removing a claim removes what it permitted.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No score, no rank, no numeric column of any kind on either table. There is
-- nothing to sort by, which is the strongest form the "no investment signal"
-- rule can take: a later query cannot ORDER BY a column that does not exist.
--
-- No commit count. A commit total is a quality score with a technical name,
-- and the only repository facts stored are two dates.

CREATE TABLE IF NOT EXISTS b20_project_claims (
  id                bigserial PRIMARY KEY,
  chain_id          integer     NOT NULL,
  token_address     text        NOT NULL,
  -- A bare hostname. What the claim was made FROM and proven against.
  claimant_domain   text        NOT NULL,
  status            text        NOT NULL,
  -- Which of the three links passed and which failed. A link in neither array
  -- was not checked, which is a third state and not a failure.
  verified_links    text[]      NOT NULL DEFAULT '{}',
  refuted_links     text[]      NOT NULL DEFAULT '{}',
  last_checked_at   timestamptz NOT NULL,
  CONSTRAINT b20_project_claims_token_key UNIQUE (chain_id, token_address),
  CONSTRAINT b20_project_claims_address_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT b20_project_claims_address_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT b20_project_claims_domain_lower CHECK (claimant_domain = lower(claimant_domain)),
  CONSTRAINT b20_project_claims_status CHECK (status IN ('unverified', 'verified', 'refuted')),
  -- A verified claim with no verified link is the row that would open the gate
  -- on no evidence at all.
  CONSTRAINT b20_project_claims_verified_has_link
    CHECK (status <> 'verified' OR cardinality(verified_links) > 0),
  CONSTRAINT b20_project_claims_refuted_has_link
    CHECK (status <> 'refuted' OR cardinality(refuted_links) > 0)
);

CREATE INDEX IF NOT EXISTS b20_project_claims_verified_idx
  ON b20_project_claims (chain_id, token_address)
  WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS b20_project_evidence (
  id             bigserial PRIMARY KEY,
  chain_id       integer     NOT NULL,
  token_address  text        NOT NULL,
  dimension      text        NOT NULL,
  state          text        NOT NULL,
  provenance     text        NOT NULL,
  -- Always something the PROJECT published: an https URL or a bare address.
  -- Never a Miorail endpoint and never a credential.
  reference      text,
  observed_at    timestamptz NOT NULL,
  CONSTRAINT b20_project_evidence_dimension_key UNIQUE (chain_id, token_address, dimension),
  CONSTRAINT b20_project_evidence_claim_fk
    FOREIGN KEY (chain_id, token_address)
    REFERENCES b20_project_claims (chain_id, token_address)
    ON DELETE CASCADE,
  CONSTRAINT b20_project_evidence_address_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT b20_project_evidence_dimension CHECK (dimension IN (
    'project_identity', 'website', 'product', 'repository',
    'base_presence', 'docs', 'project_before_token', 'development_activity'
  )),
  CONSTRAINT b20_project_evidence_state CHECK (state IN (
    'verified', 'unverified', 'live', 'found', 'active', 'quiet', 'yes', 'no', 'unknown'
  )),
  -- `not_collected` is the ABSENCE of a row. A dimension nobody collected has
  -- no row at all, which is what makes "unknown" unforgeable.
  CONSTRAINT b20_project_evidence_provenance CHECK (provenance IN (
    'domain_claim_file', 'https_probe', 'functional_probe',
    'repository_api', 'onchain_read', 'timestamp_comparison'
  )),
  -- Absence of evidence is never evidence of absence. The ONE dimension that
  -- may be negative is a comparison of two timestamps Miorail actually holds.
  CONSTRAINT b20_project_evidence_no_negative_states
    CHECK (state <> 'no' OR dimension = 'project_before_token'),
  CONSTRAINT b20_project_evidence_reference_shape
    CHECK (reference IS NULL OR reference ~ '^https://' OR reference ~ '^0x[0-9a-fA-F]{40}$')
);

CREATE INDEX IF NOT EXISTS b20_project_evidence_product_idx
  ON b20_project_evidence (chain_id, token_address)
  WHERE dimension = 'product' AND state = 'live';
