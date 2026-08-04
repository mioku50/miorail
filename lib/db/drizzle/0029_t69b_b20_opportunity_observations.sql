-- T69-B: immutable public Exit-First observations over stored B20 launches.
-- Additive only.
--
-- An observation is A MEASUREMENT AT A NAMED BLOCK AND TIME — not a status.
-- When the pool moves or a control changes, that is a NEW observation; the old
-- one stays exactly as it was written. Overwriting would destroy the only
-- record of what was true when somebody looked, and every number here is the
-- kind a person acts on.
--
-- WHAT THE SCHEMA ENFORCES, AND WHY EACH ONE IS HERE:
--
--   * THERE IS NO `qualified` STATE. The CHECK below permits exactly
--     candidate/provisional/rejected/unmeasured. This worker has no wallet, so
--     it can never observe a sequential entry-and-exit execution — and
--     `qualified` is the one word in this product that claims one happened.
--     A background job must not be able to write it even by accident.
--
--   * A PASS IS ALWAYS `quoted_pre_entry`. The exit leg is quoted against the
--     pool BEFORE the entry moves it, which flatters the round trip — worst on
--     exactly the thin pools where it matters most. The reason column records
--     that on every provisional row, so a future card cannot lose it.
--
--   * A REJECTION NEEDS A TYPED REASON. `reason_code` is NOT NULL for rejected
--     and unmeasured rows. "Rejected" with no reason is an accusation with no
--     evidence, published about somebody's token, unattended.
--
--   * ONE OBSERVATION PER (launch, block, version, profile). The unique index
--     is what makes a retry free: identical evidence finds the existing row
--     instead of writing a second one that says the same thing.
--
--   * IMMUTABILITY IS A TRIGGER, NOT A CONVENTION. Same reasoning as
--     `b20_launches` in 0028.
--
--   * NO CREDENTIALS. No column here holds a URL, a header, a key or a raw
--     provider response. Hashes and typed public facts only.

CREATE TABLE "b20_opportunity_observations" (
	-- Derived from the identity columns, so a retry computes the same id.
	"id" text PRIMARY KEY NOT NULL,
	"launch_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,

	-- The feed's reference profile. NOT a user qualification: these are the
	-- measurement parameters, and a result for 100 USDC says nothing about 500.
	"reference_quote_asset" text NOT NULL,
	"reference_position_atomic" numeric(78, 0) NOT NULL,
	"max_round_trip_bps" integer NOT NULL,
	"max_exit_slippage_bps" integer NOT NULL,
	"profile_identity" text NOT NULL,

	"state" text NOT NULL,
	"reason_code" text,

	"factory_confirmed" boolean NOT NULL,
	"initialized" boolean NOT NULL,
	"entry_route_found" boolean NOT NULL,
	"exit_route_found" boolean NOT NULL,
	"entry_route_hash" text,
	"exit_route_hash" text,
	"entry_source_key" text,
	"exit_source_key" text,

	-- The optimistic round trip. Null whenever it could not be measured — never
	-- zero, because "no quote" and "free" are different answers.
	"entry_output_atomic" numeric(78, 0),
	"optimistic_exit_return_atomic" numeric(78, 0),
	"optimistic_round_trip_bps" integer,

	-- Capacity: measured boundaries only. `largest_passing` is the largest size
	-- ACTUALLY PROBED that came in under tolerance, and `first_failing` is what
	-- bounds it from above — together they say how coarse the answer is, which
	-- a single interpolated number never could.
	"largest_passing_size_atomic" numeric(78, 0),
	"first_failing_size_atomic" numeric(78, 0),
	"capacity_probe_count" integer DEFAULT 0 NOT NULL,
	"capacity_tolerance_bps" integer NOT NULL,
	-- False when a size passed ABOVE one that failed. The ladder disagreed with
	-- itself, and the truncated answer must not be presented as clean.
	"capacity_stable" boolean,
	-- Deterministic hash over the typed samples, so the ladder is checkable
	-- without storing a row per probe.
	"capacity_samples_hash" text,

	"route_coverage" text NOT NULL,
	"viable_route_confirmed" boolean NOT NULL,
	-- False does NOT mean a worse route was chosen. It means Miorail cannot
	-- prove it did not.
	"best_route_confirmed" boolean NOT NULL,

	"controls_snapshot_hash" text,
	"controls_block_number" numeric(78, 0),
	"transfers_paused" boolean,
	"transfer_policy_state" text,
	"controls_complete" boolean,

	-- The one block every anchored fact refers to.
	"observation_block_number" numeric(78, 0) NOT NULL,
	"observation_block_hash" text NOT NULL,
	-- Aerodrome's getAmountsOut takes no block tag, so quotes are read at
	-- `latest` while factory and control reads are pinned. Naming that is the
	-- requirement; hiding it would present mixed-block data as one atomic
	-- snapshot.
	"quote_alignment" text NOT NULL,

	"measured_at" timestamp with time zone NOT NULL,
	"stale_after" timestamp with time zone NOT NULL,
	"measurement_version" text NOT NULL,
	-- Covers the MEASUREMENTS only, never the clock: a retry that measured the
	-- same things at the same block must hash identically, or idempotency would
	-- depend on wall time.
	"evidence_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,

	CONSTRAINT "b20_observations_chain_check" CHECK ("chain_id" = 8453),
	CONSTRAINT "b20_observations_token_check" CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
	-- The only asset a round trip may start and end in.
	CONSTRAINT "b20_observations_quote_asset_check" CHECK ("reference_quote_asset" = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
	-- No `qualified`. A background measurement cannot certify an execution.
	CONSTRAINT "b20_observations_state_check" CHECK ("state" IN ('candidate', 'provisional', 'rejected', 'unmeasured')),
	CONSTRAINT "b20_observations_coverage_check" CHECK ("route_coverage" IN ('complete', 'partial')),
	CONSTRAINT "b20_observations_quote_alignment_check" CHECK ("quote_alignment" IN ('anchored', 'latest_not_anchored')),
	CONSTRAINT "b20_observations_policy_check" CHECK ("transfer_policy_state" IS NULL OR "transfer_policy_state" IN ('open', 'restricted', 'unavailable', 'unsupported_by_variant')),
	-- Every negative outcome names why, and a candidate has nothing to name yet.
	CONSTRAINT "b20_observations_reason_check" CHECK (
		("state" IN ('rejected', 'unmeasured') AND "reason_code" IS NOT NULL)
		OR ("state" = 'provisional' AND "reason_code" = 'quoted_pre_entry')
		OR ("state" = 'candidate' AND "reason_code" IS NULL)
	),
	-- A pass presupposes both legs. Without them there is no round trip to have
	-- passed, and the row would be claiming a measurement it does not hold.
	CONSTRAINT "b20_observations_provisional_check" CHECK (
		"state" <> 'provisional'
		OR ("entry_route_found" AND "exit_route_found" AND "factory_confirmed"
			AND "optimistic_round_trip_bps" IS NOT NULL
			AND "largest_passing_size_atomic" IS NOT NULL
			AND "controls_complete" = true
			AND "transfers_paused" = false)
	),
	-- A cost that passed cannot be above the tolerance it was measured against.
	CONSTRAINT "b20_observations_tolerance_check" CHECK (
		"state" <> 'provisional' OR "optimistic_round_trip_bps" <= "max_round_trip_bps"
	),
	-- Best-route is a strictly stronger claim than viable-route, and it needs
	-- complete coverage to be provable at all.
	CONSTRAINT "b20_observations_best_route_check" CHECK (
		NOT "best_route_confirmed" OR ("viable_route_confirmed" AND "route_coverage" = 'complete')
	),
	CONSTRAINT "b20_observations_bps_check" CHECK (
		"max_round_trip_bps" > 0 AND "max_round_trip_bps" <= 10000
		AND "max_exit_slippage_bps" > 0 AND "max_exit_slippage_bps" <= 10000
		AND "capacity_tolerance_bps" >= 0
		AND ("optimistic_round_trip_bps" IS NULL OR "optimistic_round_trip_bps" >= 0)
	),
	CONSTRAINT "b20_observations_position_check" CHECK ("reference_position_atomic" > 0),
	CONSTRAINT "b20_observations_probe_count_check" CHECK ("capacity_probe_count" >= 0),
	CONSTRAINT "b20_observations_block_hash_check" CHECK ("observation_block_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "b20_observations_block_number_check" CHECK ("observation_block_number" >= 0),
	CONSTRAINT "b20_observations_stale_check" CHECK ("stale_after" > "measured_at"),
	CONSTRAINT "b20_observations_version_check" CHECK ("measurement_version" ~ '^[a-z0-9./-]{1,64}$'),
	CONSTRAINT "b20_observations_launch_fk" FOREIGN KEY ("launch_id") REFERENCES "b20_launches"("id")
);
--> statement-breakpoint
-- §13 — one observation per launch, block, version and profile. This is what
-- makes a retry free rather than duplicating evidence.
CREATE UNIQUE INDEX "b20_observations_identity_unique"
	ON "b20_opportunity_observations" ("launch_id", "observation_block_number", "measurement_version", "profile_identity");
--> statement-breakpoint
CREATE INDEX "b20_observations_token_idx" ON "b20_opportunity_observations" ("chain_id", "token_address", "measured_at" DESC);
--> statement-breakpoint
CREATE INDEX "b20_observations_launch_idx" ON "b20_opportunity_observations" ("launch_id", "measured_at" DESC);
--> statement-breakpoint

-- An observation is what was true at a block. It does not get edited later.
CREATE OR REPLACE FUNCTION "b20_observations_immutable"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'b20_opportunity_observations rows are immutable; a changed measurement is a new observation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "b20_observations_immutable_trigger"
	BEFORE UPDATE ON "b20_opportunity_observations"
	FOR EACH ROW EXECUTE FUNCTION "b20_observations_immutable"();
--> statement-breakpoint

-- §13 — a lease for the MEASUREMENT worker, separate from the ingestion lease
-- in 0028. The two do different work at different rates, and one holding the
-- other's cursor would stop launches being read while quotes are gathered.
CREATE TABLE "b20_measure_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- An owner without an expiry is a lock nobody can ever break.
	CONSTRAINT "b20_measure_leases_lease_check" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
);
