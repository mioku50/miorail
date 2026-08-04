import {
  B20_MEASURE_LANE_V1,
  assertObservationV1,
  observationConflictV1,
  type B20MeasurableLaunchV1,
  type B20MeasureLeaseV1,
  type B20ObservationInsertResultV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
} from './b20Observations.js';
import type { InMemoryB20DiscoverRepositoryV1 } from './b20DiscoverMemory.js';

/**
 * The in-memory observation store.
 *
 * Same immutability, same identity and same conflict rule as Postgres. It reads
 * launches from the in-memory discover repository so the two halves of the
 * feed behave like one database in tests — a fake that could measure a launch
 * the real query would never return would test nothing.
 */
export class InMemoryB20ObservationRepositoryV1 implements B20ObservationRepositoryV1 {
  private readonly observations = new Map<string, B20OpportunityObservationV1>();
  private lease: B20MeasureLeaseV1 = {
    id: B20_MEASURE_LANE_V1,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastRunId: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };

  /** Test seam: fail the next write the way a database outage would. */
  failNextWrite: string | null = null;

  constructor(private readonly launches: InMemoryB20DiscoverRepositoryV1) {}

  async selectMeasurableLaunches(input: {
    limit: number;
    maxLaunchAgeMs: number;
    minReMeasureIntervalMs: number;
    now: string;
  }): Promise<B20MeasurableLaunchV1[]> {
    const now = Date.parse(input.now);
    // `includeNonCanonical` is deliberately NOT passed. A launch the chain took
    // back is not a token anybody should be shown a measurement of.
    const canonical = await this.launches.listLaunches({
      key: {
        chainId: 8453,
        factoryAddress: '0xb20f000000000000000000000000000000000000',
        decoderVersion: 'b20-created/v1',
      },
      limit: 500,
    });

    const rows: B20MeasurableLaunchV1[] = [];
    for (const launch of canonical) {
      const detected = Date.parse(launch.detectedAt);
      if (now - detected > input.maxLaunchAgeMs) continue;
      const observations = [...this.observations.values()].filter((row) => row.launchId === launch.id);
      const lastMeasuredAt = observations.length
        ? observations
            .map((row) => row.measuredAt)
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!
        : null;
      if (lastMeasuredAt && now - Date.parse(lastMeasuredAt) < input.minReMeasureIntervalMs) continue;
      rows.push({
        launchId: launch.id,
        tokenAddress: launch.tokenAddress,
        blockNumber: launch.blockNumber,
        blockHash: launch.blockHash,
        detectedAt: launch.detectedAt,
        lastMeasuredAt,
      });
    }
    // Oldest unmeasured first, so a backlog drains in the order it arrived
    // rather than starving whatever happens to sort last.
    return rows
      .sort((left, right) => Date.parse(left.detectedAt) - Date.parse(right.detectedAt))
      .slice(0, Math.max(1, Math.min(500, input.limit)));
  }

  async insertObservation(observation: B20OpportunityObservationV1): Promise<B20ObservationInsertResultV1> {
    const parsed = assertObservationV1(observation, 'write');
    const existing = this.observations.get(parsed.id);
    if (existing) {
      // Identical evidence is an ordinary retry. Different evidence under one
      // identity is two disagreeing measurements of the same block, and neither
      // wins by arriving second.
      if (existing.evidenceHash !== parsed.evidenceHash) {
        throw observationConflictV1(
          'A different observation already exists for this launch, block, version and profile',
        );
      }
      return { observation: existing, inserted: false };
    }
    if (this.failNextWrite) {
      const reason = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(reason);
    }
    this.observations.set(parsed.id, parsed);
    return { observation: parsed, inserted: true };
  }

  async getObservation(id: string): Promise<B20OpportunityObservationV1 | null> {
    return this.observations.get(id) ?? null;
  }

  async listObservationsForLaunch(input: {
    launchId: string;
    limit: number;
  }): Promise<B20OpportunityObservationV1[]> {
    return [...this.observations.values()]
      .filter((row) => row.launchId === input.launchId)
      .sort((left, right) => Date.parse(right.measuredAt) - Date.parse(left.measuredAt))
      .slice(0, Math.max(1, Math.min(200, input.limit)));
  }

  async listRecentObservations(input: { limit: number }): Promise<B20OpportunityObservationV1[]> {
    return [...this.observations.values()]
      .sort((left, right) => Date.parse(right.measuredAt) - Date.parse(left.measuredAt))
      .slice(0, Math.max(1, Math.min(200, input.limit)));
  }

  async acquireMeasureLease(input: {
    owner: string;
    now: string;
    ttlMs: number;
  }): Promise<B20MeasureLeaseV1 | null> {
    const held =
      this.lease.leaseOwner !== null &&
      this.lease.leaseOwner !== input.owner &&
      this.lease.leaseExpiresAt !== null &&
      Date.parse(this.lease.leaseExpiresAt) > Date.parse(input.now);
    if (held) return null;
    this.lease = {
      ...this.lease,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
      updatedAt: input.now,
    };
    return this.lease;
  }

  async releaseMeasureLease(input: { owner: string; now: string }): Promise<void> {
    if (this.lease.leaseOwner !== input.owner) return;
    this.lease = { ...this.lease, leaseOwner: null, leaseExpiresAt: null, updatedAt: input.now };
  }
}
