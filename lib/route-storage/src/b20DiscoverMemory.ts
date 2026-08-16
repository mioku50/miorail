import {
  assertDiscoverCursorV1,
  assertDiscoverRunV1,
  assertStoredLaunchV1,
  discoverBackfillRefusalV1,
  discoverCommitRefusalV1,
  discoverConflictV1,
  discoverCursorIdV1,
  type B20DiscoverCommitResultV1,
  type B20DiscoverCursorV1,
  type B20DiscoverRepositoryV1,
  type B20DiscoverRewindResultV1,
  type B20DiscoverRunV1,
  type B20StoredLaunchV1,
} from './b20Discover.js';

/**
 * The in-memory discover store.
 *
 * NOT a convenience fake. Every refusal Postgres makes is made here too: the
 * same launch identity, the same monotonic cursor, the same lease semantics,
 * the same all-or-nothing commit. Three production bugs in this codebase came
 * from an in-memory repository that accepted what the database refuses, so the
 * contract test in `test/b20Discover.contract.ts` runs against both and the
 * two must answer identically.
 *
 * The one thing a Map cannot reproduce is a crash halfway through a commit.
 * That is why `commitRange` here builds everything it intends to write, checks
 * every refusal, and only then mutates — a partially applied commit is not
 * reachable rather than merely unlikely.
 */
export class InMemoryB20DiscoverRepositoryV1 implements B20DiscoverRepositoryV1 {
  private readonly cursors = new Map<string, B20DiscoverCursorV1>();
  /** Keyed by launch identity, exactly like the unique index. */
  private readonly launches = new Map<string, B20StoredLaunchV1>();
  private readonly runs: B20DiscoverRunV1[] = [];

  /** Test seam: make the next write fail the way a database outage would, so
   * "neither the cursor nor the launches became durable" is testable. */
  failNextWrite: string | null = null;

  async getCursor(key: { chainId: number; factoryAddress: string; decoderVersion: string }) {
    return this.cursors.get(discoverCursorIdV1(key)) ?? null;
  }

  async initialiseCursor(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    startBlock: string;
    now: string;
  }): Promise<B20DiscoverCursorV1> {
    const id = discoverCursorIdV1(input.key);
    const existing = this.cursors.get(id);
    // An existing cursor always wins over configuration. A start block that
    // moved a live cursor would re-read or, far worse, skip everything between.
    if (existing) return existing;
    const cursor = assertDiscoverCursorV1(
      {
        id,
        chainId: input.key.chainId,
        factoryAddress: input.key.factoryAddress,
        decoderVersion: input.key.decoderVersion,
        lastProcessedBlock: input.startBlock,
        lastProcessedBlockHash: null,
        operatorState: null,
        lastRunId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
      'write',
    );
    this.cursors.set(id, cursor);
    return cursor;
  }

  async acquireWorkerLease(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    owner: string;
    now: string;
    ttlMs: number;
  }): Promise<B20DiscoverCursorV1 | null> {
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor) return null;
    const held =
      cursor.leaseOwner !== null &&
      cursor.leaseOwner !== input.owner &&
      cursor.leaseExpiresAt !== null &&
      Date.parse(cursor.leaseExpiresAt) > Date.parse(input.now);
    if (held) return null;
    const next = assertDiscoverCursorV1(
      {
        ...cursor,
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
        updatedAt: input.now,
      },
      'write',
    );
    this.cursors.set(id, next);
    return next;
  }

  async releaseWorkerLease(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    owner: string;
    now: string;
  }): Promise<void> {
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor || cursor.leaseOwner !== input.owner) return;
    this.cursors.set(
      id,
      assertDiscoverCursorV1({ ...cursor, leaseOwner: null, leaseExpiresAt: null, updatedAt: input.now }, 'write'),
    );
  }

  async commitRange(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    owner: string;
    launches: readonly B20StoredLaunchV1[];
    nextBlock: string;
    nextBlockHash: string;
    run: B20DiscoverRunV1;
    now: string;
  }): Promise<B20DiscoverCommitResultV1> {
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor) throw discoverConflictV1('No discover cursor exists for this lane');

    const run = assertDiscoverRunV1(input.run, 'write');
    const launches = input.launches.map((launch) => assertStoredLaunchV1(launch, 'write'));
    const refusal = discoverCommitRefusalV1({
      cursor,
      launches,
      nextBlock: input.nextBlock,
      nextBlockHash: input.nextBlockHash,
    });
    if (refusal) throw discoverConflictV1(refusal);

    const leaseHeld =
      cursor.leaseOwner === input.owner &&
      cursor.leaseExpiresAt !== null &&
      Date.parse(cursor.leaseExpiresAt) > Date.parse(input.now);
    if (!leaseHeld) {
      // Lost the lease. Nothing is written — reported rather than thrown,
      // because losing a race is an ordinary outcome for a timer job.
      return { committed: false, inserted: 0, duplicates: 0, cursor };
    }

    // Everything is decided before anything is mutated, so a refusal cannot
    // leave half a commit behind. The batch is de-duplicated against ITSELF as
    // well as against the store, because `ON CONFLICT DO NOTHING` counts a log
    // repeated inside one statement as one insert and this must agree.
    const fresh: B20StoredLaunchV1[] = [];
    const batch = new Set<string>();
    for (const launch of launches) {
      if (this.launches.has(launch.id) || batch.has(launch.id)) continue;
      batch.add(launch.id);
      fresh.push(launch);
    }
    if (this.failNextWrite) {
      const reason = this.failNextWrite;
      this.failNextWrite = null;
      // The database equivalent of a failed statement: cursor unchanged,
      // launches unstored, run unrecorded.
      throw new Error(reason);
    }

    for (const launch of fresh) this.launches.set(launch.id, launch);
    const next = assertDiscoverCursorV1(
      {
        ...cursor,
        lastProcessedBlock: input.nextBlock,
        lastProcessedBlockHash: input.nextBlockHash,
        operatorState: null,
        lastRunId: run.id,
        updatedAt: input.now,
      },
      'write',
    );
    this.cursors.set(id, next);
    this.runs.push(
      assertDiscoverRunV1(
        { ...run, launchesInserted: fresh.length, duplicates: launches.length - fresh.length },
        'write',
      ),
    );
    return { committed: true, inserted: fresh.length, duplicates: launches.length - fresh.length, cursor: next };
  }

  /**
   * Backfill of a range behind the cursor. No lease, no cursor movement.
   *
   * Refuses exactly what the database refuses — same rule function, same
   * self-dedupe. A fake that accepted a range the real repository rejects is
   * how three T65 bugs reached production: the tests passed against a twin that
   * was more permissive than Postgres.
   */
  async insertHistoricalLaunches(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    fromBlock: string;
    toBlock: string;
    launches: readonly B20StoredLaunchV1[];
    now: string;
  }): Promise<{ inserted: number; duplicates: number }> {
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor) throw discoverConflictV1('No discover cursor exists for this lane');

    const launches = input.launches.map((launch) => assertStoredLaunchV1(launch, 'write'));
    const refusal = discoverBackfillRefusalV1({
      cursor,
      launches,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
    });
    if (refusal) throw discoverConflictV1(refusal);

    const fresh: B20StoredLaunchV1[] = [];
    const batch = new Set<string>();
    for (const launch of launches) {
      if (this.launches.has(launch.id) || batch.has(launch.id)) continue;
      batch.add(launch.id);
      fresh.push(launch);
    }
    if (this.failNextWrite) {
      const reason = this.failNextWrite;
      this.failNextWrite = null;
      throw new Error(reason);
    }
    for (const launch of fresh) this.launches.set(launch.id, launch);
    return { inserted: fresh.length, duplicates: launches.length - fresh.length };
  }

  async recordFailedRun(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    run: B20DiscoverRunV1;
    operatorState: B20DiscoverCursorV1['operatorState'];
  }): Promise<void> {
    const run = assertDiscoverRunV1(input.run, 'write');
    if (this.runs.some((existing) => existing.id === run.id)) return;
    this.runs.push(run);
    if (!input.operatorState) return;
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor) return;
    // The block is deliberately untouched: a failed run read nothing.
    this.cursors.set(
      id,
      assertDiscoverCursorV1(
        { ...cursor, operatorState: input.operatorState, lastRunId: run.id, updatedAt: run.finishedAt },
        'write',
      ),
    );
  }

  async rewindForReorg(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    owner: string;
    rewindToBlock: string;
    rewindToBlockHash: string | null;
    run: B20DiscoverRunV1;
    now: string;
  }): Promise<B20DiscoverRewindResultV1> {
    const id = discoverCursorIdV1(input.key);
    const cursor = this.cursors.get(id);
    if (!cursor) throw discoverConflictV1('No discover cursor exists for this lane');
    const run = assertDiscoverRunV1(input.run, 'write');

    const leaseHeld =
      cursor.leaseOwner === input.owner &&
      cursor.leaseExpiresAt !== null &&
      Date.parse(cursor.leaseExpiresAt) > Date.parse(input.now);
    const backwards = BigInt(input.rewindToBlock) < BigInt(cursor.lastProcessedBlock);
    if (!leaseHeld || !backwards) return { rewound: false, markedNonCanonical: 0, cursor };

    let marked = 0;
    for (const [key, launch] of this.launches) {
      if (!launch.canonical) continue;
      if (launch.chainId !== input.key.chainId) continue;
      if (launch.factoryAddress !== input.key.factoryAddress) continue;
      if (launch.decoderVersion !== input.key.decoderVersion) continue;
      if (BigInt(launch.blockNumber) <= BigInt(input.rewindToBlock)) continue;
      // Kept, not deleted. "We saw this and the chain took it back" is itself
      // a fact, and one worth being able to look at later.
      this.launches.set(key, assertStoredLaunchV1({ ...launch, canonical: false, nonCanonicalAt: input.now }, 'write'));
      marked += 1;
    }

    const next = assertDiscoverCursorV1(
      {
        ...cursor,
        lastProcessedBlock: input.rewindToBlock,
        lastProcessedBlockHash: input.rewindToBlockHash,
        operatorState: 'reorg_rewound',
        lastRunId: run.id,
        updatedAt: input.now,
      },
      'write',
    );
    this.cursors.set(id, next);
    this.runs.push(run);
    return { rewound: true, markedNonCanonical: marked, cursor: next };
  }

  async listRecentRuns(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    limit: number;
  }): Promise<B20DiscoverRunV1[]> {
    return this.runs
      .filter(
        (run) =>
          run.chainId === input.key.chainId &&
          run.factoryAddress === input.key.factoryAddress &&
          run.decoderVersion === input.key.decoderVersion,
      )
      .sort((left, right) => {
        const byTime = Date.parse(right.startedAt) - Date.parse(left.startedAt);
        return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
      })
      .slice(0, Math.max(1, Math.min(200, input.limit)));
  }

  async listLaunches(input: {
    key: { chainId: 8453; factoryAddress: string; decoderVersion: string };
    limit: number;
    includeNonCanonical?: boolean;
  }): Promise<B20StoredLaunchV1[]> {
    return [...this.launches.values()]
      .filter(
        (launch) =>
          launch.chainId === input.key.chainId &&
          launch.factoryAddress === input.key.factoryAddress &&
          launch.decoderVersion === input.key.decoderVersion &&
          (input.includeNonCanonical === true || launch.canonical),
      )
      .sort((left, right) => {
        const byBlock = Number(BigInt(right.blockNumber) - BigInt(left.blockNumber));
        return byBlock !== 0 ? byBlock : right.logIndex - left.logIndex;
      })
      .slice(0, Math.max(1, Math.min(1_000, input.limit)));
  }
}
