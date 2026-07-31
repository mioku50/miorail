-- T67C.1: verified route outcomes and provider reliability snapshots.
-- Additive only. Nothing here changes an existing Route Proof, Route Card or
-- score snapshot.
--
-- What these tables are: a derived, reproducible statistic about how a provider
-- has actually executed, fed back into the next ranking.
--
-- What they are NOT: financial truth. RouteProof, its receipts and its
-- append-only event chain remain the record of what happened onchain. An
-- outcome row is a READING of a proof that already exists, and the schema is
-- written so it cannot become anything more:
--
--   * There is no calldata column, no provider response body, no API key, and
--     nothing a client ever sent. Every value is derived server-side from a
--     proof and its persisted candidate.
--   * One proof produces at most one outcome — enforced twice, on proof_id and
--     on proof_hash. A second row for the same proof would double-count one
--     trade; a row whose proof_hash disagrees with an existing one would mean
--     the proof changed after it was final, which must fail rather than
--     overwrite.
--   * An outcome is immutable. There is no update path: a correction is a new
--     derivation of a new proof, never an edit of a recorded fact.
--
-- Snapshots are immutable too, and carry their own membership. Without the
-- membership table a snapshot would be an unfalsifiable claim — "trust these
-- numbers" — and the whole point is that anyone can recompute them.

CREATE TABLE "route_provider_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	-- Both pinned. proof_id says WHICH proof; proof_hash says which VERSION of
	-- it, so a proof edited after finalization cannot silently re-derive.
	"proof_id" text NOT NULL,
	"proof_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	-- CAIP-style asset ids, never symbols: two tokens can share a symbol and the
	-- statistic must be about one pair.
	"from_asset" text NOT NULL,
	"to_asset" text NOT NULL,
	"expected_output_atomic" numeric(78, 0) NOT NULL,
	"minimum_output_atomic" numeric(78, 0) NOT NULL,
	-- Null for a verified revert: nothing arrived, so there is no amount. Zero
	-- would be a measurement nobody took.
	"actual_output_atomic" numeric(78, 0),
	"estimated_gas_atomic" numeric(78, 0),
	"actual_gas_atomic" numeric(78, 0),
	-- Signed: positive means the provider delivered more than it quoted.
	"quote_deviation_bps" integer,
	-- Never negative. Overdelivery is not a credit against a later shortfall.
	"adverse_shortfall_bps" integer,
	"floor_breached" boolean,
	"confirmation_ms" integer,
	"proof_final_status" text NOT NULL,
	"receipt_verification" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"derived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"derivation_version" text NOT NULL,
	"outcome_hash" text NOT NULL,
	CONSTRAINT "route_provider_outcomes_chain_check" CHECK ("chain_id" = 8453),
	-- Lowercase in the column, not merely by convention: a mixed-case duplicate
	-- would defeat every wallet-scoped personal aggregation.
	CONSTRAINT "route_provider_outcomes_wallet_check" CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "route_provider_outcomes_proof_hash_check" CHECK ("proof_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "route_provider_outcomes_hash_check" CHECK ("outcome_hash" ~ '^0x[0-9a-f]{64}$'),
	-- V1 scope: swap providers only. Earn, NFT, Commerce and Private AI outcomes
	-- are not comparable to quoted-versus-delivered output.
	CONSTRAINT "route_provider_outcomes_provider_check" CHECK ("provider_id" IN ('uniswap', 'kyberswap', 'aerodrome')),
	-- cancelled, pending, submitted_unknown and reconciliation_required are
	-- absent BY CONSTRUCTION. A user who changed their mind said nothing about
	-- the provider, and an unresolved receipt is not an answer.
	CONSTRAINT "route_provider_outcomes_status_check" CHECK ("proof_final_status" IN ('completed', 'partial_failure', 'failed')),
	CONSTRAINT "route_provider_outcomes_verification_check" CHECK ("receipt_verification" IN ('verified_success', 'verified_reverted', 'verified_mixed')),
	CONSTRAINT "route_provider_outcomes_pair_check" CHECK ("from_asset" <> "to_asset"),
	CONSTRAINT "route_provider_outcomes_expected_check" CHECK ("expected_output_atomic" > 0),
	CONSTRAINT "route_provider_outcomes_floor_check" CHECK ("minimum_output_atomic" <= "expected_output_atomic"),
	CONSTRAINT "route_provider_outcomes_shortfall_check" CHECK ("adverse_shortfall_bps" IS NULL OR "adverse_shortfall_bps" >= 0),
	-- A verified revert carries no delivered amount, no shortfall and no floor
	-- verdict; anything else carries all three.
	CONSTRAINT "route_provider_outcomes_delivery_check" CHECK (
		("proof_final_status" = 'failed'
			AND "actual_output_atomic" IS NULL
			AND "adverse_shortfall_bps" IS NULL
			AND "floor_breached" IS NULL)
		OR ("proof_final_status" <> 'failed'
			AND "actual_output_atomic" IS NOT NULL
			AND "adverse_shortfall_bps" IS NOT NULL
			AND "floor_breached" IS NOT NULL)
	)
);
--> statement-breakpoint

-- One proof, one outcome. Two rows would count one trade twice, and the trade
-- count is the denominator of every rate above it.
CREATE UNIQUE INDEX "route_provider_outcomes_proof_unique"
	ON "route_provider_outcomes" ("proof_id");--> statement-breakpoint
-- And one proof VERSION, one outcome. If a proof were ever re-finalized with
-- different content, this refuses the second derivation instead of quietly
-- accumulating a contradictory history.
CREATE UNIQUE INDEX "route_provider_outcomes_proof_hash_unique"
	ON "route_provider_outcomes" ("proof_hash");--> statement-breakpoint

-- The network aggregation key.
CREATE INDEX "route_provider_outcomes_network_idx"
	ON "route_provider_outcomes" ("provider_id", "from_asset", "to_asset", "occurred_at" DESC);--> statement-breakpoint
-- The personal aggregation key. Leading with user_id keeps one tenant's window
-- scan off every other tenant's rows.
CREATE INDEX "route_provider_outcomes_personal_idx"
	ON "route_provider_outcomes" ("user_id", "wallet_address", "provider_id", "from_asset", "to_asset", "occurred_at" DESC);--> statement-breakpoint
-- Backfill sweeps by time.
CREATE INDEX "route_provider_outcomes_occurred_idx"
	ON "route_provider_outcomes" ("occurred_at" DESC);--> statement-breakpoint

CREATE TABLE "provider_reliability_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	-- Personal only. A network snapshot belongs to no tenant, which is exactly
	-- what makes its statistics shareable without naming whose trades produced
	-- them.
	"user_id" text,
	"wallet_address" text,
	"provider_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"from_asset" text NOT NULL,
	"to_asset" text NOT NULL,
	"window_days" integer NOT NULL,
	-- Members are bounded at or before this instant. A snapshot can therefore
	-- never contain the result of the trade it was used to choose.
	"cutoff_at" timestamp with time zone NOT NULL,
	"sample_size" integer NOT NULL,
	"unique_wallet_count" integer NOT NULL,
	"completed_count" integer NOT NULL,
	"failed_count" integer NOT NULL,
	"partial_failure_count" integer NOT NULL,
	"success_rate_bps" integer NOT NULL,
	"median_adverse_shortfall_bps" integer NOT NULL,
	"p90_adverse_shortfall_bps" integer NOT NULL,
	"floor_breach_rate_bps" integer NOT NULL,
	"median_gas_error_bps" integer,
	"p90_confirmation_ms" integer,
	"outcome_set_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"aggregation_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_reliability_snapshots_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "provider_reliability_snapshots_scope_check" CHECK ("scope" IN ('personal', 'network')),
	CONSTRAINT "provider_reliability_snapshots_provider_check" CHECK ("provider_id" IN ('uniswap', 'kyberswap', 'aerodrome')),
	CONSTRAINT "provider_reliability_snapshots_wallet_check" CHECK ("wallet_address" IS NULL OR "wallet_address" ~ '^0x[0-9a-f]{40}$'),
	-- A personal snapshot is bound to a tenant and wallet; a network snapshot to
	-- neither. Half-bound would leak a tenant into a shared statistic.
	CONSTRAINT "provider_reliability_snapshots_binding_check" CHECK (
		("scope" = 'personal' AND "user_id" IS NOT NULL AND "wallet_address" IS NOT NULL)
		OR ("scope" = 'network' AND "user_id" IS NULL AND "wallet_address" IS NULL)
	),
	-- A snapshot over no outcomes states nothing and must not exist: an empty
	-- row would still be picked up by a query and read as history.
	CONSTRAINT "provider_reliability_snapshots_sample_check" CHECK ("sample_size" > 0),
	CONSTRAINT "provider_reliability_snapshots_counts_check" CHECK (
		"completed_count" + "failed_count" + "partial_failure_count" = "sample_size"
	),
	CONSTRAINT "provider_reliability_snapshots_wallets_check" CHECK (
		"unique_wallet_count" > 0 AND "unique_wallet_count" <= "sample_size"
	),
	CONSTRAINT "provider_reliability_snapshots_rates_check" CHECK (
		"success_rate_bps" BETWEEN 0 AND 10000
		AND "floor_breach_rate_bps" BETWEEN 0 AND 10000
	),
	CONSTRAINT "provider_reliability_snapshots_quantile_check" CHECK (
		"median_adverse_shortfall_bps" >= 0
		AND "p90_adverse_shortfall_bps" >= "median_adverse_shortfall_bps"
	),
	CONSTRAINT "provider_reliability_snapshots_hash_check" CHECK (
		"snapshot_hash" ~ '^0x[0-9a-f]{64}$' AND "outcome_set_hash" ~ '^0x[0-9a-f]{64}$'
	)
);
--> statement-breakpoint

-- Identical content rebuilds to the identical id, so re-running the rebuild
-- inserts nothing rather than accumulating duplicate snapshots of one moment.
CREATE UNIQUE INDEX "provider_reliability_snapshots_hash_unique"
	ON "provider_reliability_snapshots" ("snapshot_hash");--> statement-breakpoint
-- The read path: newest eligible snapshot for a scope, provider and pair.
CREATE INDEX "provider_reliability_snapshots_lookup_idx"
	ON "provider_reliability_snapshots" ("scope", "provider_id", "from_asset", "to_asset", "cutoff_at" DESC);--> statement-breakpoint
CREATE INDEX "provider_reliability_snapshots_personal_idx"
	ON "provider_reliability_snapshots" ("user_id", "wallet_address", "provider_id", "from_asset", "to_asset", "cutoff_at" DESC);--> statement-breakpoint

-- Membership. This table is what makes a snapshot falsifiable: recompute the
-- set hash from these rows and either it matches or the snapshot is not about
-- the outcomes it claims.
CREATE TABLE "provider_reliability_snapshot_members" (
	"snapshot_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "provider_reliability_snapshot_members_pk" PRIMARY KEY ("snapshot_id", "outcome_id"),
	CONSTRAINT "provider_reliability_snapshot_members_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint

-- The order is part of the claim: the set hash is over the ordered member
-- hashes, so two members cannot share a position.
CREATE UNIQUE INDEX "provider_reliability_snapshot_members_ordinal_unique"
	ON "provider_reliability_snapshot_members" ("snapshot_id", "ordinal");--> statement-breakpoint
CREATE INDEX "provider_reliability_snapshot_members_outcome_idx"
	ON "provider_reliability_snapshot_members" ("outcome_id");
