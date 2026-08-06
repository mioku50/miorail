-- T72-C §1/§2 — the audit trail for the authenticated MCP execution surface.
--
-- WHY A TABLE AND NOT A LOG LINE:
--
--   T72-B recorded these as structured logs. That is fine for observability
--   and useless for the question this table exists to answer: "an assistant
--   was holding a credential for this wallet — what did it actually do with
--   it?". A log stream rotates, is not queryable per tenant, and cannot be
--   made a PRECONDITION of an action. This table can, and §2 requires exactly
--   that: releasing executable calls fails closed if the audit write fails.
--
-- WHAT THIS TABLE MUST NEVER HOLD (§1):
--
--   * The bearer handoff token. Only its `token_id` — an opaque uuid minted
--     alongside it, which identifies a session without being usable as one.
--     There is no column a token could be written to, which is a stronger
--     guarantee than a rule about not writing it.
--   * Calldata. `calls_hash` is a 32-byte digest and is not reversible into a
--     transaction. The bytes live in b20_entry_plans, where they are already
--     governed.
--   * SESSION_SECRET, RPC URLs, API keys, or any raw provider or wallet body.
--     There is no free-text column at all: every column is either an
--     identifier with a shape constraint or an enumerated outcome.
--
-- WHY `outcome` IS A CHECK AND NOT AN ENUM TYPE:
--
--   The rest of this schema uses CHECK constraints for closed vocabularies
--   (see 0027's terminal outcomes). A Postgres ENUM would need its own
--   migration to extend and would diverge from how every neighbouring table
--   expresses the same idea.
--
-- APPEND-ONLY:
--
--   No UPDATE and no DELETE. An audit row that can be rewritten is not an
--   audit row, so the trigger below refuses both. A wrong row is corrected by
--   appending, the same way the rest of Miorail's evidence works.

CREATE TABLE "mcp_execution_audit" (
	"id" text PRIMARY KEY NOT NULL,
	-- The handoff token's opaque identifier, or 'session' when the caller used
	-- a browser cookie instead. NEVER the token.
	"token_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"tool_name" text NOT NULL,
	-- Null for calls that never reached a plan (a refused authentication, a
	-- qualification that produced nothing).
	"plan_id" text,
	"calls_hash" text,
	-- Base MCP's request/batch id, when the client reported one.
	"batch_id" text,
	"outcome" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- §1 — the closed outcome vocabulary. `refused` is deliberately last and
-- deliberately generic: the REASON belongs in the response the caller got, not
-- in a column that would become a free-text field by degrees.
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_outcome" CHECK (
  "outcome" IN (
    'token_issued',
    'plan_read',
    'action_released',
    'submission_recorded',
    'user_rejected',
    'submitted_unknown',
    'entry_succeeded',
    'entry_reverted',
    'reconciliation_required',
    'refused'
  )
);
--> statement-breakpoint

-- Shape constraints, so a column cannot quietly become a place to put
-- something else. A calls hash is 32 bytes and nothing longer fits.
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_wallet_shape" CHECK (
  "wallet_address" ~ '^0x[0-9a-f]{40}$'
);
--> statement-breakpoint
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_calls_hash_shape" CHECK (
  "calls_hash" IS NULL OR "calls_hash" ~ '^0x[0-9a-f]{64}$'
);
--> statement-breakpoint

-- A bearer token is long. These bounds are not about storage — they are the
-- reason a credential cannot be smuggled into an identifier column.
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_token_id_bounded" CHECK (
  length("token_id") BETWEEN 1 AND 100
);
--> statement-breakpoint
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_batch_id_bounded" CHECK (
  "batch_id" IS NULL OR length("batch_id") BETWEEN 1 AND 200
);
--> statement-breakpoint
ALTER TABLE "mcp_execution_audit" ADD CONSTRAINT "mcp_execution_audit_tool_bounded" CHECK (
  length("tool_name") BETWEEN 1 AND 80
);
--> statement-breakpoint

-- The two queries this table exists to serve: "what has this wallet's
-- assistant been doing" and "who touched this plan".
CREATE INDEX "mcp_execution_audit_tenant_idx"
  ON "mcp_execution_audit" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "mcp_execution_audit_plan_idx"
  ON "mcp_execution_audit" ("plan_id", "created_at" DESC)
  WHERE "plan_id" IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "mcp_execution_audit_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mcp_execution_audit is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "mcp_execution_audit_no_rewrite" ON "mcp_execution_audit";
--> statement-breakpoint
CREATE TRIGGER "mcp_execution_audit_no_rewrite"
  BEFORE UPDATE OR DELETE ON "mcp_execution_audit"
  FOR EACH ROW EXECUTE FUNCTION "mcp_execution_audit_append_only"();
--> statement-breakpoint

-- T72-C §3 — early revocation of a handoff token.
--
-- Handoff tokens are stateless and short-lived, so the ONLY thing a user can
-- otherwise do about a leaked one is wait. This table is the escape hatch: a
-- token id listed here is refused on its next use, before its claims are read.
--
-- It stores no bearer token, by construction: there is no column for one. A
-- revocation is (token_id, tenant_id) and a time, and the tenant is part of
-- the key so one wallet cannot revoke another's session.
--
-- Rows are NOT cleaned up on expiry by this migration. A revocation that
-- outlives its token is harmless — the token is refused for being expired
-- anyway — and keeping it is the record that somebody revoked something.

CREATE TABLE "mcp_handoff_revocations" (
	"token_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"revoked_at" timestamptz NOT NULL DEFAULT now(),
	-- The token's own expiry, carried over so an operator can prune safely
	-- without having to decode anything.
	"expires_at" timestamptz NOT NULL,
	PRIMARY KEY ("token_id", "tenant_id")
);
--> statement-breakpoint

ALTER TABLE "mcp_handoff_revocations" ADD CONSTRAINT "mcp_handoff_revocations_token_bounded" CHECK (
  length("token_id") BETWEEN 1 AND 100
);
--> statement-breakpoint

CREATE INDEX "mcp_handoff_revocations_expiry_idx"
  ON "mcp_handoff_revocations" ("expires_at");
