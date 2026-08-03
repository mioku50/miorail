-- T69-A: durable B20 launch ingestion. Additive only.
--
-- Three tables, because they are three different kinds of claim:
--
--   * `b20_launches` is IMMUTABLE CHAIN EVIDENCE. A trigger below refuses any
--     UPDATE that touches a chain field. Not a convention — an application
--     that "fixed" a name or a decimals value after the fact would silently
--     rewrite the record every downstream measurement was anchored to.
--
--   * `b20_discover_cursors` is a claim about how far reading got. It also
--     carries the worker lease, so "how far" and "who may move it" are one row
--     and one lock rather than two things that can disagree.
--
--   * `b20_discover_runs` is what happened, INCLUDING failures. An endpoint
--     that stopped answering must never be indistinguishable from a stretch of
--     chain with no launches in it.
--
-- WHAT THE SCHEMA ENFORCES, AND WHY EACH ONE IS HERE:
--
--   * A FAILED RUN CANNOT HAVE MOVED THE CURSOR OR STORED A LAUNCH. This is
--     the constraint the whole feature rests on. Nothing re-reads an old
--     range, so a cursor that advanced past blocks nobody read produces a gap
--     that is permanent AND invisible — a missing launch looks exactly like a
--     quiet hour.
--
--   * ONE LOG IS ONE LAUNCH. Identity is (chain_id, transaction_hash,
--     log_index), never the token address: one token can be launched by more
--     than one event, and two events are two facts.
--
--   * THE CURSOR HASH BELONGS TO THE CURSOR BLOCK. Enforced by the writer,
--     which reads the hash of exactly that block; the column exists so the
--     reorg check has something to compare against at all.
--
--   * A LEASE IS WHOLE OR ABSENT. An owner without an expiry is a lock nobody
--     can ever break.
--
--   * NO CREDENTIALS. There is no column here for a URL, a header, an API key
--     or a raw provider response. `error_category` is a short code, because
--     provider messages carry endpoints and endpoints carry keys.

CREATE TABLE "b20_launches" (
	-- `${transaction_hash}:${log_index}` — derived, so a retry writes the same
	-- row rather than a second one.
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"factory_address" text NOT NULL,
	"token_address" text NOT NULL,
	"variant" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	-- Nullable on purpose. A token whose event carried no readable decimals is
	-- recorded as unknown; defaulting to 18 would misprice every amount.
	"decimals" integer,
	"block_number" numeric(78, 0) NOT NULL,
	"block_hash" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"transaction_index" integer,
	"log_index" integer NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	-- How far behind the head it was when ingested, so a shallow read is
	-- visible after the fact rather than inferred from a deploy date.
	"confirmation_count" integer NOT NULL,
	"decoder_version" text NOT NULL,
	-- False once a reorg removed the block underneath it. The row is KEPT:
	-- "we saw this and the chain took it back" is itself a fact.
	"canonical" boolean DEFAULT true NOT NULL,
	"non_canonical_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_launches_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_launches_factory_check" CHECK ("factory_address" = '0xb20f000000000000000000000000000000000000'),
	CONSTRAINT "b20_launches_token_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "b20_launches_variant_check" CHECK ("variant" IN ('asset', 'stablecoin')),
	CONSTRAINT "b20_launches_decimals_check" CHECK ("decimals" IS NULL OR ("decimals" >= 0 AND "decimals" <= 255)),
	CONSTRAINT "b20_launches_block_number_check" CHECK ("block_number" >= 0),
	CONSTRAINT "b20_launches_block_hash_check" CHECK ("block_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_launches_transaction_hash_check" CHECK ("transaction_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_launches_transaction_index_check" CHECK ("transaction_index" IS NULL OR "transaction_index" >= 0),
	CONSTRAINT "b20_launches_log_index_check" CHECK ("log_index" >= 0),
	CONSTRAINT "b20_launches_confirmations_check" CHECK ("confirmation_count" >= 0),
	-- Only decoders this build knows how to read. A row written by a decoder
	-- nobody has heard of is not evidence.
	CONSTRAINT "b20_launches_decoder_check" CHECK ("decoder_version" IN ('b20-created/v1')),
	CONSTRAINT "b20_launches_id_check" CHECK ("id" = "transaction_hash" || ':' || "log_index"::text),
	CONSTRAINT "b20_launches_canonical_check" CHECK (("canonical") = ("non_canonical_at" IS NULL))
);
--> statement-breakpoint
-- One log is one launch. NOT the token address: one token can be launched by
-- more than one event, and two events are two facts.
CREATE UNIQUE INDEX "b20_launches_identity_unique" ON "b20_launches" ("chain_id", "transaction_hash", "log_index");
--> statement-breakpoint
CREATE INDEX "b20_launches_block_idx" ON "b20_launches" ("chain_id", "factory_address", "block_number");
--> statement-breakpoint
CREATE INDEX "b20_launches_token_idx" ON "b20_launches" ("chain_id", "token_address");
--> statement-breakpoint

-- Chain evidence does not get edited. The only fields that may move are
-- whether the chain still contains the block, and when we noticed it did not.
CREATE OR REPLACE FUNCTION "b20_launches_immutable_identity"() RETURNS trigger AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."chain_id" IS DISTINCT FROM OLD."chain_id"
		OR NEW."factory_address" IS DISTINCT FROM OLD."factory_address"
		OR NEW."token_address" IS DISTINCT FROM OLD."token_address"
		OR NEW."variant" IS DISTINCT FROM OLD."variant"
		OR NEW."name" IS DISTINCT FROM OLD."name"
		OR NEW."symbol" IS DISTINCT FROM OLD."symbol"
		OR NEW."decimals" IS DISTINCT FROM OLD."decimals"
		OR NEW."block_number" IS DISTINCT FROM OLD."block_number"
		OR NEW."block_hash" IS DISTINCT FROM OLD."block_hash"
		OR NEW."transaction_hash" IS DISTINCT FROM OLD."transaction_hash"
		OR NEW."transaction_index" IS DISTINCT FROM OLD."transaction_index"
		OR NEW."log_index" IS DISTINCT FROM OLD."log_index"
		OR NEW."detected_at" IS DISTINCT FROM OLD."detected_at"
		OR NEW."confirmation_count" IS DISTINCT FROM OLD."confirmation_count"
		OR NEW."decoder_version" IS DISTINCT FROM OLD."decoder_version"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'b20_launches rows are immutable chain evidence; only canonical/non_canonical_at may change';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "b20_launches_immutable_identity_trigger"
	BEFORE UPDATE ON "b20_launches"
	FOR EACH ROW EXECUTE FUNCTION "b20_launches_immutable_identity"();
--> statement-breakpoint

CREATE TABLE "b20_discover_cursors" (
	-- `${chain_id}:${factory_address}:${decoder_version}` — derived, so the
	-- lane cannot be created twice under two ids.
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"factory_address" text NOT NULL,
	-- A different decoder reads a different feed, so it gets its own cursor
	-- rather than inheriting one built by another.
	"decoder_version" text NOT NULL,
	"last_processed_block" numeric(78, 0) NOT NULL,
	-- The hash OF `last_processed_block`. Null only on a cold cursor, which is
	-- why a missing hash is not treated as a reorg.
	"last_processed_block_hash" text,
	"operator_state" text,
	"last_run_id" text,
	-- The lease. One row, so "how far" and "who may move it" cannot disagree.
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_discover_cursors_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_discover_cursors_factory_check" CHECK ("factory_address" = '0xb20f000000000000000000000000000000000000'),
	CONSTRAINT "b20_discover_cursors_decoder_check" CHECK ("decoder_version" IN ('b20-created/v1')),
	CONSTRAINT "b20_discover_cursors_block_check" CHECK ("last_processed_block" >= 0),
	CONSTRAINT "b20_discover_cursors_hash_check" CHECK ("last_processed_block_hash" IS NULL OR "last_processed_block_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_discover_cursors_operator_state_check" CHECK ("operator_state" IS NULL OR "operator_state" IN ('decoder_mismatch', 'endpoint_unavailable', 'storage_unavailable', 'reorg_rewound')),
	-- An owner without an expiry is a lock nobody can ever break.
	CONSTRAINT "b20_discover_cursors_lease_check" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
	CONSTRAINT "b20_discover_cursors_id_check" CHECK ("id" = "chain_id"::text || ':' || "factory_address" || ':' || "decoder_version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "b20_discover_cursors_lane_unique" ON "b20_discover_cursors" ("chain_id", "factory_address", "decoder_version");
--> statement-breakpoint

CREATE TABLE "b20_discover_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"factory_address" text NOT NULL,
	"decoder_version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"start_cursor_block" numeric(78, 0) NOT NULL,
	"end_cursor_block" numeric(78, 0) NOT NULL,
	"confirmed_head" numeric(78, 0),
	-- Null when no range was requested at all — which is different from a
	-- range that was requested and came back empty.
	"scanned_from_block" numeric(78, 0),
	"scanned_to_block" numeric(78, 0),
	"launches_read" integer DEFAULT 0 NOT NULL,
	"launches_inserted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"budget_exhausted" boolean DEFAULT false NOT NULL,
	"operator_state" text,
	-- A CATEGORY. Never a provider message: provider messages carry endpoints,
	-- and endpoints carry keys.
	"error_category" text,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b20_discover_runs_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_discover_runs_factory_check" CHECK ("factory_address" = '0xb20f000000000000000000000000000000000000'),
	CONSTRAINT "b20_discover_runs_decoder_check" CHECK ("decoder_version" IN ('b20-created/v1')),
	CONSTRAINT "b20_discover_runs_result_check" CHECK ("result" IN ('success', 'nothing_confirmed', 'budget_exhausted', 'endpoint_unavailable', 'decoder_mismatch', 'reorg_rewound', 'configuration_required', 'storage_unavailable', 'run_already_active')),
	CONSTRAINT "b20_discover_runs_operator_state_check" CHECK ("operator_state" IS NULL OR "operator_state" IN ('decoder_mismatch', 'endpoint_unavailable', 'storage_unavailable', 'reorg_rewound')),
	CONSTRAINT "b20_discover_runs_error_category_check" CHECK ("error_category" IS NULL OR "error_category" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "b20_discover_runs_counts_check" CHECK ("launches_read" >= 0 AND "launches_inserted" >= 0 AND "duplicates" >= 0 AND "launches_inserted" <= "launches_read"),
	CONSTRAINT "b20_discover_runs_clock_check" CHECK ("finished_at" >= "started_at"),
	CONSTRAINT "b20_discover_runs_blocks_check" CHECK ("start_cursor_block" >= 0 AND "end_cursor_block" >= 0),
	-- Only a reorg rewind moves a cursor backwards.
	CONSTRAINT "b20_discover_runs_monotonic_check" CHECK ("end_cursor_block" >= "start_cursor_block" OR "result" = 'reorg_rewound'),
	-- THE ONE THAT MATTERS. A failed endpoint run is not a successful
	-- zero-launch run, and it may not have moved the cursor past blocks it
	-- never read.
	CONSTRAINT "b20_discover_runs_inert_check" CHECK (
		"result" NOT IN ('endpoint_unavailable', 'decoder_mismatch', 'configuration_required', 'storage_unavailable', 'run_already_active')
		OR ("launches_inserted" = 0 AND "end_cursor_block" = "start_cursor_block")
	)
);
--> statement-breakpoint
CREATE INDEX "b20_discover_runs_lane_idx" ON "b20_discover_runs" ("chain_id", "factory_address", "decoder_version", "started_at" DESC);
