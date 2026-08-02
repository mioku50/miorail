import { client, closeDb } from '@mioagent/db';
import {
  b20WatchSummaryV1,
  createB20ReaderV1,
  diffB20SnapshotsV1,
  inspectB20TokenV1,
  validateB20InspectRequestV1,
  type B20BlockAnchorV1,
} from '@mioagent/b20-control';
import {
  RouteStorageConflictError,
  b20SweepOutcomeFromDetectionV1,
  createDatabaseB20StorageRepository,
  createDatabaseB20WatchlistRepository,
  type B20WatchlistEntryV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { parseB20SweepArgsV1, printB20SweepUsageV1, type B20SweepArgsV1 } from './b20SweepCli.js';

// ---------------------------------------------------------------------------
// T68B — `pnpm b20:sweep [-- --limit=50 --min-age=1h --dry-run]`
//
// The thing that makes a watch a watch. Until this ran on a timer, a token's
// controls were only ever read while somebody had the page open, which means
// nothing could ever have changed since they last looked — there was nothing to
// come back for.
//
// What it will NOT do, by construction rather than by intention:
//
//   * Touch a wallet. It calls `inspectB20TokenV1`, whose reader encodes
//     `eth_call` and `eth_getBlockByNumber` and nothing else. There is no
//     signer anywhere in this process.
//   * Decide what to watch. It reads the watchlist. Only addresses a user
//     typed in are on it.
//   * Notify anyone. It records readings. Whether a change is worth a message
//     is a separate decision that does not belong in a cron job.
//   * Re-read a block it already has. A snapshot is keyed by block, so a second
//     reading at the same block is the same fact — and writing it would be a
//     conflict, because the stored row's hash covers its own observation time.
//
// Running it twice changes nothing except the sweep clock. That is the property
// that makes it safe on a timer, and the counts it prints are how you check.
// ---------------------------------------------------------------------------

interface SweepTotalsV1 {
  due: number;
  read: number;
  sameBlock: number;
  notB20: number;
  unreadable: number;
  changed: number;
  conflicts: number;
  notReached: number;
}

async function main(): Promise<void> {
  const args = parseB20SweepArgsV1(process.argv.slice(2));
  if (args.help) {
    printB20SweepUsageV1();
    return;
  }

  console.log('T68B B20 background sweep');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  if (args.dryRun) console.log('   · DRY RUN — the chain is not read and nothing is written');

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl && !args.dryRun) {
    // Never the URL itself, here or anywhere.
    throw new Error('BASE_MAINNET_RPC_URL is not set — a sweep with no endpoint would mark every token unreadable');
  }

  const watchlist = createDatabaseB20WatchlistRepository(client);
  const snapshots = createDatabaseB20StorageRepository(client);
  const startedAt = Date.now();
  const sweptBefore = new Date(startedAt - args.minAgeMs);

  const due = await watchlist.dueForSweep({ limit: args.limit, sweptBefore });
  const totals: SweepTotalsV1 = {
    due: due.length,
    read: 0,
    sameBlock: 0,
    notB20: 0,
    unreadable: 0,
    changed: 0,
    conflicts: 0,
    notReached: 0,
  };
  line('Due for sweep', String(due.length));
  line('Older than', new Date(sweptBefore).toISOString());

  if (due.length === 0) {
    console.log('\nNothing was due. Nothing was read.');
    return;
  }
  if (args.dryRun) {
    for (const entry of due) {
      console.log(`  would read  ${entry.tokenAddress}  last read ${entry.lastSweptAt ?? 'never'}`);
    }
    console.log(`\nDRY RUN — ${due.length} token(s) would have been read.`);
    return;
  }

  // ONE reader and ONE block for the whole run, for the same two reasons the
  // interactive sweep has them: the reader carries what it learned about the
  // endpoint's rate limit from token to token, and readings compared against
  // each other have to come from the same block.
  const reader = createB20ReaderV1({ rpcUrl, timeoutMs: 15_000 });
  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok) {
    // Not a verdict about anybody's tokens, and deliberately not recorded as
    // one: the sweep clock is left alone so the next run retries these.
    throw new Error(`the Base endpoint did not answer (${anchor.reason}) — no token was read`);
  }
  const pinned: B20BlockAnchorV1 = anchor.value;
  line('Block', pinned.blockNumber);
  console.log('');

  for (const entry of due) {
    if (Date.now() - startedAt >= args.budgetMs) {
      // The clock is NOT touched for these. An unread token is not a read one,
      // and the next run finds them exactly where this one left them.
      totals.notReached = due.length - (totals.read + totals.sameBlock + totals.notB20 + totals.unreadable + totals.conflicts);
      break;
    }
    await sweepOneV1({ entry, pinned, reader, snapshots, watchlist, totals, args });
  }

  console.log('');
  line('Read', String(totals.read));
  line('Already at this block', String(totals.sameBlock));
  line('Not B20', String(totals.notB20));
  line('Unreadable', String(totals.unreadable));
  line('Changed since last reading', String(totals.changed));
  if (totals.conflicts > 0) line('Conflicts', String(totals.conflicts));
  if (totals.notReached > 0) line('Not reached (out of time)', String(totals.notReached));
  console.log(`\nOK — ${totals.due} due, ${totals.read} read in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
}

async function sweepOneV1(input: {
  entry: B20WatchlistEntryV1;
  pinned: B20BlockAnchorV1;
  reader: ReturnType<typeof createB20ReaderV1>;
  snapshots: ReturnType<typeof createDatabaseB20StorageRepository>;
  watchlist: ReturnType<typeof createDatabaseB20WatchlistRepository>;
  totals: SweepTotalsV1;
  args: B20SweepArgsV1;
}): Promise<void> {
  const { entry, pinned, totals } = input;
  const now = new Date();

  const refusal = validateB20InspectRequestV1(entry.chainId, entry.tokenAddress);
  if (refusal) {
    // A row the schema should have refused. Recorded as unreadable rather than
    // crashing the run, because one bad row must not stop every other account.
    totals.unreadable += 1;
    await input.watchlist.recordSweep({ id: entry.id, at: now, outcome: 'unreadable' });
    return;
  }

  const recent = await input.snapshots.recentSnapshots(entry.userId, entry.tokenAddress, 1);
  const previous = recent[0] ?? null;
  if (previous && previous.blockNumber === pinned.blockNumber) {
    // The same block is the same facts. Reading it again would cost ~15 calls
    // to learn nothing, and storing it would be a conflict — the stored row's
    // hash covers its own observation time, so a second reading of one block
    // is a DIFFERENT record of an IDENTICAL state.
    totals.sameBlock += 1;
    await input.watchlist.recordSweep({
      id: entry.id,
      at: now,
      outcome: b20SweepOutcomeFromDetectionV1(previous.snapshot.detection.outcome),
    });
    return;
  }

  const result = await inspectB20TokenV1(
    { reader: input.reader },
    {
      tenantId: entry.userId,
      chainId: entry.chainId,
      tokenAddress: entry.tokenAddress,
      now,
      anchor: pinned,
    },
  );
  const outcome = b20SweepOutcomeFromDetectionV1(result.snapshot.detection.outcome);
  if (outcome === 'unreadable') {
    totals.unreadable += 1;
    // Recorded, so a token whose endpoint keeps failing does not hold the front
    // of the queue forever and starve every other account's tokens.
    await input.watchlist.recordSweep({ id: entry.id, at: now, outcome });
    return;
  }

  try {
    const stored = await input.snapshots.insertSnapshot({ userId: entry.userId, snapshot: result.snapshot });
    const watch = diffB20SnapshotsV1(previous?.snapshot ?? null, stored.snapshot);
    if (watch.status === 'compared' && watch.changes.length > 0) {
      totals.changed += 1;
      // Printed because it is the only thing in this run a human needs to see.
      // The address, never a judgement: the summary states what moved.
      console.log(`  changed  ${entry.tokenAddress}  ${b20WatchSummaryV1(watch)}`);
    }
    if (outcome === 'not_b20') totals.notB20 += 1;
    else totals.read += 1;
  } catch (error) {
    if (error instanceof RouteStorageConflictError) {
      // Two disagreeing readings of one block. Counted and left alone: neither
      // silently wins, which is the whole point of the constraint.
      totals.conflicts += 1;
      console.log(`  conflict ${entry.tokenAddress}  a different snapshot already exists at this block`);
    } else {
      throw error;
    }
  }
  await input.watchlist.recordSweep({ id: entry.id, at: now, outcome });
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
