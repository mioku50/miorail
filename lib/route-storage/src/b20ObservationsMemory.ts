import {
  B20_MEASUREMENT_VERSION_V1,
  B20_MEASURE_LANE_V1,
  assertObservationV1,
  decodeFeedCursorV1,
  encodeFeedCursorV1,
  observationConflictV1,
  type B20MeasurableLaunchV1,
  type B20MeasureLeaseV1,
  type B20FeedPageV1,
  type B20FeedRowV1,
  type B20ObservationInsertResultV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
  type B20PipelineCountsV1,
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

  /** The latest supported observation for a launch, under the same
   * deterministic ordering Postgres uses. */
  private latestFor(launchId: string, versions: readonly string[]): B20OpportunityObservationV1 | null {
    const candidates = [...this.observations.values()].filter(
      (row) => row.launchId === launchId && versions.includes(row.measurementVersion),
    );
    if (candidates.length === 0) return null;
    return candidates.sort((left, right) => {
      const byTime = Date.parse(right.measuredAt) - Date.parse(left.measuredAt);
      if (byTime !== 0) return byTime;
      const byBlock = Number(BigInt(right.observationBlockNumber) - BigInt(left.observationBlockNumber));
      if (byBlock !== 0) return byBlock;
      // A total order, so "the latest" is never planner-dependent.
      return right.id.localeCompare(left.id);
    })[0]!;
  }

  private async canonicalLaunches(): Promise<
    Awaited<ReturnType<InMemoryB20DiscoverRepositoryV1['listLaunches']>>
  > {
    return this.launches.listLaunches({
      key: {
        chainId: 8453,
        factoryAddress: '0xb20f000000000000000000000000000000000000',
        decoderVersion: 'b20-created/v1',
      },
      limit: 500,
    });
  }

  private rowFor(
    launch: Awaited<ReturnType<InMemoryB20DiscoverRepositoryV1['listLaunches']>>[number],
    versions: readonly string[],
  ): B20FeedRowV1 {
    return {
      launch: {
        id: launch.id,
        tokenAddress: launch.tokenAddress,
        name: launch.name,
        symbol: launch.symbol,
        variant: launch.variant,
        decimals: launch.decimals,
        blockNumber: launch.blockNumber,
        transactionHash: launch.transactionHash,
        logIndex: launch.logIndex,
        detectedAt: launch.detectedAt,
        blockTimestamp: launch.blockTimestamp ?? null,
        canonical: launch.canonical,
      },
      observation: this.latestFor(launch.id, versions),
    };
  }

  async listFeed(input: {
    limit: number;
    cursor?: string | null;
    states?: readonly B20OpportunityObservationV1['state'][];
    maxLaunchAgeMs?: number | null;
    now: string;
    measurementVersions?: readonly string[];
  }): Promise<B20FeedPageV1> {
    const versions = input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1];
    const limit = Math.max(1, Math.min(100, input.limit));
    const now = Date.parse(input.now);
    // `listLaunches` already excludes non-canonical rows.
    const rows = (await this.canonicalLaunches())
      .filter((launch) => {
        if (input.maxLaunchAgeMs == null) return true;
        return now - Date.parse(launch.detectedAt) <= input.maxLaunchAgeMs;
      })
      .map((launch) => this.rowFor(launch, versions))
      .filter((row) => {
        if (!input.states || input.states.length === 0) return true;
        return row.observation !== null && input.states.includes(row.observation.state);
      })
      .sort((left, right) => compareFeedRowsV1(left, right));

    const after = input.cursor ? decodeFeedCursorV1(input.cursor) : null;
    const start = after
      ? rows.findIndex(
          (row) =>
            compareFeedKeysV1(
              {
                launchBlockNumber: row.launch.blockNumber,
                measuredAt: row.observation?.measuredAt ?? null,
                launchId: row.launch.id,
              },
              after,
            ) > 0,
        )
      : 0;
    const page = start < 0 ? [] : rows.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      rows: page,
      nextCursor:
        last && start >= 0 && start + limit < rows.length
          ? encodeFeedCursorV1({
              launchBlockNumber: last.launch.blockNumber,
              measuredAt: last.observation?.measuredAt ?? null,
              launchId: last.launch.id,
            })
          : null,
    };
  }

  async getFeedRowForToken(input: {
    tokenAddress: string;
    historyLimit: number;
    measurementVersions?: readonly string[];
  }): Promise<{ row: B20FeedRowV1; history: B20OpportunityObservationV1[] } | null> {
    const versions = input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1];
    const matches = (await this.canonicalLaunches())
      .filter((launch) => launch.tokenAddress === input.tokenAddress.toLowerCase())
      .sort((left, right) => Number(BigInt(right.blockNumber) - BigInt(left.blockNumber)));
    const launch = matches[0];
    if (!launch) return null;
    return {
      row: this.rowFor(launch, versions),
      history: await this.listObservationsForLaunch({ launchId: launch.id, limit: input.historyLimit }),
    };
  }

  async pipelineCounts(input: { now: string; maxLaunchAgeMs: number }): Promise<B20PipelineCountsV1> {
    const launches = await this.canonicalLaunches();
    const now = Date.parse(input.now);
    const inWindow = launches.filter((launch) => now - Date.parse(launch.detectedAt) <= input.maxLaunchAgeMs);
    const awaiting = inWindow.filter(
      (launch) => this.latestFor(launch.id, [B20_MEASUREMENT_VERSION_V1]) === null,
    ).length;
    const cursor = await this.launches.getCursor({
      chainId: 8453,
      factoryAddress: '0xb20f000000000000000000000000000000000000',
      decoderVersion: 'b20-created/v1',
    });
    const runs = await this.launches.listRecentRuns({
      key: {
        chainId: 8453,
        factoryAddress: '0xb20f000000000000000000000000000000000000',
        decoderVersion: 'b20-created/v1',
      },
      limit: 1,
    });
    const run = runs[0] ?? null;
    return {
      canonicalLaunchCount: launches.length,
      launchesAwaitingMeasurement: awaiting,
      observationCount: this.observations.size,
      ingestionCursorBlock: cursor?.lastProcessedBlock ?? null,
      ingestionOperatorState: cursor?.operatorState ?? null,
      lastIngestionRunAt: run?.finishedAt ?? null,
      lastIngestionResult: run?.result ?? null,
      lastIngestionConfirmedHead: run?.confirmedHead ?? null,
      lastIngestionBudgetExhausted: run?.budgetExhausted ?? false,
      lastMeasurementRunAt:
        [...this.observations.values()]
          .map((row) => row.measuredAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
    };
  }
}

/** The feed's ordering key, as a comparable tuple. Newest launch block first,
 * then newest measurement, then a stable id tie-break so the order is total. */
function compareFeedKeysV1(
  left: { launchBlockNumber: string; measuredAt: string | null; launchId: string },
  right: { launchBlockNumber: string; measuredAt: string | null; launchId: string },
): number {
  const byBlock = BigInt(right.launchBlockNumber) - BigInt(left.launchBlockNumber);
  if (byBlock !== 0n) return byBlock > 0n ? 1 : -1;
  const leftAt = left.measuredAt ? Date.parse(left.measuredAt) : -1;
  const rightAt = right.measuredAt ? Date.parse(right.measuredAt) : -1;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return right.launchId.localeCompare(left.launchId);
}

function compareFeedRowsV1(left: B20FeedRowV1, right: B20FeedRowV1): number {
  return compareFeedKeysV1(
    {
      launchBlockNumber: left.launch.blockNumber,
      measuredAt: left.observation?.measuredAt ?? null,
      launchId: left.launch.id,
    },
    {
      launchBlockNumber: right.launch.blockNumber,
      measuredAt: right.observation?.measuredAt ?? null,
      launchId: right.launch.id,
    },
  );
}
