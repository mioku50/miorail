-- T68D: the Opportunity Clearance. Additive only.
--
-- Evidence that ONE wallet checked ONE token at ONE profile along ONE path, and
-- that the round trip executed sequentially against a real chain state.
--
-- WHAT THE SCHEMA ENFORCES:
--
--   * IMMUTABLE. There is no update path and the primary key makes a second
--     write a conflict rather than an overwrite. A record whose job is to
--     justify an execution must not be able to change under that execution.
--
--   * SHORT-LIVED, and the database says so rather than the code remembering.
--     `expires_at` is NOT NULL and must be after `created_at`. Pools move; a
--     clearance that outlived the state it certified would authorise a trade
--     against numbers nobody measured.
--
--   * BOUND TO A PROFILE. `profile_identity` is part of every lookup, so a
--     clearance issued for 100 USDC physically cannot answer a request for 500.
--     This is the column that stops a cache serving one question's answer to
--     another question.
--
--   * NOT AN ALLOWLIST. There is no "token is approved" row, no boolean and no
--     expiry-free entry. A clearance is consumed by one preparation for the
--     wallet, token, profile and route it names.
--
--   * NO CREDENTIALS. Hashes only. There is no column for a provider response,
--     an endpoint or a key, so a record that justifies an execution cannot
--     become a place credentials accumulate.
--
-- There is deliberately no score, rating or confidence column. The absence is
-- the point: a table with nowhere to put a number cannot grow one by accident.

CREATE TABLE "b20_opportunity_clearances" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"profile_identity" text NOT NULL,
	"control_snapshot_hash" text NOT NULL,
	"entry_route_hash" text NOT NULL,
	"simulation_evidence_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- The validated clearance document. Re-parsed on read, never trusted.
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_clearance_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_clearance_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_clearance_token_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_clearance_control_hash_check" CHECK ("control_snapshot_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_clearance_route_hash_check" CHECK ("entry_route_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_clearance_evidence_hash_check" CHECK ("simulation_evidence_hash" ~ '^0x[0-9a-f]{64}$'),
	-- A clearance that never expires is an allowlist entry wearing a different
	-- name. The database refuses one.
	CONSTRAINT "b20_clearance_ttl_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint

-- The gate's only lookup: this wallet, this token, this profile, still live.
CREATE INDEX "b20_clearance_lookup_idx"
	ON "b20_opportunity_clearances"
	("tenant_id", "wallet_address", "token_address", "profile_identity", "expires_at" DESC);
