import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { client, closeDb } from '@mioagent/db';
import {
  createB20ReaderV1,
  exitControlsFromSnapshotV1,
  hashB20SnapshotV1,
  inspectB20TokenV1,
} from '@mioagent/b20-control';
import { createAerodromeReaderV1 } from '@mioagent/swap-adapters';
import {
  createDatabaseB20ObservationRepository,
  type B20ObservationRepositoryV1,
} from '@mioagent/route-storage';
import type { B20ObservationControlsV1 } from '@mioagent/opportunity-rail';

import { aerodromeRouteKeyV1, analyseExitV1 } from '../artifacts/api-server/lib/exitAnalysis.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  B20MeasureArgError,
  B20_MEASURE_EXIT_CODES_V1,
  formatB20MeasureSummaryV1,
  parseB20MeasureArgsV1,
  printB20MeasureUsageV1,
} from './b20MeasureCli.js';
import {
  runB20MeasurePassV1,
  transferPolicyStateV1,
  type MeasurementDepsV1,
  type ObservationAnchorV1,
} from './b20MeasureRun.js';

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

  // ONE reader per pass, for the reason the sweep has one: it carries what it
  // learned about the endpoint's rate limit from token to token.
  const controlReader = createB20ReaderV1({ rpcUrl, timeoutMs: 15_000, maxRetries: args.maxRetries });
  const aerodromeReader = createAerodromeReaderV1({ rpcUrl, timeoutMs: 15_000, maxRetries: args.maxRetries });

  const deps: MeasurementDepsV1 = {
    // Aerodrome's `getAmountsOut` takes no block tag, so router quotes are read
    // at `latest` while the factory and control reads are pinned. Named rather
    // than hidden: presenting the two as one atomic snapshot would be a claim
    // nothing measured.
    quoteAlignment: 'latest_not_anchored',

    async readAnchor(): Promise<ObservationAnchorV1 | null> {
      const anchor = await controlReader.readBlockAnchor();
      // No anchor, no observation. A measurement of no particular moment is
      // not a measurement.
      if (!anchor.ok) return null;
      return {
        blockNumber: anchor.value.blockNumber,
        blockHash: anchor.value.blockHash,
        blockTag: anchor.value.blockTag,
      };
    },

    async readFactoryStatus({ tokenAddress, anchor }) {
      const isB20 = await controlReader.readIsB20(tokenAddress, anchor.blockTag);
      // Null, never false: "the factory said no" and "nobody answered" are
      // different facts and only one of them is about the token.
      if (!isB20.ok) return { isB20: null, initialized: null };
      if (!isB20.value) return { isB20: false, initialized: null };
      const initialized = await controlReader.readIsB20Initialized(tokenAddress, anchor.blockTag);
      return { isB20: true, initialized: initialized.ok ? initialized.value : null };
    },

    async analyseRoutes({ tokenAddress, profile }) {
      const analysis = await analyseExitV1({
        reader: aerodromeReader,
        tokenAddress: tokenAddress as `0x${string}`,
        quoteAsset: profile.quoteAsset as `0x${string}`,
        profile: {
          positionAtomic: profile.positionAtomic,
          maxRoundTripBps: profile.maxRoundTripBps,
          maxSlippageBps: profile.maxExitSlippageBps,
        },
        // The economics only. Controls are read separately and AFTER this, so
        // an open set here is not an assumption — it keeps `analyseExitV1` from
        // short-circuiting before the numbers this feed needs are measured.
        controls: {
          factoryConfirmed: true,
          transfersPaused: false,
          transferPolicyActive: false,
          controlsFullyRead: true,
        },
      });
      return {
        entryRouteFound: analysis.entryRouteFound,
        exitRouteFound: analysis.exitRouteFound,
        degraded: analysis.endpointDegraded,
        candidatesTotal: analysis.candidatesTotal,
        candidatesAnswered: analysis.candidatesAnswered,
        entryOutputAtomic: analysis.roundTrip?.entry.outputAtomic ?? null,
        exitReturnAtomic: analysis.roundTrip?.exit.outputAtomic ?? null,
        entryRouteHash: null,
        exitRouteHash: null,
        entrySourceKey: analysis.entryRoute ? aerodromeRouteKeyV1(analysis.entryRoute) : null,
        exitSourceKey: analysis.exitRoute ? aerodromeRouteKeyV1(analysis.exitRoute) : null,
        probes: analysis.probes,
        routerCalls: analysis.quotesUsed,
      };
    },

    async readControls({ tokenAddress, anchor }) {
      const result = await inspectB20TokenV1(
        { reader: controlReader },
        {
          tenantId: 'feed',
          chainId: 8453,
          tokenAddress,
          now: new Date(),
          // The SAME block as the factory read, so every anchored fact in this
          // observation describes one moment.
          anchor: {
            blockNumber: anchor.blockNumber,
            blockHash: anchor.blockHash as `0x${string}`,
            blockTag: anchor.blockTag,
          },
        },
      );
      const snapshot = result.snapshot;
      const exit = exitControlsFromSnapshotV1(snapshot);
      const controls: B20ObservationControlsV1 = {
        factoryConfirmed: exit.factoryConfirmed,
        initialized: snapshot.detection.outcome === 'b20',
        transfersPaused: exit.transfersPaused,
        transferPolicyState: transferPolicyStateV1(snapshot),
        controlsComplete: exit.controlsFullyRead,
      };
      return {
        controls,
        snapshotHash: hashB20SnapshotV1(snapshot),
        blockNumber: snapshot.blockNumber,
        // The control card is a fixed set of paced reads; counting it as one
        // unit per token is what the budget bounds.
        controlCalls: snapshot.fields.length,
      };
    },
  };

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
