import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_DISCOVER_LANE_V1,
  RouteStorageConflictError,
  type B20DiscoverRepositoryV1,
  type B20DiscoverRunV1,
  type B20StoredLaunchV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T69-A §9/§12.23 — one contract, both repositories.
//
// The in-memory store is NOT allowed to be kinder than Postgres. Three
// production bugs in this codebase came from a fake that accepted what the
// database refuses, so every assertion below runs against both, and a
// disagreement fails the suite rather than surfacing in production.
//
// `breakWrites` is how each store is made to fail the way an outage would:
// in memory a flag, in Postgres a trigger that raises. Without it the two most
// important tests here — the ones that prove a failed write leaves NEITHER the
// cursor nor the launches behind — could only be written for one of them.
// ---------------------------------------------------------------------------

export interface B20DiscoverHarnessV1 {
  repository: B20DiscoverRepositoryV1;
  /** Make the next launch insert fail the way a database outage would. */
  breakWrites(): Promise<void>;
  healWrites(): Promise<void>;
}

const LANE = B20_DISCOVER_LANE_V1;
const OWNER = 'worker-a';
const T0 = '2026-08-03T00:00:00.000Z';

export const hashV1 = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;

export function launchFixtureV1(overrides: Partial<B20StoredLaunchV1> = {}): B20StoredLaunchV1 {
  const transactionHash = overrides.transactionHash ?? hashV1('1');
  const logIndex = overrides.logIndex ?? 0;
  return {
    id: `${transactionHash}:${logIndex}`,
    chainId: 8453,
    blockTimestamp: null,
    factoryAddress: LANE.factoryAddress,
    tokenAddress: '0xb200000000000000000000d6f666fe8b27595c01',
    variant: 'asset',
    name: 'o1 mascot',
    symbol: 'DINo1',
    decimals: 18,
    blockNumber: '1001',
    blockHash: hashV1('a'),
    transactionHash,
    transactionIndex: 2,
    logIndex,
    detectedAt: T0,
    confirmationCount: 12,
    decoderVersion: LANE.decoderVersion,
    canonical: true,
    nonCanonicalAt: null,
    createdAt: T0,
    ...overrides,
    // Identity is derived, never passed in independently of its parts.
    ...(overrides.id ? { id: overrides.id } : {}),
  };
}

export function runFixtureV1(overrides: Partial<B20DiscoverRunV1> = {}): B20DiscoverRunV1 {
  return {
    id: 'run-1',
    chainId: 8453,
    factoryAddress: LANE.factoryAddress,
    decoderVersion: LANE.decoderVersion,
    startedAt: T0,
    finishedAt: T0,
    startCursorBlock: '1000',
    endCursorBlock: '1100',
    confirmedHead: '2000',
    scannedFromBlock: '1001',
    scannedToBlock: '1100',
    launchesRead: 1,
    launchesInserted: 1,
    duplicates: 0,
    budgetExhausted: false,
    operatorState: null,
    errorCategory: null,
    result: 'success',
    ...overrides,
  };
}

/** Registers the whole contract against one implementation. */
export function describeB20DiscoverRepositoryV1(
  name: string,
  createHarness: () => Promise<B20DiscoverHarnessV1>,
): void {
  /** A cursor at 1000 with the lease already held, which is the state every
   * commit starts from. */
  async function leased(): Promise<B20DiscoverHarnessV1> {
    const harness = await createHarness();
    await harness.repository.initialiseCursor({ key: LANE, startBlock: '1000', now: T0 });
    const cursor = await harness.repository.acquireWorkerLease({
      key: LANE,
      owner: OWNER,
      now: T0,
      ttlMs: 600_000,
    });
    assert.ok(cursor, 'the lease must be free on a fresh lane');
    return harness;
  }

  describe(`${name}: the cursor advances only with what it actually read`, () => {
    test('a commit stores the launches and moves the cursor together', async () => {
      const { repository } = await leased();
      const result = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [launchFixtureV1({ blockNumber: '1050' })],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1(),
        now: T0,
      });
      assert.equal(result.committed, true);
      assert.equal(result.inserted, 1);
      assert.equal(result.cursor?.lastProcessedBlock, '1100');
      assert.equal(result.cursor?.lastProcessedBlockHash, hashV1('b'));
      assert.equal((await repository.listLaunches({ key: LANE, limit: 10 })).length, 1);
    });

    test('a range with no launches still advances the cursor', async () => {
      const { repository } = await leased();
      const result = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 0, launchesInserted: 0 }),
        now: T0,
      });
      assert.equal(result.committed, true);
      assert.equal(result.cursor?.lastProcessedBlock, '1100');
    });

    test('a failed write leaves neither the cursor nor the launches behind', async () => {
      // §12.9/§12.10. The two halves of one commit, and the only acceptable
      // partial outcome is none.
      const harness = await leased();
      await harness.breakWrites();
      await assert.rejects(
        harness.repository.commitRange({
          key: LANE,
          owner: OWNER,
          launches: [launchFixtureV1({ blockNumber: '1050' })],
          nextBlock: '1100',
          nextBlockHash: hashV1('b'),
          run: runFixtureV1(),
          now: T0,
        }),
      );
      await harness.healWrites();
      const cursor = await harness.repository.getCursor(LANE);
      assert.equal(cursor?.lastProcessedBlock, '1000', 'the cursor must not have moved');
      assert.equal((await harness.repository.listLaunches({ key: LANE, limit: 10 })).length, 0);
      assert.equal((await harness.repository.listRecentRuns({ key: LANE, limit: 10 })).length, 0);
    });

    test('the cursor never moves backwards through a commit', async () => {
      const { repository } = await leased();
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 0, launchesInserted: 0 }),
        now: T0,
      });
      await assert.rejects(
        repository.commitRange({
          key: LANE,
          owner: OWNER,
          launches: [],
          nextBlock: '1050',
          nextBlockHash: hashV1('c'),
          run: runFixtureV1({ id: 'run-2', startCursorBlock: '1100', endCursorBlock: '1100' }),
          now: T0,
        }),
        RouteStorageConflictError,
      );
      assert.equal((await repository.getCursor(LANE))?.lastProcessedBlock, '1100');
    });

    test('a launch beyond the block the cursor claims is refused', async () => {
      // Otherwise the cursor would say it finished block 1100 while carrying a
      // launch from 1200, and the rest of 1200 would never be read.
      const { repository } = await leased();
      await assert.rejects(
        repository.commitRange({
          key: LANE,
          owner: OWNER,
          launches: [launchFixtureV1({ blockNumber: '1200' })],
          nextBlock: '1100',
          nextBlockHash: hashV1('b'),
          run: runFixtureV1(),
          now: T0,
        }),
        RouteStorageConflictError,
      );
    });

    test('a cursor may not advance without the hash of the block it names', async () => {
      const { repository } = await leased();
      await assert.rejects(
        repository.commitRange({
          key: LANE,
          owner: OWNER,
          launches: [],
          nextBlock: '1100',
          nextBlockHash: '',
          run: runFixtureV1({ launchesRead: 0, launchesInserted: 0 }),
          now: T0,
        }),
        RouteStorageConflictError,
      );
    });
  });

  describe(`${name}: one log is one launch`, () => {
    test('the same transaction and log index is stored once', async () => {
      // §12.6. An endpoint that returns a log twice, or a range re-read after
      // a rewind, must cost one row — the identity is the log itself.
      const { repository } = await leased();
      const launch = launchFixtureV1({ blockNumber: '1050' });
      const result = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [launch, launch, launchFixtureV1({ blockNumber: '1060', transactionHash: hashV1('2') })],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 3, launchesInserted: 2 }),
        now: T0,
      });
      assert.equal(result.inserted, 2, 'the repeated log is not stored twice');
      assert.equal(result.duplicates, 1);
      assert.equal((await repository.listLaunches({ key: LANE, limit: 10 })).length, 2);
    });

    test('one token launched twice is two records', async () => {
      // §12.7. Identity is the LOG, never the token: two events are two facts,
      // and collapsing them would hide a relaunch entirely.
      const { repository } = await leased();
      const result = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [
          launchFixtureV1({ blockNumber: '1050', transactionHash: hashV1('1'), logIndex: 0 }),
          launchFixtureV1({ blockNumber: '1060', transactionHash: hashV1('2'), logIndex: 4 }),
        ],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 2, launchesInserted: 2 }),
        now: T0,
      });
      assert.equal(result.inserted, 2);
      const stored = await repository.listLaunches({ key: LANE, limit: 10 });
      assert.equal(stored.length, 2);
      assert.equal(new Set(stored.map((launch) => launch.tokenAddress)).size, 1);
    });

    test('two logs in one transaction are two launches', async () => {
      const { repository } = await leased();
      const result = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [
          launchFixtureV1({ blockNumber: '1050', logIndex: 0 }),
          launchFixtureV1({ blockNumber: '1050', logIndex: 1 }),
        ],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 2, launchesInserted: 2 }),
        now: T0,
      });
      assert.equal(result.inserted, 2);
    });
  });

  describe(`${name}: only one worker owns a cursor`, () => {
    test('a second worker cannot take a held lease', async () => {
      // §12.18. Two workers advancing one cursor independently is how a range
      // gets skipped by exactly the amount the other one read.
      const { repository } = await leased();
      const second = await repository.acquireWorkerLease({
        key: LANE,
        owner: 'worker-b',
        now: T0,
        ttlMs: 600_000,
      });
      assert.equal(second, null);
    });

    test('the same worker may re-take its own lease', async () => {
      const { repository } = await leased();
      const again = await repository.acquireWorkerLease({
        key: LANE,
        owner: OWNER,
        now: T0,
        ttlMs: 600_000,
      });
      assert.ok(again);
    });

    test('an expired lease is available again, so a crashed worker cannot block forever', async () => {
      const { repository } = await leased();
      const later = new Date(Date.parse(T0) + 700_000).toISOString();
      const second = await repository.acquireWorkerLease({
        key: LANE,
        owner: 'worker-b',
        now: later,
        ttlMs: 600_000,
      });
      assert.ok(second);
      assert.equal(second.leaseOwner, 'worker-b');
    });

    test('a released lease is free immediately', async () => {
      const { repository } = await leased();
      await repository.releaseWorkerLease({ key: LANE, owner: OWNER, now: T0 });
      const second = await repository.acquireWorkerLease({
        key: LANE,
        owner: 'worker-b',
        now: T0,
        ttlMs: 600_000,
      });
      assert.ok(second);
    });

    test('another worker cannot release a lease it does not hold', async () => {
      const { repository } = await leased();
      await repository.releaseWorkerLease({ key: LANE, owner: 'worker-b', now: T0 });
      const cursor = await repository.getCursor(LANE);
      assert.equal(cursor?.leaseOwner, OWNER);
    });

    test('a worker without the lease writes nothing at all', async () => {
      const { repository } = await leased();
      const result = await repository.commitRange({
        key: LANE,
        owner: 'worker-b',
        launches: [launchFixtureV1({ blockNumber: '1050' })],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1(),
        now: T0,
      });
      assert.equal(result.committed, false);
      assert.equal((await repository.getCursor(LANE))?.lastProcessedBlock, '1000');
      assert.equal((await repository.listLaunches({ key: LANE, limit: 10 })).length, 0);
    });
  });

  describe(`${name}: a cursor is created once and never re-bootstrapped`, () => {
    test('an existing cursor survives a different configured start block', async () => {
      // §12.12. Configuration bootstraps a lane; it does not move a live one.
      const { repository } = await createHarness();
      await repository.initialiseCursor({ key: LANE, startBlock: '1000', now: T0 });
      const again = await repository.initialiseCursor({ key: LANE, startBlock: '5000', now: T0 });
      assert.equal(again.lastProcessedBlock, '1000');
    });

    test('a fresh cursor has no block hash, which is why a cold start is not a reorg', async () => {
      const { repository } = await createHarness();
      const cursor = await repository.initialiseCursor({ key: LANE, startBlock: '1000', now: T0 });
      assert.equal(cursor.lastProcessedBlockHash, null);
      assert.equal(cursor.operatorState, null);
    });

    test('a missing lane has no cursor rather than an implied one', async () => {
      const { repository } = await createHarness();
      assert.equal(await repository.getCursor(LANE), null);
    });
  });

  describe(`${name}: failures are recorded as failures`, () => {
    test('a failed run is stored and the cursor stays where it was', async () => {
      // §12.13/§12.14. "The endpoint was down" and "the chain was quiet" must
      // not be the same row.
      const { repository } = await leased();
      await repository.recordFailedRun({
        key: LANE,
        operatorState: 'endpoint_unavailable',
        run: runFixtureV1({
          id: 'run-fail',
          result: 'endpoint_unavailable',
          endCursorBlock: '1000',
          launchesRead: 0,
          launchesInserted: 0,
          scannedFromBlock: null,
          scannedToBlock: null,
          confirmedHead: null,
          errorCategory: 'endpoint_unavailable',
          operatorState: 'endpoint_unavailable',
        }),
      });
      const cursor = await repository.getCursor(LANE);
      assert.equal(cursor?.lastProcessedBlock, '1000');
      assert.equal(cursor?.operatorState, 'endpoint_unavailable');
      const runs = await repository.listRecentRuns({ key: LANE, limit: 10 });
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.result, 'endpoint_unavailable');
    });

    test('a later successful commit clears the operator state', async () => {
      const { repository } = await leased();
      await repository.recordFailedRun({
        key: LANE,
        operatorState: 'endpoint_unavailable',
        run: runFixtureV1({
          id: 'run-fail',
          result: 'endpoint_unavailable',
          endCursorBlock: '1000',
          launchesRead: 0,
          launchesInserted: 0,
          operatorState: 'endpoint_unavailable',
        }),
      });
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ id: 'run-ok', launchesRead: 0, launchesInserted: 0 }),
        now: T0,
      });
      assert.equal((await repository.getCursor(LANE))?.operatorState, null);
    });

    test('recording the same failed run twice records it once', async () => {
      const { repository } = await leased();
      const run = runFixtureV1({
        id: 'run-fail',
        result: 'decoder_mismatch',
        endCursorBlock: '1000',
        launchesRead: 0,
        launchesInserted: 0,
        operatorState: 'decoder_mismatch',
      });
      await repository.recordFailedRun({ key: LANE, run, operatorState: 'decoder_mismatch' });
      await repository.recordFailedRun({ key: LANE, run, operatorState: 'decoder_mismatch' });
      assert.equal((await repository.listRecentRuns({ key: LANE, limit: 10 })).length, 1);
    });
  });

  describe(`${name}: a reorg takes back what the chain took back`, () => {
    test('a rewind moves the cursor back and marks the affected launches', async () => {
      // §12.17. Silently keeping a launch from a block that no longer exists
      // would leave a token in the feed that the chain never produced.
      const { repository } = await leased();
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [
          launchFixtureV1({ blockNumber: '1010', transactionHash: hashV1('1') }),
          launchFixtureV1({ blockNumber: '1090', transactionHash: hashV1('2') }),
        ],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ launchesRead: 2, launchesInserted: 2 }),
        now: T0,
      });
      const result = await repository.rewindForReorg({
        key: LANE,
        owner: OWNER,
        rewindToBlock: '1050',
        rewindToBlockHash: hashV1('d'),
        run: runFixtureV1({
          id: 'run-reorg',
          result: 'reorg_rewound',
          startCursorBlock: '1100',
          endCursorBlock: '1050',
          launchesRead: 0,
          launchesInserted: 0,
          operatorState: 'reorg_rewound',
        }),
        now: T0,
      });
      assert.equal(result.rewound, true);
      assert.equal(result.markedNonCanonical, 1, 'only the launch above the rewind point');
      assert.equal(result.cursor?.lastProcessedBlock, '1050');
      assert.equal(result.cursor?.operatorState, 'reorg_rewound');

      const canonical = await repository.listLaunches({ key: LANE, limit: 10 });
      assert.deepEqual(canonical.map((launch) => launch.blockNumber), ['1010']);
      const all = await repository.listLaunches({ key: LANE, limit: 10, includeNonCanonical: true });
      assert.equal(all.length, 2, 'the reorged-out launch is kept as evidence, not deleted');
      const removed = all.find((launch) => launch.blockNumber === '1090');
      assert.equal(removed?.canonical, false);
      assert.ok(removed?.nonCanonicalAt);
    });

    test('a rewind without the lease changes nothing', async () => {
      const { repository } = await leased();
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [launchFixtureV1({ blockNumber: '1090' })],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1(),
        now: T0,
      });
      const result = await repository.rewindForReorg({
        key: LANE,
        owner: 'worker-b',
        rewindToBlock: '1050',
        rewindToBlockHash: hashV1('d'),
        run: runFixtureV1({
          id: 'run-reorg',
          result: 'reorg_rewound',
          startCursorBlock: '1100',
          endCursorBlock: '1050',
          launchesRead: 0,
          launchesInserted: 0,
        }),
        now: T0,
      });
      assert.equal(result.rewound, false);
      assert.equal(result.markedNonCanonical, 0);
      assert.equal((await repository.getCursor(LANE))?.lastProcessedBlock, '1100');
      assert.equal((await repository.listLaunches({ key: LANE, limit: 10 })).length, 1);
    });

    test('re-reading a rewound range restores the launch rather than duplicating it', async () => {
      const { repository } = await leased();
      const launch = launchFixtureV1({ blockNumber: '1090' });
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [launch],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1(),
        now: T0,
      });
      await repository.rewindForReorg({
        key: LANE,
        owner: OWNER,
        rewindToBlock: '1050',
        rewindToBlockHash: hashV1('d'),
        run: runFixtureV1({
          id: 'run-reorg',
          result: 'reorg_rewound',
          startCursorBlock: '1100',
          endCursorBlock: '1050',
          launchesRead: 0,
          launchesInserted: 0,
        }),
        now: T0,
      });
      const again = await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches: [launch],
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1({ id: 'run-3', startCursorBlock: '1050' }),
        now: T0,
      });
      // The identity is the log, so the row is not written twice. It stays
      // marked non-canonical until something re-establishes it — this task
      // does not, and pretending otherwise would be a fact nobody measured.
      assert.equal(again.inserted, 0);
      assert.equal(again.duplicates, 1);
      assert.equal(
        (await repository.listLaunches({ key: LANE, limit: 10, includeNonCanonical: true })).length,
        1,
      );
    });
  });

  describe(`${name}: a repeated run is idempotent`, () => {
    test('committing the same range twice stores one copy and lands on one cursor', async () => {
      // §12.19. The property that makes this safe on a timer.
      const { repository } = await leased();
      const launches = [launchFixtureV1({ blockNumber: '1050' })];
      await repository.commitRange({
        key: LANE,
        owner: OWNER,
        launches,
        nextBlock: '1100',
        nextBlockHash: hashV1('b'),
        run: runFixtureV1(),
        now: T0,
      });
      // The second attempt cannot move the cursor forward, so it is refused
      // outright rather than silently writing a second run row against a
      // cursor that is already past it.
      await assert.rejects(
        repository.commitRange({
          key: LANE,
          owner: OWNER,
          launches,
          nextBlock: '1100',
          nextBlockHash: hashV1('b'),
          run: runFixtureV1({ id: 'run-2' }),
          now: T0,
        }),
        RouteStorageConflictError,
      );
      assert.equal((await repository.listLaunches({ key: LANE, limit: 10 })).length, 1);
      assert.equal((await repository.getCursor(LANE))?.lastProcessedBlock, '1100');
      assert.equal((await repository.listRecentRuns({ key: LANE, limit: 10 })).length, 1);
    });
  });
}
