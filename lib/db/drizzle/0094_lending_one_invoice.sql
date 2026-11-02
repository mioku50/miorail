-- One invoice is paid once: whichever market a review of it chose (an Aave
-- stock or a Morpho asset), only one review of that invoice ever leaves
-- `ready`. The arm route reads the others first; this index is what two
-- simultaneous arms cannot both pass (2026-11-02 release audit, F1).
CREATE UNIQUE INDEX IF NOT EXISTS lending_execution_one_invoice
  ON lending_executions (tenant_id, wallet_address, (run_json->'facts'->'payment'->>'orderId'))
  WHERE state <> 'ready' AND run_json->'facts'->'payment'->>'orderId' IS NOT NULL;
