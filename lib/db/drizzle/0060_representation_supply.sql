-- Current outstanding supply is evidence about a reviewed representation, not
-- its identity and not proof of a market. Every row is keyed by exact Base
-- address. Failed reads are stored as UNKNOWN and never as zero.

CREATE TABLE IF NOT EXISTS representation_supply_observation (
  id                  bigserial     PRIMARY KEY,
  chain_id            integer       NOT NULL,
  token_address       text          NOT NULL,
  supply_state        text          NOT NULL,
  total_supply_atomic text,
  decimals            integer,
  normalization       text          NOT NULL,
  block_number        text          NOT NULL,
  block_hash          text          NOT NULL,
  source              text          NOT NULL,
  evidence_hash       text          NOT NULL,
  read_outcome        text          NOT NULL,
  failure_code        text,
  observed_at         timestamptz   NOT NULL,
  recorded_at         timestamptz   NOT NULL,
  CONSTRAINT representation_supply_observation_chain CHECK (chain_id = 8453),
  CONSTRAINT representation_supply_observation_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT representation_supply_observation_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT representation_supply_observation_state CHECK (
    supply_state IN ('positive_supply', 'zero_supply', 'supply_unknown')
  ),
  CONSTRAINT representation_supply_observation_amount CHECK (
    total_supply_atomic IS NULL OR total_supply_atomic ~ '^(0|[1-9][0-9]*)$'
  ),
  CONSTRAINT representation_supply_observation_decimals CHECK (
    decimals IS NULL OR decimals BETWEEN 0 AND 36
  ),
  CONSTRAINT representation_supply_observation_normalization CHECK (
    normalization = 'raw_erc20_total_supply'
  ),
  CONSTRAINT representation_supply_observation_block CHECK (
    block_number ~ '^(0|[1-9][0-9]*)$' AND block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT representation_supply_observation_source CHECK (source = 'erc20_total_supply'),
  CONSTRAINT representation_supply_observation_evidence CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT representation_supply_observation_outcome CHECK (
    read_outcome IN ('success', 'rpc_failure', 'decode_failure')
  ),
  CONSTRAINT representation_supply_observation_fact_consistent CHECK (
    (read_outcome = 'success'
      AND total_supply_atomic IS NOT NULL AND decimals IS NOT NULL AND failure_code IS NULL
      AND ((total_supply_atomic = '0' AND supply_state = 'zero_supply')
        OR (total_supply_atomic <> '0' AND supply_state = 'positive_supply')))
    OR
    (read_outcome <> 'success'
      AND total_supply_atomic IS NULL AND decimals IS NULL AND failure_code IS NOT NULL
      AND supply_state = 'supply_unknown')
  ),
  CONSTRAINT representation_supply_observation_time CHECK (recorded_at >= observed_at),
  CONSTRAINT representation_supply_observation_reviewed_fk
    FOREIGN KEY (chain_id, token_address)
    REFERENCES representation_underlying (chain_id, token_address) ON DELETE CASCADE,
  CONSTRAINT representation_supply_observation_once
    UNIQUE (chain_id, token_address, block_number, evidence_hash)
);

CREATE INDEX IF NOT EXISTS representation_supply_observation_recent_idx
  ON representation_supply_observation (chain_id, token_address, recorded_at DESC);

-- Latest attempted read. This is a projection over the append-only observation
-- table. A failed latest attempt intentionally projects supply_unknown while
-- the prior successful observation remains available in history.
CREATE TABLE IF NOT EXISTS representation_supply (
  chain_id            integer       NOT NULL,
  token_address       text          NOT NULL,
  supply_state        text          NOT NULL,
  total_supply_atomic text,
  decimals            integer,
  normalization       text          NOT NULL,
  block_number        text          NOT NULL,
  block_hash          text          NOT NULL,
  source              text          NOT NULL,
  evidence_hash       text          NOT NULL,
  read_outcome        text          NOT NULL,
  failure_code        text,
  observed_at         timestamptz   NOT NULL,
  last_checked_at     timestamptz   NOT NULL,
  last_changed_at     timestamptz,
  reads               bigint        NOT NULL DEFAULT 1,
  changes             bigint        NOT NULL DEFAULT 0,
  created_at          timestamptz   NOT NULL,
  CONSTRAINT representation_supply_pk PRIMARY KEY (chain_id, token_address),
  CONSTRAINT representation_supply_chain CHECK (chain_id = 8453),
  CONSTRAINT representation_supply_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT representation_supply_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT representation_supply_state CHECK (
    supply_state IN ('positive_supply', 'zero_supply', 'supply_unknown')
  ),
  CONSTRAINT representation_supply_amount CHECK (
    total_supply_atomic IS NULL OR total_supply_atomic ~ '^(0|[1-9][0-9]*)$'
  ),
  CONSTRAINT representation_supply_decimals CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 36),
  CONSTRAINT representation_supply_normalization CHECK (normalization = 'raw_erc20_total_supply'),
  CONSTRAINT representation_supply_block CHECK (
    block_number ~ '^(0|[1-9][0-9]*)$' AND block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT representation_supply_source CHECK (source = 'erc20_total_supply'),
  CONSTRAINT representation_supply_evidence CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT representation_supply_outcome CHECK (
    read_outcome IN ('success', 'rpc_failure', 'decode_failure')
  ),
  CONSTRAINT representation_supply_fact_consistent CHECK (
    (read_outcome = 'success'
      AND total_supply_atomic IS NOT NULL AND decimals IS NOT NULL AND failure_code IS NULL
      AND ((total_supply_atomic = '0' AND supply_state = 'zero_supply')
        OR (total_supply_atomic <> '0' AND supply_state = 'positive_supply')))
    OR
    (read_outcome <> 'success'
      AND total_supply_atomic IS NULL AND decimals IS NULL AND failure_code IS NOT NULL
      AND supply_state = 'supply_unknown')
  ),
  CONSTRAINT representation_supply_changes_have_time CHECK ((changes = 0) = (last_changed_at IS NULL)),
  CONSTRAINT representation_supply_changes_within_reads CHECK (changes < reads),
  CONSTRAINT representation_supply_reviewed_fk
    FOREIGN KEY (chain_id, token_address)
    REFERENCES representation_underlying (chain_id, token_address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS representation_supply_change (
  id                       bigserial     PRIMARY KEY,
  chain_id                 integer       NOT NULL,
  token_address            text          NOT NULL,
  from_total_supply_atomic text          NOT NULL,
  to_total_supply_atomic   text          NOT NULL,
  decimals                 integer       NOT NULL,
  block_number             text          NOT NULL,
  block_hash               text          NOT NULL,
  evidence_hash            text          NOT NULL,
  observed_at              timestamptz   NOT NULL,
  recorded_at              timestamptz   NOT NULL,
  CONSTRAINT representation_supply_change_chain CHECK (chain_id = 8453),
  CONSTRAINT representation_supply_change_token_lower CHECK (token_address = lower(token_address)),
  CONSTRAINT representation_supply_change_token_shape CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT representation_supply_change_moved CHECK (
    from_total_supply_atomic <> to_total_supply_atomic
  ),
  CONSTRAINT representation_supply_change_values CHECK (
    from_total_supply_atomic ~ '^(0|[1-9][0-9]*)$'
    AND to_total_supply_atomic ~ '^(0|[1-9][0-9]*)$'
    AND decimals BETWEEN 0 AND 36
  ),
  CONSTRAINT representation_supply_change_block CHECK (
    block_number ~ '^(0|[1-9][0-9]*)$' AND block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  CONSTRAINT representation_supply_change_evidence CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT representation_supply_change_time CHECK (recorded_at >= observed_at),
  CONSTRAINT representation_supply_change_reviewed_fk
    FOREIGN KEY (chain_id, token_address)
    REFERENCES representation_underlying (chain_id, token_address) ON DELETE CASCADE,
  CONSTRAINT representation_supply_change_once_per_block
    UNIQUE (chain_id, token_address, block_number)
);

CREATE INDEX IF NOT EXISTS representation_supply_change_recent_idx
  ON representation_supply_change (chain_id, recorded_at DESC);
