import { client, closeDb } from '@mioagent/db';
import {
  createLaunchLogSourceV1,
  decodeB20CreatedV1,
  type RawLogV1,
} from '@mioagent/b20-control';
import {
  B20_DISCOVER_LANE_V1,
  createDatabaseB20DiscoverRepository,
  storedLaunchFromDecodedV1,
  type B20StoredLaunchV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Repair a historical gap in the Discover index.
//
// Why this exists: production Discover began scanning at block 49,401,132.
// Miorail's own token, MIO (0xb200…0101), launched at 48,661,648 — seventeen
// days and 739,484 blocks earlier. Nothing was wrong with the ingestion; the
// range was simply never read. The console then reported the missing row as
// "Not a canonical B20 launch in Miorail", which is a claim about the token
// rather than about our coverage.
//
// The rules this script is built to keep:
//
//   - Real logs only. Every row comes from an `eth_getLogs` result decoded by
//     the SAME `decodeB20CreatedV1` the live worker uses. There is no path here
//     that constructs a launch from an address, and no special case for MIO.
//   - Real provenance. Transaction hash, block number, block hash and log index
//     are the ones the chain returned.
//   - Dry run by default. `--write` is required to store anything, and the dry
//     run prints exactly the rows the write would add.
//   - Idempotent. The repository conflicts on (chain, transaction, log index),
//     so a range may be re-run; a second pass inserts nothing.
//   - The cursor is never touched. `insertHistoricalLaunches` refuses any range
//     that reaches it, so this cannot rewind the live lane.
//
// Read-only against the chain. No signer, no key, and the RPC URL is never
// printed.
//
//   pnpm b20:backfill --from <block> --to <block> [--write] [--window N]
// ---------------------------------------------------------------------------

/** base.org answers a 10k-block eth_getLogs in one call; the production Alchemy
 * endpoint caps at 10. Overridable because which endpoint is configured decides
 * what is possible, and guessing wrong wastes an operator's afternoon. */
const DEFAULT_WINDOW = 500;

interface Settings {
  fromBlock: number;
  toBlock: number;
  window: number;
  write: boolean;
  help: boolean;
}

export function parseBackfillArgsV1(argv: readonly string[]): Settings {
  const settings: Settings = { fromBlock: -1, toBlock: -1, window: DEFAULT_WINDOW, write: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { settings.help = true; continue; }
    if (arg === '--write') { settings.write = true; continue; }
    if (arg === '--from') { settings.fromBlock = Number(argv[++i]); continue; }
    if (arg === '--to') { settings.toBlock = Number(argv[++i]); continue; }
    if (arg === '--window') { settings.window = Number(argv[++i]); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return settings;
}

/** Both ends required and explicit. A default range would be a script that
 * scans the chain because nobody said not to. */
export function validateBackfillRangeV1(settings: Settings): string | null {
  if (!Number.isSafeInteger(settings.fromBlock) || settings.fromBlock < 0) {
    return '--from <block> is required';
  }
  if (!Number.isSafeInteger(settings.toBlock) || settings.toBlock < 0) {
    return '--to <block> is required';
  }
  if (settings.toBlock < settings.fromBlock) return '--to must not be below --from';
  if (!Number.isSafeInteger(settings.window) || settings.window < 1) return '--window must be a positive integer';
  return null;
}

const USAGE = `
pnpm b20:backfill --from <block> --to <block> [--write] [--window N]

  Reads B20Created logs for a block range the Discover cursor has already
  passed, and stores any canonical launch missing from the index.

  --from   first block, inclusive (required)
  --to     last block, inclusive (required)
  --window blocks per eth_getLogs call (default ${DEFAULT_WINDOW})
  --write  actually store. Without it this is a dry run and prints what would
           be added.
`;

async function main(): Promise<number> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  let settings: Settings;
  try {
    settings = parseBackfillArgsV1(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  if (settings.help) { console.log(USAGE); return 0; }

  const invalid = validateBackfillRangeV1(settings);
  if (invalid) { console.error(`✗ ${invalid}`); console.error(USAGE); return 2; }

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    console.error('✗ BASE_MAINNET_RPC_URL is not set — nothing to read from');
    return 3;
  }

  const repository = createDatabaseB20DiscoverRepository(client);
  const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
  if (!cursor) {
    console.error('✗ this lane has no Discover cursor; run the discover worker before backfilling behind it');
    return 4;
  }

  console.log(`B20 historical backfill  ${settings.write ? '(WRITE)' : '(dry run)'}`);
  console.log(`  lane cursor at block   ${cursor.lastProcessedBlock}`);
  console.log(`  range                  ${settings.fromBlock} .. ${settings.toBlock}`);
  console.log(`  window                 ${settings.window} blocks per call`);

  if (BigInt(settings.toBlock) >= BigInt(cursor.lastProcessedBlock)) {
    // Refused here as well as in the repository, so an operator learns it
    // before spending an hour of reads rather than at the final statement.
    console.error('✗ --to reaches the live cursor; a backfill may only cover blocks already passed');
    return 5;
  }

  const source = createLaunchLogSourceV1({ rpcUrl, timeoutMs: 30_000 });

  const decoded: B20StoredLaunchV1[] = [];
  const refusals = new Map<string, number>();
  let windowsRead = 0;
  let windowsFailed = 0;
  const detectedAt = new Date().toISOString();

  for (let start = settings.fromBlock; start <= settings.toBlock; start += settings.window) {
    const end = Math.min(start + settings.window - 1, settings.toBlock);
    const logs = await source.getLogs({ fromBlock: start, toBlock: end });
    if (logs === null) {
      // Null is "the endpoint did not answer", which is not "no launches here".
      // Counted and reported, never silently treated as a covered range.
      windowsFailed += 1;
      continue;
    }
    windowsRead += 1;
    for (const log of logs as RawLogV1[]) {
      const result = decodeB20CreatedV1(log);
      if (!result.ok) {
        refusals.set(result.refusal, (refusals.get(result.refusal) ?? 0) + 1);
        continue;
      }
      decoded.push(
        storedLaunchFromDecodedV1({
          launch: result.launch,
          detectedAt,
          transactionIndex: result.launch.transactionIndex,
          // These blocks are far behind the head by definition; the exact depth
          // is not knowable from a historical read, so the confirmation count
          // records the distance from the cursor rather than a guess.
          confirmationCount: Math.max(0, Number(BigInt(cursor.lastProcessedBlock) - BigInt(result.launch.blockNumber))),
        }),
      );
    }
  }

  console.log(`\n  windows read           ${windowsRead}`);
  if (windowsFailed > 0) {
    console.log(`  windows FAILED         ${windowsFailed}  ← these blocks were NOT read; re-run to cover them`);
  }
  console.log(`  launches decoded       ${decoded.length}`);
  for (const [refusal, count] of [...refusals].sort()) {
    console.log(`  refused: ${refusal.padEnd(24)} ${count}`);
  }

  if (decoded.length === 0) {
    console.log('\nNothing to add.');
    return windowsFailed > 0 ? 6 : 0;
  }

  // Which of these are actually new. Printed before any write so the dry run
  // and the write agree about what is about to happen — the only promise a dry
  // run makes.
  //
  // Asked by id rather than by listing the corpus. `listLaunches({ limit:
  // 10_000 })` was exact only while fewer than ten thousand launches existed;
  // once the historical gap is filled the corpus is ~18,000, and the dry run
  // would silently start calling rows new that the write then skips.
  const existing = new Set(
    await repository.storedLaunchIds({
      key: B20_DISCOVER_LANE_V1,
      ids: decoded.map((launch) => launch.id),
    }),
  );
  const fresh = decoded.filter((launch) => !existing.has(launch.id));

  console.log(`\n  already indexed        ${decoded.length - fresh.length}`);
  console.log(`  would be added         ${fresh.length}`);
  for (const launch of fresh.slice(0, 50)) {
    console.log(
      `    block ${launch.blockNumber.padStart(9)}  ${launch.tokenAddress}  ${(launch.symbol || '—').padEnd(12)} ${launch.transactionHash}#${launch.logIndex}`,
    );
  }
  if (fresh.length > 50) console.log(`    … and ${fresh.length - 50} more`);

  if (!settings.write) {
    console.log('\nDry run — nothing was written. Re-run with --write to store these.');
    return 0;
  }

  const result = await repository.insertHistoricalLaunches({
    key: B20_DISCOVER_LANE_V1,
    fromBlock: String(settings.fromBlock),
    toBlock: String(settings.toBlock),
    launches: decoded,
    now: new Date().toISOString(),
  });
  console.log(`\n  inserted               ${result.inserted}`);
  console.log(`  already present        ${result.duplicates}`);
  const after = await repository.getCursor(B20_DISCOVER_LANE_V1);
  console.log(`  cursor after           ${after?.lastProcessedBlock} (unchanged: ${after?.lastProcessedBlock === cursor.lastProcessedBlock})`);
  return windowsFailed > 0 ? 6 : 0;
}

// Only when invoked as a command. Importing this module — which the argument
// tests do — must not open a database handle or read the chain.
const invokedDirectlyV1 =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectlyV1) {
  void main()
    .then(async (code) => {
      await closeDb();
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      await closeDb();
      process.exitCode = 1;
    });
}
