import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseB20ObservationRepository,
  type B20ObservationRepositoryV1,
} from '@mioagent/route-storage';

import { createB20MeasureDepsV1 } from './b20MeasureDeps.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  B20MeasureArgError,
  B20_MEASURE_EXIT_CODES_V1,
  formatB20MeasureSummaryV1,
  parseB20MeasureArgsV1,
  printB20MeasureUsageV1,
} from './b20MeasureCli.js';
import { runB20MeasurePassV1 } from './b20MeasureRun.js';

// ---------------------------------------------------------------------------
// T69-B §3/§15 — `pnpm b20:measure-opportunities [-- --max-candidates=5]`
//
// One invocation, one bounded pass, then exit. Safe on a timer: a second
// firing cannot take the measurement lease and leaves as `run_already_active`.
//
// What this process CANNOT do, by construction rather than by intention:
//
//   * Move an asset. It builds two READERS — `eth_call`/`eth_getBlockByNumber`
//     for B20 controls, `getAmountsOut` for Aerodrome. There is no signer, no
//     private key, no allowance write, no state override and no probe balance
//     anywhere in this process.
//   * Certify anything. It has no wallet, so it cannot observe a sequential
//     entry-and-exit execution — and the observation schema has no `qualified`
//     state to put one in.
//   * Create a clearance or an entry plan. Those are wallet-bound and live in
//     the T68D/E/F chain; nothing here touches them.
//   * Print a credential. Both endpoints are read once, handed to their
//     readers, and never appear in a summary, an observation row or an error.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseB20MeasureArgsV1(process.argv.slice(2));
  if (args.help) {
    printB20MeasureUsageV1();
    return 0;
  }

  console.log('T69 B20 opportunity measurement');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    // Never the URL itself, here or anywhere.
    console.error('\n✗ BASE_MAINNET_RPC_URL is not set — a pass with no endpoint would measure nothing');
    return B20_MEASURE_EXIT_CODES_V1.endpoint_unavailable;
  }

  const observations: B20ObservationRepositoryV1 = createDatabaseB20ObservationRepository(client);

  if (args.dryRun) {
    const due = await observations.selectMeasurableLaunches({
      limit: args.maxLaunches,
      maxLaunchAgeMs: args.maxLaunchAgeMs,
      minReMeasureIntervalMs: args.minReMeasureIntervalMs,
      now: new Date().toISOString(),
    });
    console.log('   · DRY RUN — the chain is not read and nothing is written');
    line('Reference position', `${args.profile.positionAtomic} atomic USDC`);
    line('Round-trip tolerance', `${args.profile.maxRoundTripBps} bps`);
    line('Slippage tolerance', `${args.profile.maxExitSlippageBps} bps`);
    line('Due for measurement', String(due.length));
    for (const launch of due.slice(0, 10)) {
      console.log(`  would measure  ${launch.tokenAddress}  last measured ${launch.lastMeasuredAt ?? 'never'}`);
    }
    return 0;
  }

  // §2 — the same wiring the worker uses, from one module. Two copies would be
  // two definitions of what a measurement is.
  const deps = createB20MeasureDepsV1({ rpcUrl, maxRetries: args.maxRetries });

  const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const outcome = await runB20MeasurePassV1({
    observations,
    deps,
    config: args,
    owner,
    now: () => new Date(),
  });

  console.log('');
  console.log(formatB20MeasureSummaryV1(outcome));
  return B20_MEASURE_EXIT_CODES_V1[outcome.result];
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    if (error instanceof B20MeasureArgError) {
      console.error(`\n✗ ${error.message}`);
      await closeDb();
      process.exitCode = 1;
      return;
    }
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    console.error('  No observation was written for the candidate that failed.');
    await closeDb();
    process.exitCode = B20_MEASURE_EXIT_CODES_V1.storage_unavailable;
  });
