-- What the metered RPC has cost this month, durably.
--
-- Alchemy meters COMPUTE UNITS, not calls, and the plan is 300M a month. The
-- budget already in this repository counts calls, which is the wrong unit by a
-- factor that varies per method — an `eth_call` is 26 CU and an `eth_getLogs`
-- is 75 — so a call budget either overspends or throttles for nothing.
--
-- It is a TABLE and not a counter in memory because a process that forgets its
-- spend on restart is not within budget, it is unaware, and the two must not
-- look the same. One row per month per provider; the month is the window a
-- monthly plan actually resets on.
CREATE TABLE IF NOT EXISTS rpc_cu_ledger (
  month text NOT NULL,
  provider text NOT NULL,
  spent_cu bigint NOT NULL DEFAULT 0,
  call_count bigint NOT NULL DEFAULT 0,
  first_spend_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rpc_cu_ledger_pk PRIMARY KEY (month, provider),
  CONSTRAINT rpc_cu_ledger_month CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT rpc_cu_ledger_provider CHECK (provider = ANY (ARRAY['alchemy'::text, 'fallback'::text])),
  -- Spend only ever goes up within a month. A decrement would be a correction
  -- nobody can audit, and the fallback exists precisely so nothing has to be.
  CONSTRAINT rpc_cu_ledger_non_negative CHECK (spent_cu >= 0 AND call_count >= 0)
);
