import { RouteStorageConflictError, type SqlTemplateExecutor } from '@mioagent/route-storage';

import {
  MARKET_REALITY_RADAR_CAPACITY_V1,
  MarketRealityRadarEventV1Schema,
  MarketRealityRadarPointV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  MarketRealityRadarWatchV1Schema,
  marketRealityRadarPointBelongsToWatchV1,
  marketRealityRadarWatchIdV1,
  type MarketRealityRadarEventV1,
  type MarketRealityRadarPointV1,
  type MarketRealityRadarRepositoryV1,
  type MarketRealityRadarWatchV1,
} from './radar.js';

function jsonV1(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rowToWatchV1(row: Record<string, unknown>): MarketRealityRadarWatchV1 {
  return MarketRealityRadarWatchV1Schema.parse({
    watchId: row.watch_id,
    userId: row.user_id,
    chainId: Number(row.chain_id),
    underlyingKey: row.underlying_key,
    tokenAddress: row.token_address,
    issuerId: row.issuer_id,
    representationKind: row.representation_kind,
    direction: row.direction,
    requestedCashAtomic: row.requested_cash_atomic,
    destination: row.destination,
    routePolicyKey: row.route_policy_key,
    approvedSources: jsonV1(row.approved_sources),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastEvaluatedAt:
      row.last_evaluated_at === null
        ? null
        : new Date(String(row.last_evaluated_at)).toISOString(),
    lastComparableAt:
      row.last_comparable_at === null
        ? null
        : new Date(String(row.last_comparable_at)).toISOString(),
    lastEvaluationOutcome: row.last_evaluation_outcome,
  });
}

function rowToEventV1(row: Record<string, unknown>): MarketRealityRadarEventV1 {
  return MarketRealityRadarEventV1Schema.parse({
    eventId: row.event_id,
    watchId: row.watch_id,
    chainId: Number(row.chain_id),
    tokenAddress: row.token_address,
    kind: row.kind,
    previousSnapshotHash: row.previous_snapshot_hash,
    snapshotHash: row.snapshot_hash,
    previousObservedAt: new Date(String(row.previous_observed_at)).toISOString(),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
    approvedSources: jsonV1(row.approved_sources),
    facts: jsonV1(row.facts),
  });
}

export function createDatabaseMarketRealityRadarRepositoryV1(
  sql: SqlTemplateExecutor,
): MarketRealityRadarRepositoryV1 {
  return {
    async addWatch(input) {
      const question = MarketRealityRadarWatchInputV1Schema.parse({
        ...input.question,
        approvedSources: [...input.question.approvedSources].sort(),
      });
      const watchId = marketRealityRadarWatchIdV1(input.userId, question);
      const existing = (await sql`
        SELECT * FROM market_reality_radar_watches
         WHERE watch_id = ${watchId} AND user_id = ${input.userId}
         LIMIT 1`) as Record<string, unknown>[];
      if (existing[0]) return rowToWatchV1(existing[0]);

      // Slot allocation makes the per-tenant bound a database invariant, not
      // a count-then-insert race. A colliding concurrent insert retries with
      // the next newly visible free slot; an identical watch returns its row.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const rows = (await sql`
          WITH tenant_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0)) AS held
          ), available AS MATERIALIZED (
            SELECT candidate::smallint AS watch_slot
              FROM generate_series(1, ${MARKET_REALITY_RADAR_CAPACITY_V1}) candidate
              CROSS JOIN tenant_lock
             WHERE NOT EXISTS (
               SELECT 1 FROM market_reality_radar_watches occupied
                WHERE occupied.user_id = ${input.userId}
                  AND occupied.watch_slot = candidate
             )
             ORDER BY candidate ASC
             LIMIT 1
          )
          INSERT INTO market_reality_radar_watches (
            watch_id, user_id, watch_slot, chain_id, underlying_key, token_address,
            issuer_id, representation_kind, direction, requested_cash_atomic,
            destination, route_policy_key, approved_sources, created_at
          )
          SELECT
            ${watchId}, ${input.userId}, available.watch_slot, 8453,
            ${question.underlyingKey}, ${question.tokenAddress}, ${input.issuerId},
            ${input.representationKind}, ${question.direction},
            ${question.requestedCashAtomic}, ${question.destination},
            ${question.routePolicyKey}, ${JSON.stringify(question.approvedSources)}::text::jsonb,
            ${input.now}::timestamptz
          FROM available
          ON CONFLICT DO NOTHING
          RETURNING *`) as Record<string, unknown>[];
        if (rows[0]) return rowToWatchV1(rows[0]);
        const raced = (await sql`
          SELECT * FROM market_reality_radar_watches
           WHERE watch_id = ${watchId} AND user_id = ${input.userId}
           LIMIT 1`) as Record<string, unknown>[];
        if (raced[0]) return rowToWatchV1(raced[0]);
      }
      throw new RouteStorageConflictError(
        `Radar holds at most ${MARKET_REALITY_RADAR_CAPACITY_V1} exact market watches. Remove one to add another.`,
      );
    },

    async removeWatch(input) {
      const rows = (await sql`
        DELETE FROM market_reality_radar_watches
         WHERE watch_id = ${input.watchId} AND user_id = ${input.userId}
        RETURNING watch_id`) as Record<string, unknown>[];
      return rows.length > 0;
    },

    async watchesForUser(input) {
      const rows = (await sql`
        SELECT * FROM market_reality_radar_watches
         WHERE user_id = ${input.userId}
         ORDER BY created_at ASC, watch_id ASC`) as Record<string, unknown>[];
      return rows.map(rowToWatchV1);
    },

    async watchesForToken(input) {
      const rows = (await sql`
        SELECT * FROM market_reality_radar_watches
         WHERE chain_id = ${input.chainId}
           AND token_address = ${input.tokenAddress.toLowerCase()}
         ORDER BY created_at ASC, watch_id ASC`) as Record<string, unknown>[];
      return rows.map(rowToWatchV1);
    },

    async distinctWatchedAddresses(input) {
      const rows = (await sql`
        SELECT DISTINCT token_address
          FROM market_reality_radar_watches
         WHERE chain_id = ${input.chainId}
         ORDER BY token_address ASC
         LIMIT ${Math.max(1, Math.min(1_000, input.limit))}`) as Record<string, unknown>[];
      return rows.map((row) => String(row.token_address));
    },

    async pointForWatch(input) {
      const rows = (await sql`
        SELECT point FROM market_reality_radar_state
         WHERE watch_id = ${input.watchId}
         LIMIT 1`) as Record<string, unknown>[];
      return rows[0] ? MarketRealityRadarPointV1Schema.parse(jsonV1(rows[0].point)) : null;
    },

    async recordEvaluation(input) {
      const watch = MarketRealityRadarWatchV1Schema.parse(input.watch);
      const point: MarketRealityRadarPointV1 | null = input.point
        ? MarketRealityRadarPointV1Schema.parse(input.point)
        : null;
      const events = input.events.map((event) => MarketRealityRadarEventV1Schema.parse(event));
      const outcome = { recorded: [] as string[], alreadyRecorded: [] as string[] };
      const comparableOutcome = input.outcome === 'baseline' || input.outcome === 'compared';

      if (point && !marketRealityRadarPointBelongsToWatchV1(point, watch)) {
        throw new Error('Radar point does not belong to the evaluated watch');
      }
      if ((point !== null) !== comparableOutcome || (events.length > 0 && input.outcome !== 'compared')) {
        throw new Error('Radar evaluation outcome does not match its comparable evidence');
      }

      // Events first, cursor second. A process death between the two is safe:
      // the event ids deduplicate on retry, then the cursor catches up.
      for (const event of events) {
        if (
          event.watchId !== watch.watchId ||
          event.chainId !== watch.chainId ||
          event.tokenAddress !== watch.tokenAddress ||
          event.snapshotHash !== point?.snapshotHash ||
          event.occurredAt !== point?.observedAt ||
          [...event.approvedSources].sort().join('\u0000') !==
            [...watch.approvedSources].sort().join('\u0000')
        ) {
          throw new Error('Radar event does not belong to the evaluated watch');
        }
        const rows = (await sql`
          INSERT INTO market_reality_radar_events (
            event_id, watch_id, chain_id, token_address, kind,
            previous_snapshot_hash, snapshot_hash, previous_observed_at,
            occurred_at, approved_sources, facts, recorded_at
          ) VALUES (
            ${event.eventId}, ${event.watchId}, ${event.chainId}, ${event.tokenAddress},
            ${event.kind}, ${event.previousSnapshotHash}, ${event.snapshotHash},
            ${event.previousObservedAt}::timestamptz, ${event.occurredAt}::timestamptz,
            ${JSON.stringify(event.approvedSources)}::text::jsonb,
            ${JSON.stringify(event.facts)}::text::jsonb, ${input.at}::timestamptz
          )
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id`) as Record<string, unknown>[];
        (rows.length > 0 ? outcome.recorded : outcome.alreadyRecorded).push(event.eventId);
      }

      if (point) {
        await sql`
          INSERT INTO market_reality_radar_state (
            watch_id, point, snapshot_hash, observed_at, updated_at
          ) VALUES (
            ${watch.watchId}, ${JSON.stringify(point)}::text::jsonb, ${point.snapshotHash},
            ${point.observedAt}::timestamptz, ${input.at}::timestamptz
          )
          ON CONFLICT (watch_id) DO UPDATE SET
            point = EXCLUDED.point,
            snapshot_hash = EXCLUDED.snapshot_hash,
            observed_at = EXCLUDED.observed_at,
            updated_at = EXCLUDED.updated_at
          WHERE EXCLUDED.observed_at > market_reality_radar_state.observed_at`;
      }

      await sql`
        UPDATE market_reality_radar_watches
           SET last_evaluated_at = ${input.at}::timestamptz,
               last_comparable_at = CASE WHEN ${point !== null}
                 THEN ${point?.observedAt ?? null}::timestamptz
                 ELSE last_comparable_at END,
               last_evaluation_outcome = ${input.outcome}
         WHERE watch_id = ${watch.watchId}
           AND (last_evaluated_at IS NULL OR last_evaluated_at <= ${input.at}::timestamptz)`;
      return outcome;
    },

    async eventsForUser(input) {
      const rows = (await sql`
        SELECT e.*
          FROM market_reality_radar_events e
          JOIN market_reality_radar_watches w ON w.watch_id = e.watch_id
         WHERE w.user_id = ${input.userId}
         ORDER BY e.occurred_at DESC, e.event_id DESC
         LIMIT ${Math.max(1, Math.min(250, input.limit))}`) as Record<string, unknown>[];
      return rows.map(rowToEventV1);
    },
  };
}
