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
  type B20MoverPairRowV1,
  type B20FeedRowV1,
  type B20ObservationInsertResultV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
  B20_MEASURE_RUN_WINDOW_MS_V1,
  type B20PipelineCountsV1,
} from './b20Observations.js';
import { B20_MEASUREMENT_BACKOFF_V1, b20ReMeasureIntervalMsV1 } from './b20MeasurementBackoff.js';
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
      // Newest first, so [0] is the observation the backoff is decided on and
      // the run of matching rows after it is the consecutive repeat count.
      const observations = [...this.observations.values()]
        .filter((row) => row.launchId === launch.id)
        .sort((left, right) => Date.parse(right.measuredAt) - Date.parse(left.measuredAt));
      const latest = observations[0] ?? null;
      const lastMeasuredAt = latest?.measuredAt ?? null;
      if (latest && lastMeasuredAt) {
        // The same policy the Postgres query applies, from the same module.
        // These two disagreeing is how three T65 bugs reached production.
        let repeats = 0;
        for (const row of observations) {
          if (row.state !== latest.state || (row.reasonCode ?? null) !== (latest.reasonCode ?? null)) break;
          repeats += 1;
        }
        const dueAfterMs = b20ReMeasureIntervalMsV1({
          state: latest.state,
          reasonCode: latest.reasonCode ?? null,
          repeats,
          backoff: { ...B20_MEASUREMENT_BACKOFF_V1, baseMs: input.minReMeasureIntervalMs },
        });
        if (now - Date.parse(lastMeasuredAt) < dueAfterMs) continue;
      }
      rows.push({
        launchId: launch.id,
        tokenAddress: launch.tokenAddress,
        blockNumber: launch.blockNumber,
        blockHash: launch.blockHash,
        detectedAt: launch.detectedAt,
        lastMeasuredAt,
      });
    }
    // NEWEST first. This was oldest-first, on the reasoning that a backlog
    // should drain in arrival order — which is right for a backfill and wrong
    // for a live feed. Discover lists launches newest-first, so the top of the
    // product's home screen was permanently the part the worker would reach
    // last: on 2026-08-10 the newest fifty canonical launches had ZERO
    // observations between them while 1,828 older ones were being ground
    // through at 200/hour.
    //
    // Starvation is what oldest-first was protecting against, and it is not a
    // real risk here: launches arrive at 8-28 an hour against a measurement
    // capacity of ~200, so the newest are covered within minutes and the rest
    // of the capacity walks backwards through the backlog. What this does give
    // up is the very oldest unmeasured launches, which now age out of
    // `maxLaunchAgeMs` unmeasured — an acceptable trade, because a six-day-old
    // launch nobody measured is not what a Discover feed is for.
    return rows
      .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
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
      // The in-memory feed has no launch-buyers store behind it, and null is
      // the honest value: nobody measured that window here. It is NOT "nobody
      // bought", which would be a row with a zero count.
      launchBuyers: null,
    };
  }

  /**
   * T73 §3 — the same pairing rule the database applies.
   *
   * The in-memory store must not be kinder than Postgres: the baseline is the
   * observation NEAREST the target age within tolerance, not merely the newest
   * one older than it, and a launch with no compatible baseline returns null
   * rather than being dropped.
   */
  async listMoverPairs(input: {
    limit: number;
    now: string;
    baselineAgeMs: number;
    baselineToleranceMs: number;
    maxLaunchAgeMs: number;
    measurementVersions?: readonly string[];
  }): Promise<B20MoverPairRowV1[]> {
    const versions = input.measurementVersions ?? [B20_MEASUREMENT_VERSION_V1];
    const limit = Math.max(1, Math.min(100, input.limit));
    const now = Date.parse(input.now);
    const pairs: B20MoverPairRowV1[] = [];

    for (const launch of await this.canonicalLaunches()) {
      if (now - Date.parse(launch.detectedAt) > input.maxLaunchAgeMs) continue;
      const latest = this.latestFor(launch.id, versions);
      if (!latest) continue;

      const latestAt = Date.parse(latest.measuredAt);
      const target = latestAt - input.baselineAgeMs;
      const candidates = [...this.observations.values()]
        .filter(
          (entry) =>
            entry.launchId === launch.id &&
            entry.id !== latest.id &&
            entry.measurementVersion === latest.measurementVersion &&
            Math.abs(Date.parse(entry.measuredAt) - target) <= input.baselineToleranceMs,
        )
        .sort((left, right) => {
          const a = Math.abs(Date.parse(left.measuredAt) - target);
          const b = Math.abs(Date.parse(right.measuredAt) - target);
          return a === b ? left.id.localeCompare(right.id) : a - b;
        });

      pairs.push({
        launch: {
          id: launch.id,
          tokenAddress: launch.tokenAddress,
          name: launch.name,
          symbol: launch.symbol,
          variant: launch.variant,
          decimals: launch.decimals,
          blockNumber: launch.blockNumber,
          canonical: launch.canonical,
        },
        latest,
        baseline: candidates[0] ?? null,
      });
    }

    pairs.sort((left, right) => {
      const a = BigInt(left.launch.blockNumber);
      const b = BigInt(right.launch.blockNumber);
      if (a !== b) return a > b ? -1 : 1;
      return right.launch.id.localeCompare(left.launch.id);
    });
    return pairs.slice(0, limit);
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
    const measuredAt = [...this.observations.values()]
      .map((row) => row.measuredAt)
      .sort((left, right) => Date.parse(right) - Date.parse(left));
    const newest = measuredAt[0];
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
      lastMeasurementRunAt: newest ?? null,
      // The same window the database uses. The fake must not disagree with
      // production about what "the last run" means, or a test that proves the
      // status is honest proves nothing.
      observationsLastRun:
        newest === undefined
          ? 0
          : measuredAt.filter((at) => Date.parse(newest) - Date.parse(at) <= B20_MEASURE_RUN_WINDOW_MS_V1).length,
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
