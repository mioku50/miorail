import {
  detectReorgV1,
  readB20LaunchesV1,
  type LaunchLogSourceV1,
} from '@mioagent/b20-control';
import {
  B20_DISCOVER_LANE_V1,
  discoverStartCursorV1,
  storedLaunchFromDecodedV1,
  type B20DiscoverCursorKeyV1,
  type B20DiscoverOperatorStateV1,
  type B20DiscoverRepositoryV1,
  type B20DiscoverRunResultV1,
  type B20DiscoverRunV1,
  type B20StoredLaunchV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// T69-A §3/§5/§6/§7/§8/§10 — one bounded ingestion pass.
//
// Every dependency is injected: the repository, the log source and the clock.
// Nothing in this file opens a socket, reads an environment variable or knows
// what an RPC URL looks like — that is `b20_discover.ts`'s job — so the whole
// state machine below is testable without a network or a database.
//
// THE RULE THIS FILE EXISTS TO KEEP: the cursor never passes a range that was
// not read AND stored. Every failure path releases the lease and leaves the
// cursor exactly where it was, and every success commits the launches and the
// cursor in one statement. A cursor that got ahead produces a gap nothing
// re-reads and nobody can see — a missing launch is indistinguishable from a
// quiet hour.
// ---------------------------------------------------------------------------

export interface DiscoverPassConfigV1 {
  maxRange: number;
  maxLaunches: number;
  confirmations: number;
  /** Blocks per `eth_getLogs` REQUEST. Separate from `maxRange`, which is how
   * much chain the whole pass covers — some endpoints refuse anything wider
   * than ten blocks per request. */
  logWindow: number;
  /** Wall clock for one pass. Past it the run commits what it already has and
   * reports the rest as not_checked. */
  maxRuntimeMs: number;
  /** §4 — the bootstrap block, used ONLY when no cursor exists. */
  startBlock: number | null;
  rewindDepth: number;
  leaseTtlMs: number;
}

export interface DiscoverPassOutcomeV1 {
  result: B20DiscoverRunResultV1;
  startCursorBlock: string | null;
  endCursorBlock: string | null;
  confirmedHead: string | null;
  scannedFromBlock: string | null;
  scannedToBlock: string | null;
  launchesRead: number;
  launchesInserted: number;
  duplicates: number;
  budgetExhausted: boolean;
  operatorState: B20DiscoverOperatorStateV1 | null;
  /** The decoder refusal, when the event shape is why this stopped. A
   * category — never a token, never an endpoint. */
  refusal: string | null;
  markedNonCanonical: number;
  /** §7 — safe counters for what the pass spent reading logs. */
  logWindowsAttempted: number;
  logWindowsCompleted: number;
  logsReceived: number;
}

export interface DiscoverPassInputV1 {
  repository: B20DiscoverRepositoryV1;
  source: LaunchLogSourceV1;
  config: DiscoverPassConfigV1;
  /** Identifies THIS process for the lease. Two workers must not share one. */
  owner: string;
  runId: string;
  now: () => Date;
  lane?: B20DiscoverCursorKeyV1;
}

export async function runB20DiscoverPassV1(input: DiscoverPassInputV1): Promise<DiscoverPassOutcomeV1> {
  const lane = input.lane ?? B20_DISCOVER_LANE_V1;
  const startedAt = input.now().toISOString();
  const deadline = Date.parse(startedAt) + input.config.maxRuntimeMs;

  const base = {
    startCursorBlock: null as string | null,
    endCursorBlock: null as string | null,
    confirmedHead: null as string | null,
    scannedFromBlock: null as string | null,
    scannedToBlock: null as string | null,
    launchesRead: 0,
    launchesInserted: 0,
    duplicates: 0,
    budgetExhausted: false,
    operatorState: null as B20DiscoverOperatorStateV1 | null,
    refusal: null as string | null,
    markedNonCanonical: 0,
    logWindowsAttempted: 0,
    logWindowsCompleted: 0,
    logsReceived: 0,
  };

  /** A run row that, by construction, cannot claim to have moved anything. */
  const inertRun = (
    result: B20DiscoverRunResultV1,
    cursorBlock: string,
    errorCategory: string | null,
    operatorState: B20DiscoverOperatorStateV1 | null,
    confirmedHead: string | null = null,
  ): B20DiscoverRunV1 => ({
    id: input.runId,
    ...lane,
    startedAt,
    finishedAt: input.now().toISOString(),
    startCursorBlock: cursorBlock,
    endCursorBlock: cursorBlock,
    confirmedHead,
    scannedFromBlock: null,
    scannedToBlock: null,
    launchesRead: 0,
    launchesInserted: 0,
    duplicates: 0,
    budgetExhausted: false,
    operatorState,
    errorCategory,
    result,
  });

  // --- §4: where to start, or whether to start at all ----------------------
  const existing = await input.repository.getCursor(lane);
  const start = discoverStartCursorV1({ cursor: existing, configuredStartBlock: input.config.startBlock });
  if (start.status === 'configuration_required') {
    // Deliberately NOT "start somewhere recent". A guess would silently define
    // away every launch before it, and nothing downstream could tell that from
    // a chain with no launches on it.
    await input.repository.recordFailedRun({
      key: lane,
      run: inertRun('configuration_required', '0', 'start_block_not_configured', null),
      operatorState: null,
    });
    return { ...base, result: 'configuration_required' };
  }

  const cursor =
    start.status === 'existing'
      ? start.cursor
      : await input.repository.initialiseCursor({ key: lane, startBlock: start.startBlock, now: startedAt });
  const cursorBlock = cursor.lastProcessedBlock;
  base.startCursorBlock = cursorBlock;
  base.endCursorBlock = cursorBlock;

  // --- §8: one worker owns a cursor ---------------------------------------
  const leased = await input.repository.acquireWorkerLease({
    key: lane,
    owner: input.owner,
    now: startedAt,
    ttlMs: input.config.leaseTtlMs,
  });
  if (!leased) {
    // Expected under a timer, not an error. It does NOT wait: a queued second
    // worker is a slower double read, not a safer one.
    await input.repository.recordFailedRun({
      key: lane,
      run: inertRun('run_already_active', cursorBlock, 'lease_held', null),
      operatorState: null,
    });
    return { ...base, result: 'run_already_active' };
  }

  try {
    // --- §5: does the chain still agree with what we stored? ---------------
    if (leased.lastProcessedBlockHash !== null) {
      const observed = await input.source.blockHash(Number(cursorBlock));
      if (observed === null) {
        await input.repository.recordFailedRun({
          key: lane,
          run: inertRun('endpoint_unavailable', cursorBlock, 'anchor_unavailable', 'endpoint_unavailable'),
          operatorState: 'endpoint_unavailable',
        });
        return { ...base, result: 'endpoint_unavailable', operatorState: 'endpoint_unavailable' };
      }
      const reorg = detectReorgV1({
        cursor: {
          lastProcessedBlock: Number(cursorBlock),
          lastProcessedBlockHash: leased.lastProcessedBlockHash,
        },
        observedHashAtCursor: observed,
      });
      if (reorg.status === 'reorg_detected') {
        return await rewindV1({ input, lane, cursorBlock, startedAt, base });
      }
    }

    // --- §7: the runtime budget, checked before spending more --------------
    if (input.now().getTime() > deadline) {
      await input.repository.recordFailedRun({
        key: lane,
        run: { ...inertRun('budget_exhausted', cursorBlock, 'runtime_budget', null), budgetExhausted: true },
        operatorState: null,
      });
      return { ...base, result: 'budget_exhausted', budgetExhausted: true };
    }

    // --- §1/§3: read a bounded window --------------------------------------
    const read = await readB20LaunchesV1({
      source: input.source,
      cursor: {
        lastProcessedBlock: Number(cursorBlock),
        lastProcessedBlockHash: leased.lastProcessedBlockHash,
      },
      maxRange: input.config.maxRange,
      maxLaunches: input.config.maxLaunches,
      confirmations: input.config.confirmations,
      logWindow: input.config.logWindow,
    });
    const confirmedHead = read.confirmedHead === null ? null : String(read.confirmedHead);
    base.confirmedHead = confirmedHead;
    // Safe counters, whatever the pass concluded — an operator needs to see a
    // window that never completed just as much as one that did.
    base.logWindowsAttempted = read.metrics.logWindowsAttempted;
    base.logWindowsCompleted = read.metrics.logWindowsCompleted;
    base.logsReceived = read.metrics.logsReceived;

    if (read.state.status === 'decoder_mismatch') {
      // §10. The event shape changed. Nothing from the refused range is stored,
      // the cursor does not move, and an operator has to look — because the
      // alternative is recording real tokens with guessed fields.
      await input.repository.recordFailedRun({
        key: lane,
        run: inertRun('decoder_mismatch', cursorBlock, read.state.refusal, 'decoder_mismatch', confirmedHead),
        operatorState: 'decoder_mismatch',
      });
      return {
        ...base,
        result: 'decoder_mismatch',
        operatorState: 'decoder_mismatch',
        refusal: read.state.refusal,
      };
    }

    if (read.state.status === 'endpoint_unavailable' || read.state.status === 'endpoint_shape') {
      // §10. NOT an empty range. Recorded as a failure so "the endpoint was
      // down" and "the chain was quiet" are different rows.
      const category = read.state.status === 'endpoint_shape' ? 'endpoint_shape' : `endpoint_${read.state.call}`;
      await input.repository.recordFailedRun({
        key: lane,
        run: inertRun('endpoint_unavailable', cursorBlock, category, 'endpoint_unavailable', confirmedHead),
        operatorState: 'endpoint_unavailable',
      });
      return { ...base, result: 'endpoint_unavailable', operatorState: 'endpoint_unavailable' };
    }

    const nextBlock = String(read.nextCursor.lastProcessedBlock);
    if (read.nextCursor.lastProcessedBlockHash === null || nextBlock === cursorBlock) {
      // Nothing past the confirmation window was finished. A real state, and a
      // common one: Base produces blocks faster than launches.
      await input.repository.recordFailedRun({
        key: lane,
        run: {
          ...inertRun('nothing_confirmed', cursorBlock, null, null, confirmedHead),
          budgetExhausted: read.budgetExhausted,
        },
        operatorState: null,
      });
      return { ...base, result: 'nothing_confirmed', budgetExhausted: read.budgetExhausted };
    }

    const detectedAt = input.now().toISOString();
    const launches: B20StoredLaunchV1[] = read.launches.map((launch) =>
      storedLaunchFromDecodedV1({
        launch,
        detectedAt,
        transactionIndex: launch.transactionIndex,
        // How far behind the head this actually was, so a shallow read is
        // visible in the row rather than inferred from a deploy date.
        confirmationCount: Math.max(
          0,
          (read.confirmedHead ?? Number(launch.blockNumber)) +
            input.config.confirmations -
            Number(launch.blockNumber),
        ),
      }),
    );

    const overBudget = input.now().getTime() > deadline;
    const budgetExhausted = read.budgetExhausted || overBudget;
    const result: B20DiscoverRunResultV1 = budgetExhausted ? 'budget_exhausted' : 'success';

    // §3 — the launches and the cursor, in one commit.
    const commit = await input.repository.commitRange({
      key: lane,
      owner: input.owner,
      launches,
      nextBlock,
      nextBlockHash: read.nextCursor.lastProcessedBlockHash,
      now: detectedAt,
      run: {
        id: input.runId,
        ...lane,
        startedAt,
        finishedAt: detectedAt,
        startCursorBlock: cursorBlock,
        endCursorBlock: nextBlock,
        confirmedHead,
        scannedFromBlock: read.scannedFrom === null ? null : String(read.scannedFrom),
        scannedToBlock: read.scannedTo === null ? null : String(read.scannedTo),
        launchesRead: launches.length,
        launchesInserted: launches.length,
        duplicates: 0,
        budgetExhausted,
        operatorState: null,
        errorCategory: null,
        result,
      },
    });

    if (!commit.committed) {
      // The lease was lost mid-pass, or another worker moved the cursor first.
      // Nothing was written. Reported honestly rather than retried, because a
      // retry here is exactly the double read the lease exists to prevent.
      await input.repository.recordFailedRun({
        key: lane,
        run: inertRun('run_already_active', cursorBlock, 'lease_lost', null, confirmedHead),
        operatorState: null,
      });
      return { ...base, result: 'run_already_active' };
    }

    return {
      ...base,
      result,
      endCursorBlock: nextBlock,
      confirmedHead,
      scannedFromBlock: read.scannedFrom === null ? null : String(read.scannedFrom),
      scannedToBlock: read.scannedTo === null ? null : String(read.scannedTo),
      launchesRead: launches.length,
      launchesInserted: commit.inserted,
      duplicates: commit.duplicates,
      budgetExhausted,
    };
  } finally {
    // Always. A crashed worker holding a lease would stop ingestion until the
    // TTL expired, and the TTL is a backstop rather than the mechanism.
    await input.repository.releaseWorkerLease({ key: lane, owner: input.owner, now: input.now().toISOString() });
  }
}

/** §5 — the chain disagreed with a stored hash. Go back, take back what the
 * chain took back, and re-read forward next pass. */
async function rewindV1(context: {
  input: DiscoverPassInputV1;
  lane: B20DiscoverCursorKeyV1;
  cursorBlock: string;
  startedAt: string;
  base: Omit<DiscoverPassOutcomeV1, 'result'>;
}): Promise<DiscoverPassOutcomeV1> {
  const { input, lane, cursorBlock, startedAt, base } = context;
  const rewindTo = String(Math.max(0, Number(cursorBlock) - input.config.rewindDepth));
  // Read the anchor for the block we are landing on. Null is acceptable here
  // and means "cold" — the next pass simply does not check for a reorg it has
  // no stored hash for, which is safer than carrying a hash from a block that
  // may no longer exist.
  const rewindHash = await input.source.blockHash(Number(rewindTo));
  const finishedAt = input.now().toISOString();
  const rewound = await input.repository.rewindForReorg({
    key: lane,
    owner: input.owner,
    rewindToBlock: rewindTo,
    rewindToBlockHash: rewindHash,
    now: finishedAt,
    run: {
      id: input.runId,
      ...lane,
      startedAt,
      finishedAt,
      startCursorBlock: cursorBlock,
      endCursorBlock: rewindTo,
      confirmedHead: null,
      scannedFromBlock: null,
      scannedToBlock: null,
      launchesRead: 0,
      launchesInserted: 0,
      duplicates: 0,
      budgetExhausted: false,
      operatorState: 'reorg_rewound',
      errorCategory: 'reorg_detected',
      result: 'reorg_rewound',
    },
  });
  return {
    ...base,
    result: 'reorg_rewound',
    endCursorBlock: rewound.rewound ? rewindTo : cursorBlock,
    operatorState: 'reorg_rewound',
    markedNonCanonical: rewound.markedNonCanonical,
  };
}
