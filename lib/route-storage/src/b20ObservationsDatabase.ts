import {
  B20_MEASURE_LANE_V1,
  assertObservationV1,
  observationConflictV1,
  type B20MeasurableLaunchV1,
  type B20MeasureLeaseV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
} from './b20Observations.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Postgres-backed B20ObservationRepositoryV1.
//
// Observations are insert-only: migration 0029 has a trigger that raises on any
// UPDATE, so "a changed measurement is a new observation" is a database
// guarantee rather than a habit. That makes the insert path the only path, and
// idempotency has to be handled there — `ON CONFLICT DO NOTHING` followed by a
// read, then an evidence-hash comparison to tell a retry from a disagreement.
// ---------------------------------------------------------------------------

function isoV1(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isoOrNullV1(value: unknown): string | null {
  return value === null || value === undefined ? null : isoV1(value);
}

function digitsOrNullV1(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberOrNullV1(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function boolOrNullV1(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}

function rowToObservationV1(row: Record<string, unknown>): B20OpportunityObservationV1 {
  return assertObservationV1({
    id: row.id,
    launchId: row.launch_id,
    chainId: Number(row.chain_id),
    tokenAddress: row.token_address,
    referenceQuoteAsset: row.reference_quote_asset,
    referencePositionAtomic: String(row.reference_position_atomic),
    maxRoundTripBps: Number(row.max_round_trip_bps),
    maxExitSlippageBps: Number(row.max_exit_slippage_bps),
    profileIdentity: row.profile_identity,
    state: row.state,
    reasonCode: row.reason_code ?? null,
    factoryConfirmed: Boolean(row.factory_confirmed),
    initialized: Boolean(row.initialized),
    entryRouteFound: Boolean(row.entry_route_found),
    exitRouteFound: Boolean(row.exit_route_found),
    entryRouteHash: row.entry_route_hash ?? null,
    exitRouteHash: row.exit_route_hash ?? null,
    entrySourceKey: row.entry_source_key ?? null,
    exitSourceKey: row.exit_source_key ?? null,
    entryOutputAtomic: digitsOrNullV1(row.entry_output_atomic),
    optimisticExitReturnAtomic: digitsOrNullV1(row.optimistic_exit_return_atomic),
    optimisticRoundTripBps: numberOrNullV1(row.optimistic_round_trip_bps),
    largestPassingSizeAtomic: digitsOrNullV1(row.largest_passing_size_atomic),
    firstFailingSizeAtomic: digitsOrNullV1(row.first_failing_size_atomic),
    capacityProbeCount: Number(row.capacity_probe_count),
    capacityToleranceBps: Number(row.capacity_tolerance_bps),
    capacityStable: boolOrNullV1(row.capacity_stable),
    capacitySamplesHash: row.capacity_samples_hash ?? null,
    routeCoverage: row.route_coverage,
    viableRouteConfirmed: Boolean(row.viable_route_confirmed),
    bestRouteConfirmed: Boolean(row.best_route_confirmed),
    controlsSnapshotHash: row.controls_snapshot_hash ?? null,
    controlsBlockNumber: digitsOrNullV1(row.controls_block_number),
    transfersPaused: boolOrNullV1(row.transfers_paused),
    transferPolicyState: row.transfer_policy_state ?? null,
    controlsComplete: boolOrNullV1(row.controls_complete),
    observationBlockNumber: String(row.observation_block_number),
    observationBlockHash: row.observation_block_hash,
    quoteAlignment: row.quote_alignment,
    measuredAt: isoV1(row.measured_at),
    staleAfter: isoV1(row.stale_after),
    measurementVersion: row.measurement_version,
    evidenceHash: row.evidence_hash,
    createdAt: isoV1(row.created_at),
  });
}

export function createDatabaseB20ObservationRepository(
  sql: SqlTemplateExecutor,
): B20ObservationRepositoryV1 {
  const readById = async (id: string): Promise<B20OpportunityObservationV1 | null> => {
    const rows = await sql`SELECT * FROM b20_opportunity_observations WHERE id = ${id} LIMIT 1`;
    return rows[0] ? rowToObservationV1(rows[0] as Record<string, unknown>) : null;
  };

  return {
    async selectMeasurableLaunches(input) {
      const now = new Date(input.now);
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs);
      const freshEnough = new Date(Date.parse(input.now) - input.minReMeasureIntervalMs);
      // `canonical` is in the WHERE clause, not filtered afterwards: a launch
      // the chain took back is not a token anybody should be shown a
      // measurement of, and a filter applied later is a filter that can be
      // forgotten.
      const rows = await sql`
        SELECT l.id, l.token_address, l.block_number, l.block_hash, l.detected_at,
               o.last_measured_at
        FROM b20_launches l
        LEFT JOIN LATERAL (
          SELECT max(measured_at) AS last_measured_at
          FROM b20_opportunity_observations
          WHERE launch_id = l.id
        ) o ON true
        WHERE l.canonical
          AND l.chain_id = 8453
          AND l.detected_at >= ${oldest}
          AND l.detected_at <= ${now}
          AND (o.last_measured_at IS NULL OR o.last_measured_at < ${freshEnough})
        ORDER BY l.detected_at ASC, l.id ASC
        LIMIT ${Math.max(1, Math.min(500, input.limit))}`;
      return rows.map((row): B20MeasurableLaunchV1 => {
        const record = row as Record<string, unknown>;
        return {
          launchId: String(record.id),
          tokenAddress: String(record.token_address),
          blockNumber: String(record.block_number),
          blockHash: String(record.block_hash),
          detectedAt: isoV1(record.detected_at),
          lastMeasuredAt: isoOrNullV1(record.last_measured_at),
        };
      });
    },

    async insertObservation(observation) {
      const parsed = assertObservationV1(observation, 'write');
      const inserted = await sql`
        INSERT INTO b20_opportunity_observations (
          id, launch_id, chain_id, token_address,
          reference_quote_asset, reference_position_atomic, max_round_trip_bps, max_exit_slippage_bps,
          profile_identity, state, reason_code,
          factory_confirmed, initialized, entry_route_found, exit_route_found,
          entry_route_hash, exit_route_hash, entry_source_key, exit_source_key,
          entry_output_atomic, optimistic_exit_return_atomic, optimistic_round_trip_bps,
          largest_passing_size_atomic, first_failing_size_atomic, capacity_probe_count,
          capacity_tolerance_bps, capacity_stable, capacity_samples_hash,
          route_coverage, viable_route_confirmed, best_route_confirmed,
          controls_snapshot_hash, controls_block_number, transfers_paused,
          transfer_policy_state, controls_complete,
          observation_block_number, observation_block_hash, quote_alignment,
          measured_at, stale_after, measurement_version, evidence_hash
        ) VALUES (
          ${parsed.id}, ${parsed.launchId}, ${parsed.chainId}, ${parsed.tokenAddress},
          ${parsed.referenceQuoteAsset}, ${parsed.referencePositionAtomic}::numeric(78,0),
          ${parsed.maxRoundTripBps}, ${parsed.maxExitSlippageBps},
          ${parsed.profileIdentity}, ${parsed.state}, ${parsed.reasonCode},
          ${parsed.factoryConfirmed}, ${parsed.initialized}, ${parsed.entryRouteFound}, ${parsed.exitRouteFound},
          ${parsed.entryRouteHash}, ${parsed.exitRouteHash}, ${parsed.entrySourceKey}, ${parsed.exitSourceKey},
          ${parsed.entryOutputAtomic}::numeric(78,0), ${parsed.optimisticExitReturnAtomic}::numeric(78,0),
          ${parsed.optimisticRoundTripBps},
          ${parsed.largestPassingSizeAtomic}::numeric(78,0), ${parsed.firstFailingSizeAtomic}::numeric(78,0),
          ${parsed.capacityProbeCount}, ${parsed.capacityToleranceBps}, ${parsed.capacityStable},
          ${parsed.capacitySamplesHash},
          ${parsed.routeCoverage}, ${parsed.viableRouteConfirmed}, ${parsed.bestRouteConfirmed},
          ${parsed.controlsSnapshotHash}, ${parsed.controlsBlockNumber}::numeric(78,0), ${parsed.transfersPaused},
          ${parsed.transferPolicyState}, ${parsed.controlsComplete},
          ${parsed.observationBlockNumber}::numeric(78,0), ${parsed.observationBlockHash}, ${parsed.quoteAlignment},
          ${parsed.measuredAt}::timestamptz, ${parsed.staleAfter}::timestamptz,
          ${parsed.measurementVersion}, ${parsed.evidenceHash}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;

      if (inserted.length > 0) {
        const stored = await readById(parsed.id);
        if (!stored) throw observationConflictV1('The observation vanished immediately after insertion');
        return { observation: stored, inserted: true };
      }

      // Nothing was inserted, so a row with this identity already exists.
      const existing = await readById(parsed.id);
      if (!existing) {
        // The identity index refused it under a DIFFERENT id — the four
        // identity columns collided while the derived id did not, which means
        // one of them was computed differently. Never a retry.
        throw observationConflictV1(
          'An observation with this identity exists under a different id',
        );
      }
      if (existing.evidenceHash !== parsed.evidenceHash) {
        // Two disagreeing measurements of one block. Neither wins by arriving
        // second, and the trigger would refuse an overwrite anyway.
        throw observationConflictV1(
          'A different observation already exists for this launch, block, version and profile',
        );
      }
      return { observation: existing, inserted: false };
    },

    async getObservation(id) {
      return readById(id);
    },

    async listObservationsForLaunch(input) {
      const rows = await sql`
        SELECT * FROM b20_opportunity_observations
        WHERE launch_id = ${input.launchId}
        ORDER BY measured_at DESC, id DESC
        LIMIT ${Math.max(1, Math.min(200, input.limit))}`;
      return rows.map((row) => rowToObservationV1(row as Record<string, unknown>));
    },

    async listRecentObservations(input) {
      const rows = await sql`
        SELECT * FROM b20_opportunity_observations
        ORDER BY measured_at DESC, id DESC
        LIMIT ${Math.max(1, Math.min(200, input.limit))}`;
      return rows.map((row) => rowToObservationV1(row as Record<string, unknown>));
    },

    async acquireMeasureLease(input) {
      const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
      // Created on first use, so no bootstrap step can be forgotten.
      await sql`
        INSERT INTO b20_measure_leases (id, created_at, updated_at)
        VALUES (${B20_MEASURE_LANE_V1}, ${input.now}::timestamptz, ${input.now}::timestamptz)
        ON CONFLICT (id) DO NOTHING`;
      const rows = await sql`
        UPDATE b20_measure_leases
        SET lease_owner = ${input.owner},
            lease_expires_at = ${expiresAt}::timestamptz,
            updated_at = ${input.now}::timestamptz
        WHERE id = ${B20_MEASURE_LANE_V1}
          AND (lease_owner IS NULL OR lease_owner = ${input.owner} OR lease_expires_at <= ${input.now}::timestamptz)
        RETURNING id, lease_owner, lease_expires_at, last_run_id, updated_at`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        leaseOwner: (row.lease_owner as string | null) ?? null,
        leaseExpiresAt: isoOrNullV1(row.lease_expires_at),
        lastRunId: (row.last_run_id as string | null) ?? null,
        updatedAt: isoV1(row.updated_at),
      } satisfies B20MeasureLeaseV1;
    },

    async releaseMeasureLease(input) {
      await sql`
        UPDATE b20_measure_leases
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ${input.now}::timestamptz
        WHERE id = ${B20_MEASURE_LANE_V1} AND lease_owner = ${input.owner}`;
    },
  };
}
