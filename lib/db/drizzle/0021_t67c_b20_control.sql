-- T67C: B20 Control Card storage. Additive only.
--
-- Two tables and no route run. A B20 inspection is not a route: nothing is
-- planned, compared, prepared or signed. It is a read of one token at one
-- block, so it hangs off nothing and joins to nothing in the swap graph.
--
-- WHAT THE SCHEMA ENFORCES, rather than merely hoping for:
--
--   * A snapshot is IMMUTABLE. There is no updated-by-write path and the
--     unique index below makes a second write for the same tenant + token +
--     block a conflict rather than an overwrite. Re-inspecting at the same
--     block returns the stored row; the chain did not change, so neither does
--     the record.
--
--   * Evidence is bound to the SNAPSHOT'S block. The composite foreign key
--     carries block_number, so a row read at a different block physically
--     cannot attach. A snapshot that spans two blocks is not a snapshot.
--
--   * There is no score column, no rating, no verdict. The absence is the
--     point: a schema with nowhere to put a number cannot grow one by
--     accident.
--
--   * There is no raw_response column. Evidence stores the HASH of the bytes,
--     so the decode stays checkable while the table stays bounded.

CREATE TABLE "b20_control_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"identity_hash" text NOT NULL,
	"detection_outcome" text NOT NULL,
	"variant" text,
	-- Null only when the read never reached a block, i.e. the endpoint failed.
	"block_number" text,
	"block_hash" text,
	"observed_at" timestamp with time zone NOT NULL,
	-- The validated snapshot document. Re-parsed on read, never trusted.
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_snapshots_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_snapshots_status_check" CHECK ("status" IN ('complete', 'partial', 'not_b20', 'failed')),
	CONSTRAINT "b20_snapshots_address_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_snapshots_hash_check" CHECK ("snapshot_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_snapshots_identity_check" CHECK ("identity_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_snapshots_block_check" CHECK (
		("block_number" IS NULL AND "block_hash" IS NULL)
		OR ("block_number" ~ '^(0|[1-9][0-9]*)$' AND "block_hash" ~ '^0x[0-9a-f]{64}$')
	),
	CONSTRAINT "b20_snapshots_variant_check" CHECK ("variant" IS NULL OR "variant" IN ('asset', 'stablecoin'))
);
--> statement-breakpoint

CREATE TABLE "b20_control_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"target" text NOT NULL,
	"block_number" text NOT NULL,
	"block_hash" text NOT NULL,
	"method_signature" text NOT NULL,
	"selector" text NOT NULL,
	"raw_response_hash" text NOT NULL,
	"decoded_value" text,
	"revert_selector" text,
	"observed_at" timestamp with time zone NOT NULL,
	"verification" text NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_evidence_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_evidence_hash_check" CHECK ("evidence_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_evidence_raw_check" CHECK ("raw_response_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_evidence_block_check" CHECK ("block_number" ~ '^(0|[1-9][0-9]*)$' AND "block_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_evidence_selector_check" CHECK ("selector" ~ '^0x[0-9a-f]{8}$'),
	CONSTRAINT "b20_evidence_revert_check" CHECK ("revert_selector" IS NULL OR "revert_selector" ~ '^0x[0-9a-f]{8}$'),
	-- The only verification this card claims. A future value would need a
	-- migration, which is the point: it cannot be widened by a code change.
	CONSTRAINT "b20_evidence_verification_check" CHECK ("verification" = 'exact_chain_read')
);
--> statement-breakpoint

-- One snapshot per tenant + token + block. A repeat inspection at the same
-- block is a READ of this row, never a second write, so a stored snapshot can
-- never be replaced by a later one carrying different values.
CREATE UNIQUE INDEX "b20_snapshots_tenant_token_block_unique"
	ON "b20_control_snapshots" ("user_id", "token_address", "block_number");--> statement-breakpoint
CREATE INDEX "b20_snapshots_tenant_token_idx"
	ON "b20_control_snapshots" ("user_id", "token_address", "observed_at" DESC);--> statement-breakpoint

-- The composite key is what binds evidence to ONE block: attaching a record
-- read at another block is a foreign-key violation, not a code-review comment.
ALTER TABLE "b20_control_snapshots"
	ADD CONSTRAINT "b20_snapshots_block_unique" UNIQUE ("id", "block_number");--> statement-breakpoint
ALTER TABLE "b20_control_evidence"
	ADD CONSTRAINT "b20_evidence_snapshot_block_fk"
	FOREIGN KEY ("snapshot_id", "block_number")
	REFERENCES "b20_control_snapshots"("id", "block_number") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "b20_evidence_snapshot_hash_unique"
	ON "b20_control_evidence" ("snapshot_id", "evidence_hash");--> statement-breakpoint
CREATE INDEX "b20_evidence_snapshot_idx" ON "b20_control_evidence" ("snapshot_id");
