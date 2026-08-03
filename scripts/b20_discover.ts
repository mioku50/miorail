import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { client, closeDb } from '@mioagent/db';
import { createLaunchLogSourceV1 } from '@mioagent/b20-control';
import {
  B20_DISCOVER_LANE_V1,
  createDatabaseB20DiscoverRepository,
  discoverStartCursorV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  B20DiscoverArgError,
  B20_DISCOVER_EXIT_CODES_V1,
  formatB20DiscoverSummaryV1,
  parseB20DiscoverArgsV1,
  printB20DiscoverUsageV1,
} from './b20DiscoverCli.js';
import { runB20DiscoverPassV1 } from './b20DiscoverRun.js';

// ---------------------------------------------------------------------------
// T69-A §7 — `pnpm b20:discover [-- --max-range=800 --dry-run]`
//
// One invocation, one bounded pass, then exit. Safe on a timer: two overlapping
// firings do not both advance the cursor, because the second cannot take the
// lease and leaves as `run_already_active`.
//
// What this process CANNOT do, by construction rather than by intention:
//
//   * Move an asset. It builds a log source that encodes `eth_blockNumber`,
//     `eth_getLogs` and `eth_getBlockByNumber` and nothing else. There is no
//     signer anywhere in this process and no code path that could sign.
//   * Advance past what it read. The cursor and the launches are one commit,
//     and every failure path leaves the cursor exactly where it was.
//   * Guess where to start. A cold cursor with no configured start block stops
//     with `configuration_required` rather than picking somewhere recent.
//   * Print a credential. The RPC URL is read once, handed to the source, and
//     never appears in a summary, a run row or an error — every failure here is
//     a category.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const env = process.env;
  const args = parseB20DiscoverArgsV1(process.argv.slice(2), env);
  if (args.help) {
    printB20DiscoverUsageV1();
    return 0;
  }

  console.log('T69 B20 launch discovery');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  // Re-read: the env file is loaded after the first parse, so a start block
  // configured there is picked up rather than reported as missing.
  const settings = parseB20DiscoverArgsV1(process.argv.slice(2), process.env);
  settings.help = false;

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    // Never the URL itself, here or anywhere.
    console.error('\n✗ BASE_MAINNET_RPC_URL is not set — a pass with no endpoint would read nothing');
    return B20_DISCOVER_EXIT_CODES_V1.endpoint_unavailable;
  }

  const repository = createDatabaseB20DiscoverRepository(client);

  if (settings.dryRun) {
    const cursor = await repository.getCursor(B20_DISCOVER_LANE_V1);
    const start = discoverStartCursorV1({ cursor, configuredStartBlock: settings.startBlock });
    console.log('   · DRY RUN — the chain is not read and nothing is written');
    line('Lane', `${B20_DISCOVER_LANE_V1.chainId} · ${B20_DISCOVER_LANE_V1.decoderVersion}`);
    line('Cursor', start.status === 'existing' ? start.cursor.lastProcessedBlock : 'none');
    line(
      'Would start at',
      start.status === 'existing'
        ? String(Number(start.cursor.lastProcessedBlock) + 1)
        : start.status === 'initialise'
          ? String(Number(start.startBlock) + 1)
          : 'nothing — B20_DISCOVER_START_BLOCK is not set',
    );
    line('Max range', String(settings.maxRange));
    line('Confirmations', String(settings.confirmations));
    return start.status === 'configuration_required' ? B20_DISCOVER_EXIT_CODES_V1.configuration_required : 0;
  }

  // Identifies THIS process for the lease. Host plus pid plus a random suffix,
  // so two workers on one machine are still two owners.
  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const outcome = await runB20DiscoverPassV1({
    repository,
    source: createLaunchLogSourceV1({
      rpcUrl,
      // Three calls per pass, so a third of the budget each is generous and
      // still bounds a hung endpoint well inside the runtime limit.
      timeoutMs: Math.max(5_000, Math.floor(settings.maxRuntimeMs / 3)),
    }),
    config: settings,
    owner,
    runId: randomUUID(),
    now: () => new Date(),
  });

  console.log('');
  console.log(formatB20DiscoverSummaryV1(outcome));
  return B20_DISCOVER_EXIT_CODES_V1[outcome.result];
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(20)} ${value}`);
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    if (error instanceof B20DiscoverArgError) {
      console.error(`\n✗ ${error.message}`);
      await closeDb();
      process.exitCode = B20_DISCOVER_EXIT_CODES_V1.configuration_required;
      return;
    }
    // A storage failure. The cursor and the launches are one commit, so
    // whatever went wrong, neither of them moved.
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    console.error('  The cursor was not advanced and no launch was stored.');
    await closeDb();
    process.exitCode = B20_DISCOVER_EXIT_CODES_V1.storage_unavailable;
  });
