-- Durable browser sessions and standards-based MCP OAuth grants.
--
-- Browser sessions used to live in express-session's MemoryStore. A process
-- restart therefore invalidated every SIWE login even though the cookie was
-- still present. The session identifier is opaque; the signed cookie remains
-- the browser-side proof, while this table makes the server-side state survive
-- deployments.

CREATE TABLE IF NOT EXISTS "web_sessions" (
  "sid" text PRIMARY KEY NOT NULL,
  "session" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "web_sessions_expires_idx"
  ON "web_sessions" ("expires_at");

-- A legacy handoff token already contains its expiry, but Connected Apps used
-- to discard it and could therefore not distinguish usable from lapsed. Only
-- issuance rows may carry this fact; historical rows remain NULL rather than
-- receiving a guessed expiry.
ALTER TABLE "mcp_execution_audit"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

ALTER TABLE "mcp_execution_audit"
  DROP CONSTRAINT IF EXISTS "mcp_execution_audit_expiry_check";

ALTER TABLE "mcp_execution_audit"
  ADD CONSTRAINT "mcp_execution_audit_expiry_check" CHECK (
    "expires_at" IS NULL OR "outcome" = 'token_issued'
  );

CREATE INDEX IF NOT EXISTS "mcp_execution_audit_tenant_expiry_idx"
  ON "mcp_execution_audit" ("tenant_id", "expires_at")
  WHERE "outcome" = 'token_issued';

-- OAuth clients are registered through RFC 7591. Metadata is encrypted by the
-- application because confidential-client metadata may include a secret.
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "encrypted_metadata" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One durable, tenant-scoped grant. Access and refresh credentials below are
-- replaceable proof for this grant; revocation ends the grant and therefore
-- every credential derived from it.
CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "client_id" text NOT NULL,
  "client_name" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "resource" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "use_count" integer DEFAULT 0 NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "mcp_oauth_grants_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_grants_client_fk" FOREIGN KEY ("client_id")
    REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_grants_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "mcp_oauth_grants_tenant_wallet_check" CHECK (
    "tenant_id" = 'eip155:8453:' || "wallet_address"
  ),
  CONSTRAINT "mcp_oauth_grants_scopes_check" CHECK (
    jsonb_typeof("scopes") = 'array' AND jsonb_array_length("scopes") > 0
  ),
  CONSTRAINT "mcp_oauth_grants_resource_check" CHECK ("resource" ~ '^https://[^ ]+/mcp/private$'),
  CONSTRAINT "mcp_oauth_grants_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "mcp_oauth_grants_use_count_check" CHECK ("use_count" >= 0),
  CONSTRAINT "mcp_oauth_grants_revoke_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_tenant_idx"
  ON "mcp_oauth_grants" ("tenant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "mcp_oauth_authorization_codes" (
  "code_hash" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "wallet_address" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "resource" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_oauth_codes_client_fk" FOREIGN KEY ("client_id")
    REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_codes_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_codes_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "mcp_oauth_codes_tenant_wallet_check" CHECK (
    "tenant_id" = 'eip155:8453:' || "wallet_address"
  ),
  CONSTRAINT "mcp_oauth_codes_hash_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mcp_oauth_codes_challenge_check" CHECK (length("code_challenge") BETWEEN 43 AND 128),
  CONSTRAINT "mcp_oauth_codes_scopes_check" CHECK (
    jsonb_typeof("scopes") = 'array' AND jsonb_array_length("scopes") > 0
  ),
  CONSTRAINT "mcp_oauth_codes_resource_check" CHECK ("resource" ~ '^https://[^ ]+/mcp/private$'),
  CONSTRAINT "mcp_oauth_codes_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "mcp_oauth_codes_consumed_check" CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at")
);

CREATE INDEX IF NOT EXISTS "mcp_oauth_codes_expires_idx"
  ON "mcp_oauth_authorization_codes" ("expires_at");

CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "token_id" text UNIQUE NOT NULL,
  "grant_id" text NOT NULL,
  "client_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "mcp_oauth_tokens_grant_fk" FOREIGN KEY ("grant_id")
    REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_tokens_client_fk" FOREIGN KEY ("client_id")
    REFERENCES "public"."mcp_oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "mcp_oauth_tokens_kind_check" CHECK ("kind" IN ('access', 'refresh')),
  CONSTRAINT "mcp_oauth_tokens_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mcp_oauth_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "mcp_oauth_tokens_revoke_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_grant_idx"
  ON "mcp_oauth_tokens" ("grant_id", "kind", "expires_at" DESC);

CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_expires_idx"
  ON "mcp_oauth_tokens" ("expires_at");
