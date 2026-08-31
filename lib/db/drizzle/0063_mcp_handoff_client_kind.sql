-- Connected Apps — which assistant a handoff grant was issued to.
--
-- WHY THIS COLUMN AND NOT A NEW TABLE:
--
--   Everything else the Connected Apps surface needs already exists here. A
--   grant's life is entirely derivable from rows this table already holds:
--   `token_issued` is when it began, the newest row for the same `token_id` is
--   when it was last used, and `mcp_handoff_revocations` says whether it ended.
--   The one fact nobody recorded is WHICH client the user handed it to, and a
--   second table for a single value would put the grant's identity and the
--   grant's history in two places that could disagree.
--
-- WHY IT IS SAFE TO PUT IT HERE:
--
--   0031 states the rule this table lives by: every column is either an
--   identifier with a shape constraint or an enumerated outcome, and there is
--   no free-text column a bearer token could be written into. A CHECK over a
--   closed vocabulary keeps that true. A `text` column with no constraint
--   would not, however carefully the caller behaved today.
--
-- WHY NULL IS A REAL STATE AND NOT `other`:
--
--   Every row that already exists predates this column, and every row that is
--   not a `token_issued` row has no client to name. NULL means "not recorded".
--   `other` means "a client the user named, that is not one of the three we
--   list". Collapsing those two would turn an absence of evidence into a
--   claim, which is the one thing this schema is built to prevent.
--
-- The table is append-only (0031's trigger refuses UPDATE and DELETE), so this
-- column can only ever be set at insert. A grant's client cannot be edited
-- later, and that is correct: it is a fact about the moment of issuance.

ALTER TABLE "mcp_execution_audit"
  ADD COLUMN IF NOT EXISTS "client_kind" text;

ALTER TABLE "mcp_execution_audit"
  DROP CONSTRAINT IF EXISTS "mcp_execution_audit_client_kind_check";

ALTER TABLE "mcp_execution_audit"
  ADD CONSTRAINT "mcp_execution_audit_client_kind_check"
  CHECK ("client_kind" IS NULL OR "client_kind" IN ('claude', 'chatgpt', 'hermes', 'other'));

-- The Connected Apps list is "every grant for one wallet, newest activity
-- first". Without this it is a scan of the whole audit trail per page load.
CREATE INDEX IF NOT EXISTS "mcp_execution_audit_tenant_token_idx"
  ON "mcp_execution_audit" ("tenant_id", "token_id", "created_at" DESC);
