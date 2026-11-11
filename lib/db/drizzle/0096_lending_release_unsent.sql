-- An attempt its wallet never sent is released by its owner as `failed` with no
-- transaction, because there is none to name (audit LEND-1, 2026-11-10; the rule
-- is in artifacts/api-server/lib/loanRelease.ts). Every other confirmed or
-- failed attempt still names the transaction Base showed, and all of them keep
-- what was read.
ALTER TABLE lending_executions DROP CONSTRAINT IF EXISTS lending_execution_verified;
--> statement-breakpoint
ALTER TABLE lending_executions ADD CONSTRAINT lending_execution_verified CHECK (
  state NOT IN ('confirmed', 'failed')
  OR (transaction_hash IS NOT NULL AND verification_json IS NOT NULL)
  OR (state = 'failed' AND error_code = 'loan_wallet_sent_nothing' AND transaction_hash IS NULL AND verification_json IS NOT NULL)
);
