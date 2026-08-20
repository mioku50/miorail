import {
  B20_MEASUREMENT_VERSION_V1,
  B20_MEASURE_RUN_WINDOW_MS_V1,
  B20_MEASURE_LANE_V1,
  assertObservationV1,
  decodeFeedCursorV1,
  encodeFeedCursorV1,
  observationConflictV1,
  type B20FeedRowV1,
  type B20FeedAggregateBucketV1,
  type B20MeasurableLaunchV1,
  type B20MeasureLeaseV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
} from './b20Observations.js';
import {
  B20_MEASUREMENT_BACKOFF_V1,
  B20_REPRICEABLE_REJECTIONS_V1,
  B20_ROUTE_EXISTENCE_REJECTIONS_V1,
} from './b20MeasurementBackoff.js';
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

/**
 * T73 — `to_jsonb(row.*)` renders a `numeric` column as a JSON NUMBER, and a
 * 78-digit atomic amount does not survive that: it comes back as a float and
 * the evidence hash stops matching. Every numeric column is re-added as text.
 *
 * The list is exported so a test can assert the query re-casts every one of
 * them: a column added to the table and forgotten here comes back as a float
 * and fails only on amounts large enough to matter.
 */
const OBSERVATION_JSONB_NUMERICS_V1 = [
  'reference_position_atomic',
  'entry_output_atomic',
  'optimistic_exit_return_atomic',
  'largest_passing_size_atomic',
  'first_failing_size_atomic',
  'observation_block_number',
  'controls_block_number',
] as const;

export { OBSERVATION_JSONB_NUMERICS_V1 };

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
    poolHookAddress: row.pool_hook_address ?? null,
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
    // Null on every row written before the column existed, and null is
    // UNKNOWN — never an empty search. An empty array from the driver means
    // the same thing and is normalised to null so one shape reaches the rail.
    venuesConsulted:
      Array.isArray(row.venues_consulted) && row.venues_consulted.length > 0
        ? (row.venues_consulted as unknown[]).map((venue) => String(venue))
        : null,
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
      const now = new Date(input.now).toISOString();
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();
      // One cutoff per backoff class rather than one for everything. The class
      // is chosen in SQL because the choice depends on `repeats`, which only
      // the database can count — but the reason lists and the durations come
      // from the shared policy, so this query and the in-memory repository
      // cannot drift apart on what a rejection means.
      const backoff = { ...B20_MEASUREMENT_BACKOFF_V1, baseMs: input.minReMeasureIntervalMs };
      const cutoff = (ms: number) => new Date(Date.parse(input.now) - ms).toISOString();
      const baseCutoff = cutoff(backoff.baseMs);
      // `canonical` is in the WHERE clause, not filtered afterwards: a launch
      // the chain took back is not a token anybody should be shown a
      // measurement of, and a filter applied later is a filter that can be
      // forgotten.
      const rows = await sql`
        SELECT l.id, l.token_address, l.block_number, l.block_hash, l.detected_at,
               l.ingestion_source, o.last_measured_at
        FROM b20_launches l
        LEFT JOIN LATERAL (
          SELECT last.measured_at AS last_measured_at,
                 last.state       AS last_state,
                 last.reason_code AS last_reason_code,
                 -- Consecutive, not total: everything newer than the most
                 -- recent observation that said something different. A token
                 -- that flipped back to provisional and then rejected again
                 -- starts its count over, which is the point.
                 (
                   SELECT count(*)
                   FROM b20_opportunity_observations r
                   WHERE r.launch_id = l.id
                     AND r.measured_at > COALESCE((
                       SELECT max(x.measured_at)
                       FROM b20_opportunity_observations x
                       WHERE x.launch_id = l.id
                         AND (x.state IS DISTINCT FROM last.state
                              OR x.reason_code IS DISTINCT FROM last.reason_code)
                     ), '-infinity'::timestamptz)
                 ) AS repeats
          FROM b20_opportunity_observations last
          WHERE last.launch_id = l.id
          ORDER BY last.measured_at DESC, last.id DESC
          LIMIT 1
        ) o ON true
        WHERE l.canonical
          AND l.chain_id = 8453
          AND l.detected_at >= ${oldest}::timestamptz
          AND l.detected_at <= ${now}::timestamptz
          AND (
            o.last_measured_at IS NULL
            OR o.last_measured_at < (
              CASE
                WHEN o.last_state <> 'rejected' THEN ${baseCutoff}::timestamptz
                WHEN o.last_reason_code = ANY(${[...B20_REPRICEABLE_REJECTIONS_V1]}::text[])
                  THEN ${cutoff(backoff.repriceableMs)}::timestamptz
                WHEN o.last_reason_code = ANY(${[...B20_ROUTE_EXISTENCE_REJECTIONS_V1]}::text[])
                  THEN CASE
                         WHEN o.repeats >= ${backoff.settledAfterRepeats}
                           THEN ${cutoff(backoff.settledMs)}::timestamptz
                         ELSE ${cutoff(backoff.settlingMs)}::timestamptz
                       END
                ELSE ${baseCutoff}::timestamptz
              END
            )
          )
        -- Live first, then newest FOUND within each group.
        --
        -- The second key is the original one: Discover lists launches
        -- newest-first, so oldest-first made the top of the home screen the
        -- part the worker reached last.
        --
        -- The first key exists because a backfill writes detected_at = now()
        -- — truthfully, since that is when Miorail found the row — which makes
        -- a launch from July indistinguishable from one a minute old. The
        -- historical gap is ~740,000 blocks, about 11,000-12,000 launches. On
        -- detected_at alone, filling it would put all of them ahead of every
        -- live launch and starve the thing the worker exists for. Repairing
        -- history must not cost the present.
        ORDER BY (l.ingestion_source = 'live') DESC, l.detected_at DESC, l.id DESC
        LIMIT ${Math.max(1, Math.min(500, input.limit))}`;
      return rows.map((row): B20MeasurableLaunchV1 => {
        const record = row as Record<string, unknown>;
        return {
          launchId: String(record.id),
          tokenAddress: String(record.token_address),
          blockNumber: String(record.block_number),
          blockHash: String(record.block_hash),
          detectedAt: isoV1(record.detected_at),
          ingestionSource: record.ingestion_source === 'backfill' ? 'backfill' : 'live',
          lastMeasuredAt: isoOrNullV1(record.last_measured_at),
        };
      });
    },

    async selectRemeasurableLaunches(input) {
      const versions = [...(input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1])];
      const limit = Math.max(1, Math.min(100, input.limit));
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();
      // The band, expressed as the AGE of the newest comparable observation.
      // Measuring now writes an observation `age` after it, so an age inside
      // [pairAge - tolerance, pairAge + tolerance] is exactly the set where one
      // more measurement produces a pair the movers rail will accept.
      const youngest = new Date(
        Date.parse(input.now) - (input.pairAgeMs - input.pairToleranceMs),
      ).toISOString();
      const oldestInBand = new Date(
        Date.parse(input.now) - (input.pairAgeMs + input.pairToleranceMs),
      ).toISOString();

      // The LATERAL takes the newest COMPARABLE observation, which is exactly
      // what `listMoverPairs` uses as the later half of a pair — so this queue
      // and the projection are asking the same question.
      //
      // It selected the newest observation of ANY state at first, on the
      // reasoning that a token whose last reading was a route failure has no
      // current market profile. Production disagreed within one pass: two
      // candidates came back `route_search_degraded`, which is Miorail's read
      // not completing rather than anything about the token, and that reading
      // then evicted both from this queue permanently. The pairing does not
      // care — it still reads through to the last comparable observation — so
      // neither does this.
      const rows = await sql`
        SELECT l.id, l.token_address, l.block_number, l.block_hash, l.detected_at,
               l.ingestion_source, o.measured_at AS last_measured_at
        FROM b20_launches l
        JOIN LATERAL (
          SELECT last.measured_at
          FROM b20_opportunity_observations last
          WHERE last.launch_id = l.id
            AND last.measurement_version = ANY(${versions}::text[])
            AND (
              last.state = 'provisional'
              OR (last.state = 'rejected' AND last.reason_code = 'round_trip_above_tolerance')
            )
          ORDER BY last.measured_at DESC, last.id DESC
          LIMIT 1
        ) o ON true
        WHERE l.canonical
          AND l.chain_id = 8453
          AND l.detected_at >= ${oldest}::timestamptz
          AND o.measured_at <= ${youngest}::timestamptz
          AND o.measured_at >= ${oldestInBand}::timestamptz
        -- Oldest first. A queue ordered the other way is the one that starved.
        ORDER BY o.measured_at ASC, l.id ASC
        LIMIT ${limit}`;

      return rows.map((row): B20MeasurableLaunchV1 => {
        const record = row as Record<string, unknown>;
        return {
          launchId: String(record.id),
          tokenAddress: String(record.token_address),
          blockNumber: String(record.block_number),
          blockHash: String(record.block_hash),
          detectedAt: isoV1(record.detected_at),
          ingestionSource: record.ingestion_source === 'backfill' ? 'backfill' : 'live',
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
          pool_hook_address,
          entry_output_atomic, optimistic_exit_return_atomic, optimistic_round_trip_bps,
          largest_passing_size_atomic, first_failing_size_atomic, capacity_probe_count,
          capacity_tolerance_bps, capacity_stable, capacity_samples_hash,
          route_coverage, viable_route_confirmed, best_route_confirmed, venues_consulted,
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
          ${parsed.poolHookAddress},
          ${parsed.entryOutputAtomic}::numeric(78,0), ${parsed.optimisticExitReturnAtomic}::numeric(78,0),
          ${parsed.optimisticRoundTripBps},
          ${parsed.largestPassingSizeAtomic}::numeric(78,0), ${parsed.firstFailingSizeAtomic}::numeric(78,0),
          ${parsed.capacityProbeCount}, ${parsed.capacityToleranceBps}, ${parsed.capacityStable},
          ${parsed.capacitySamplesHash},
          ${parsed.routeCoverage}, ${parsed.viableRouteConfirmed}, ${parsed.bestRouteConfirmed},
          ${parsed.venuesConsulted}::text[],
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
        if (!stored)
          throw observationConflictV1('The observation vanished immediately after insertion');
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

    async listMoverPairs(input) {
      const versions = [...(input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1])];
      // Market rails read the bounded 48h population, not only the newest feed
      // page. Production crossed 600 active launches before the first fresh
      // measured exit, so a 100-row clamp made healthy evidence invisible.
      const limit = Math.max(1, Math.min(1_000, input.limit));
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();
      const ageSeconds = Math.round(input.baselineAgeMs / 1000);
      const toleranceSeconds = Math.round(input.baselineToleranceMs / 1000);

      // ONE query, two LATERALs. `o` is the newest observation that actually
      // contains a comparable market profile, not merely the newest attempt.
      // A later RPC/control failure is useful on the Discover card, but it did
      // not erase the quote and capacity Miorail measured earlier. Treating it
      // as the market row made both rails empty after every degraded refresh.
      //
      // The baseline is chosen NEAREST the target age rather than "newest
      // older than it": with dense measurement the latter silently shortens
      // the interval, and the rail's label promises 24 hours.
      //
      // `to_jsonb` rather than 35 aliased columns — the keys are the same
      // snake_case the row mapper already reads, so one mapper serves both.
      const rows = await sql`
        SELECT
          l.id AS launch_id, l.token_address, l.name, l.symbol, l.variant, l.decimals,
          l.block_number AS launch_block, l.canonical,
          lb.buyer_count, lb.top_buyer_share_bps, lb.top_three_share_bps,
          lb.search_from_block AS buyers_from_block, lb.search_to_block AS buyers_to_block,
          to_jsonb(o.*) || jsonb_build_object(
            'reference_position_atomic', o.reference_position_atomic::text,
            'entry_output_atomic', o.entry_output_atomic::text,
            'optimistic_exit_return_atomic', o.optimistic_exit_return_atomic::text,
            'largest_passing_size_atomic', o.largest_passing_size_atomic::text,
            'first_failing_size_atomic', o.first_failing_size_atomic::text,
            'observation_block_number', o.observation_block_number::text,
            'controls_block_number', o.controls_block_number::text
          ) AS latest_json,
          CASE WHEN b.id IS NULL THEN NULL ELSE to_jsonb(b.*) || jsonb_build_object(
            'reference_position_atomic', b.reference_position_atomic::text,
            'entry_output_atomic', b.entry_output_atomic::text,
            'optimistic_exit_return_atomic', b.optimistic_exit_return_atomic::text,
            'largest_passing_size_atomic', b.largest_passing_size_atomic::text,
            'first_failing_size_atomic', b.first_failing_size_atomic::text,
            'observation_block_number', b.observation_block_number::text,
            'controls_block_number', b.controls_block_number::text
          ) END AS baseline_json
        FROM b20_launches l
        JOIN LATERAL (
          SELECT *
          FROM b20_opportunity_observations obs
          WHERE obs.launch_id = l.id
            AND obs.measurement_version = ANY(${versions}::text[])
            AND (
              obs.state = 'provisional'
              OR (obs.state = 'rejected' AND obs.reason_code = 'round_trip_above_tolerance')
            )
          ORDER BY obs.measured_at DESC, obs.observation_block_number DESC, obs.id DESC
          LIMIT 1
        ) o ON true
        LEFT JOIN LATERAL (
          SELECT *
          FROM b20_opportunity_observations prev
          WHERE prev.launch_id = l.id
            AND prev.measurement_version = o.measurement_version
            AND prev.id <> o.id
            AND (
              prev.state = 'provisional'
              OR (prev.state = 'rejected' AND prev.reason_code = 'round_trip_above_tolerance')
            )
            AND prev.measured_at <= o.measured_at - make_interval(secs => ${ageSeconds - toleranceSeconds})
            AND prev.measured_at >= o.measured_at - make_interval(secs => ${ageSeconds + toleranceSeconds})
          ORDER BY abs(extract(epoch FROM (
            prev.measured_at - (o.measured_at - make_interval(secs => ${ageSeconds}))
          ))) ASC, prev.id ASC
          LIMIT 1
        ) b ON true
        -- Launch-window buying, when it has been measured. LEFT because it is
        -- context about a launch, not part of a measurement: a token nobody
        -- has looked at yet must still appear on the feed.
        LEFT JOIN b20_launch_buyers lb ON lb.token_address = l.token_address
        WHERE l.canonical
          AND l.chain_id = 8453
          AND l.detected_at >= ${oldest}::timestamptz
        ORDER BY l.block_number DESC, l.id DESC
        LIMIT ${limit}`;

      return rows.map((row) => ({
        launch: {
          id: String(row.launch_id),
          tokenAddress: String(row.token_address),
          name: String(row.name),
          symbol: String(row.symbol),
          variant: row.variant as 'asset' | 'stablecoin',
          decimals:
            row.decimals === null || row.decimals === undefined ? null : Number(row.decimals),
          blockNumber: String(row.launch_block),
          canonical: Boolean(row.canonical),
        },
        latest: rowToObservationV1(row.latest_json as Record<string, unknown>),
        baseline:
          row.baseline_json === null || row.baseline_json === undefined
            ? null
            : rowToObservationV1(row.baseline_json as Record<string, unknown>),
      }));
    },

    async listFeed(input) {
      const versions = [...(input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1])];
      const limit = Math.max(1, Math.min(100, input.limit));
      const states = [...(input.states ?? [])];
      const after = input.cursor ? decodeFeedCursorV1(input.cursor) : null;
      if (input.cursor && !after) {
        // A malformed cursor is refused rather than silently restarting the
        // feed, which would look to a caller like duplicated results.
        throw observationConflictV1('The pagination cursor is not readable');
      }
      const oldest =
        input.maxLaunchAgeMs == null
          ? null
          : new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();

      // ONE query. The latest observation per launch is a LATERAL, so the feed
      // costs one round trip whatever the page size — an observation read per
      // launch would be N+1 against a list that grows with every B20 launch.
      //
      // `l.canonical` is in the WHERE clause, not filtered afterwards: a launch
      // the chain took back is not something a user should be offered.
      const rows = await sql`
        SELECT
          -- EVERY launch column is aliased, and that is load-bearing.
          --
          -- o.* expands to the whole observation row, which shares
          -- token_address and launch_id with the launch. A driver builds one
          -- flat object per row, so the LAST column of a duplicated name wins,
          -- and on a LEFT JOIN with no observation o.* is all NULLs. The feed
          -- therefore served String(null) as a token address: the literal
          -- four-character string "null", which fails the address regex and
          -- 500s the whole page.
          --
          -- It survived on Neon because every launch there happened to have an
          -- observation, so the duplicate carried the same value. The first
          -- unmeasured launch on any driver would have done this.
          l.id AS launch_row_id, l.token_address AS launch_token_address,
          l.name AS launch_name, l.symbol AS launch_symbol, l.variant AS launch_variant,
          l.decimals AS launch_decimals, l.block_number AS launch_block,
          l.transaction_hash AS launch_transaction_hash, l.log_index AS launch_log_index,
          l.detected_at AS launch_detected_at, l.block_timestamp AS launch_block_timestamp,
          l.canonical AS launch_canonical,
          lb.buyer_count, lb.top_buyer_share_bps, lb.top_three_share_bps,
          lb.search_from_block AS buyers_from_block, lb.search_to_block AS buyers_to_block,
          o.*
        FROM b20_launches l
        LEFT JOIN LATERAL (
          SELECT *
          FROM b20_opportunity_observations obs
          WHERE obs.launch_id = l.id
            AND obs.measurement_version = ANY(${versions}::text[])
          -- A total order, so "the latest" never depends on the planner.
          ORDER BY obs.measured_at DESC, obs.observation_block_number DESC, obs.id DESC
          LIMIT 1
        ) o ON true
        LEFT JOIN b20_launch_buyers lb ON lb.token_address = l.token_address
        WHERE l.canonical
          AND l.chain_id = 8453
          AND (${oldest}::timestamptz IS NULL OR l.detected_at >= ${oldest}::timestamptz)
          AND (${states.length} = 0 OR o.state = ANY(${states}::text[]))
          AND (
            ${after === null}
            OR (l.block_number, coalesce(o.measured_at, '-infinity'::timestamptz), l.id)
               < (
                 ${after?.launchBlockNumber ?? '0'}::numeric(78,0),
                 coalesce(${after?.measuredAt ?? null}::timestamptz, '-infinity'::timestamptz),
                 ${after?.launchId ?? ''}
               )
          )
        ORDER BY l.block_number DESC, coalesce(o.measured_at, '-infinity'::timestamptz) DESC, l.id DESC
        LIMIT ${limit + 1}`;

      // One extra row is read purely to know whether a next page exists,
      // without a second count query that could disagree with this one.
      const page = rows.slice(0, limit).map((row) => feedRowV1(row as Record<string, unknown>));
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor:
          rows.length > limit && last
            ? encodeFeedCursorV1({
                launchBlockNumber: last.launch.blockNumber,
                measuredAt: last.observation?.measuredAt ?? null,
                launchId: last.launch.id,
              })
            : null,
      };
    },

    async aggregateFeed(input) {
      const versions = [...(input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1])];
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();

      // Full-corpus COUNT, not a card scan. The query groups only the inputs
      // `b20ExitStandingV1` consumes; the shared TypeScript projection still
      // decides the standing, so summary and card semantics cannot drift into
      // separate CASE expressions.
      const rows = await sql`
        WITH latest AS (
          SELECT
            o.state, o.reason_code, o.entry_route_found, o.exit_route_found,
            o.venues_consulted, lb.buyer_count
          FROM b20_launches l
          LEFT JOIN LATERAL (
            SELECT state, reason_code, entry_route_found, exit_route_found, venues_consulted
            FROM b20_opportunity_observations obs
            WHERE obs.launch_id = l.id
              AND obs.measurement_version = ANY(${versions}::text[])
            ORDER BY obs.measured_at DESC, obs.observation_block_number DESC, obs.id DESC
            LIMIT 1
          ) o ON true
          LEFT JOIN b20_launch_buyers lb ON lb.token_address = l.token_address
          WHERE l.canonical
            AND l.chain_id = 8453
            AND l.detected_at >= ${oldest}::timestamptz
        )
        SELECT
          state, reason_code, entry_route_found, exit_route_found,
          venues_consulted, buyer_count, count(*)::int AS count
        FROM latest
        GROUP BY state, reason_code, entry_route_found, exit_route_found, venues_consulted, buyer_count
        ORDER BY count DESC, state NULLS FIRST, reason_code NULLS FIRST`;

      const buckets = (rows as Record<string, unknown>[]).map(
        (row): B20FeedAggregateBucketV1 => ({
          count: Number(row.count),
          observation:
            row.state === null || row.state === undefined
              ? null
              : {
                  state: row.state as B20OpportunityObservationV1['state'],
                  reasonCode:
                    (row.reason_code as B20OpportunityObservationV1['reasonCode']) ?? null,
                  entryRouteFound: Boolean(row.entry_route_found),
                  exitRouteFound: Boolean(row.exit_route_found),
                  venuesConsulted:
                    Array.isArray(row.venues_consulted) && row.venues_consulted.length > 0
                      ? row.venues_consulted.map((venue) => String(venue))
                      : null,
                },
          buyerCount: numberOrNullV1(row.buyer_count),
        }),
      );
      return {
        inspected: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        buckets,
      };
    },

    async getFeedRowForToken(input) {
      const versions = [...(input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1])];
      const rows = await sql`
        SELECT
          -- EVERY launch column is aliased, and that is load-bearing.
          --
          -- o.* expands to the whole observation row, which shares
          -- token_address and launch_id with the launch. A driver builds one
          -- flat object per row, so the LAST column of a duplicated name wins,
          -- and on a LEFT JOIN with no observation o.* is all NULLs. The feed
          -- therefore served String(null) as a token address: the literal
          -- four-character string "null", which fails the address regex and
          -- 500s the whole page.
          --
          -- It survived on Neon because every launch there happened to have an
          -- observation, so the duplicate carried the same value. The first
          -- unmeasured launch on any driver would have done this.
          l.id AS launch_row_id, l.token_address AS launch_token_address,
          l.name AS launch_name, l.symbol AS launch_symbol, l.variant AS launch_variant,
          l.decimals AS launch_decimals, l.block_number AS launch_block,
          l.transaction_hash AS launch_transaction_hash, l.log_index AS launch_log_index,
          l.detected_at AS launch_detected_at, l.block_timestamp AS launch_block_timestamp,
          l.canonical AS launch_canonical,
          lb.buyer_count, lb.top_buyer_share_bps, lb.top_three_share_bps,
          lb.search_from_block AS buyers_from_block, lb.search_to_block AS buyers_to_block,
          o.*
        FROM b20_launches l
        LEFT JOIN LATERAL (
          SELECT * FROM b20_opportunity_observations obs
          WHERE obs.launch_id = l.id AND obs.measurement_version = ANY(${versions}::text[])
          ORDER BY obs.measured_at DESC, obs.observation_block_number DESC, obs.id DESC
          LIMIT 1
        ) o ON true
        LEFT JOIN b20_launch_buyers lb ON lb.token_address = l.token_address
        WHERE l.canonical AND l.chain_id = 8453 AND l.token_address = ${input.tokenAddress.toLowerCase()}
        -- The most recent canonical launch of this address. A token relaunched
        -- by a second event is a second launch, and the newest one is the live
        -- subject.
        ORDER BY l.block_number DESC, l.log_index DESC
        LIMIT 1`;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const mapped = feedRowV1(row);
      const history = await sql`
        SELECT * FROM b20_opportunity_observations
        WHERE launch_id = ${mapped.launch.id}
        ORDER BY measured_at DESC, id DESC
        LIMIT ${Math.max(1, Math.min(50, input.historyLimit))}`;
      return {
        row: mapped,
        history: history.map((entry) => rowToObservationV1(entry as Record<string, unknown>)),
      };
    },

    async pipelineCounts(input) {
      const oldest = new Date(Date.parse(input.now) - input.maxLaunchAgeMs).toISOString();
      // One round trip for every count the pipeline status needs. A status
      // assembled from several queries could describe a pipeline that never
      // existed at any single moment.
      const rows = await sql`
        SELECT
          (SELECT count(*)::int FROM b20_launches WHERE canonical) AS canonical_launches,
          (SELECT count(*)::int FROM b20_launches l
             WHERE l.canonical AND l.detected_at >= ${oldest}::timestamptz
               AND NOT EXISTS (
                 SELECT 1 FROM b20_opportunity_observations o
                 WHERE o.launch_id = l.id AND o.measurement_version = ${B20_MEASUREMENT_VERSION_V1}
               )) AS awaiting_measurement,
          (SELECT count(*)::int FROM b20_opportunity_observations) AS observations,
          (SELECT max(measured_at) FROM b20_opportunity_observations) AS last_measurement_at,
          (SELECT count(*)::int FROM b20_opportunity_observations
             WHERE measured_at >= (SELECT max(measured_at) FROM b20_opportunity_observations)
                                  - make_interval(secs => ${B20_MEASURE_RUN_WINDOW_MS_V1 / 1000})
          ) AS observations_last_run,
          c.last_processed_block, c.operator_state,
          r.finished_at AS last_run_at, r.result AS last_result,
          r.confirmed_head, r.budget_exhausted
        FROM (SELECT 1) AS one
        LEFT JOIN b20_discover_cursors c ON true
        LEFT JOIN LATERAL (
          SELECT finished_at, result, confirmed_head, budget_exhausted
          FROM b20_discover_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        ) r ON true
        LIMIT 1`;
      const row = (rows[0] ?? {}) as Record<string, unknown>;
      return {
        canonicalLaunchCount: Number(row.canonical_launches ?? 0),
        launchesAwaitingMeasurement: Number(row.awaiting_measurement ?? 0),
        observationCount: Number(row.observations ?? 0),
        ingestionCursorBlock: digitsOrNullV1(row.last_processed_block),
        ingestionOperatorState: (row.operator_state as string | null) ?? null,
        lastIngestionRunAt: isoOrNullV1(row.last_run_at),
        lastIngestionResult: (row.last_result as string | null) ?? null,
        lastIngestionConfirmedHead: digitsOrNullV1(row.confirmed_head),
        lastIngestionBudgetExhausted: Boolean(row.budget_exhausted),
        lastMeasurementRunAt: isoOrNullV1(row.last_measurement_at),
        observationsLastRun: Number(row.observations_last_run ?? 0),
      };
    },
  };
}

/** A joined launch + latest-observation row. The observation half is null
 * whenever the LATERAL matched nothing, which is a real state. */
function feedRowV1(row: Record<string, unknown>): B20FeedRowV1 {
  return {
    launch: {
      // Read from the `launch_`-prefixed aliases ONLY. An unprefixed name here
      // would read the observation's copy, which is NULL for every launch that
      // has not been measured yet.
      id: String(row.launch_row_id),
      tokenAddress: String(row.launch_token_address),
      name: String(row.launch_name),
      symbol: String(row.launch_symbol),
      variant: row.launch_variant as 'asset' | 'stablecoin',
      decimals:
        row.launch_decimals === null || row.launch_decimals === undefined
          ? null
          : Number(row.launch_decimals),
      blockNumber: String(row.launch_block),
      transactionHash: String(row.launch_transaction_hash),
      logIndex: Number(row.launch_log_index),
      detectedAt: isoV1(row.launch_detected_at),
      blockTimestamp:
        row.launch_block_timestamp === null || row.launch_block_timestamp === undefined
          ? null
          : isoV1(row.launch_block_timestamp),
      canonical: Boolean(row.launch_canonical),
    },
    observation: row.state ? rowToObservationV1(row) : null,
    // Null when nobody has measured the window yet — which is NOT the same as
    // "nobody bought". A measured-and-empty window stores a row with a zero
    // count, and only that row means nobody bought.
    launchBuyers:
      row.buyer_count === null || row.buyer_count === undefined
        ? null
        : {
            buyerCount: Number(row.buyer_count),
            topBuyerShareBps: numberOrNullV1(row.top_buyer_share_bps),
            topThreeShareBps: numberOrNullV1(row.top_three_share_bps),
            fromBlock: String(row.buyers_from_block),
            toBlock: String(row.buyers_to_block),
          },
  };
}
