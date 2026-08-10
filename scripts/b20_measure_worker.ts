import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseB20LaunchBuyersRepository,
  createDatabaseB20LaunchPoolRepository,
  createDatabaseB20ObservationRepository,
  type B20ObservationRepositoryV1,
} from '@mioagent/route-storage';

import { B20_NATIVE_POSITION_ATOMIC_V1, createB20MeasureDepsV1 } from './b20MeasureDeps.js';
import { createB20PoolStoreV1 } from './b20PoolStore.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { parseB20MeasureArgsV1 } from './b20MeasureCli.js';
import { runB20MeasurePassV1 } from './b20MeasureRun.js';
import {
  B20_MEASURE_CADENCE_V1,
  installStopSignalsV1,
  runWorkerLoopV1,
  sleepV1,
} from './b20WorkerLoop.js';

// ---------------------------------------------------------------------------
// T73-LIVE §2/§3 — Exit-First measurement as a service.
//
// The same bounded pass `pnpm b20:measure-opportunities` runs: same reference
// profile, same tolerances, same idempotency, same refusal to invent a result
// when a provider does not answer. What changed is that something calls it.
//
// §3 is why the cadence matters more here than it looks. T73's 24h Measured
// Movers needs TWO comparable observations about a day apart for the same
// token. That pairing is not something the card can manufacture — it is a
// property of how often this worker ran, and of `minReMeasureIntervalMs`
// letting a token be measured again. A worker that measures each token once and
// never returns produces a Movers rail that is empty forever, and correctly so.
//
// So the re-measure interval is the load-bearing setting, and it is left where
// it already lived — in the CLI defaults, overridable by flag — rather than
// re-decided here.
//
// Concurrency is the `b20_measure_leases` row: an owner and an expiry, taken by
// a conditional UPDATE, separate from the discovery lease so quotes never block
// launch reads.
// ---------------------------------------------------------------------------

const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

async function main(): Promise<number> {
  console.log('T73-LIVE B20 measurement worker');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const args = parseB20MeasureArgsV1(process.argv.slice(2));
  args.help = false;

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    // Never the URL itself, here or anywhere.
    console.error('✗ BASE_MAINNET_RPC_URL is not set — a worker with no endpoint would measure nothing');
    return 3;
  }

  const observations: B20ObservationRepositoryV1 = createDatabaseB20ObservationRepository(client);
  const deps = createB20MeasureDepsV1({
    rpcUrl,
    maxRetries: args.maxRetries,
    nativePositionAtomic: B20_NATIVE_POSITION_ATOMIC_V1,
    // A pool is fixed at launch, so re-deriving it every pass spent two
    // `eth_getLogs` — the most expensive call here — to relearn the same fact.
    poolStore: createB20PoolStoreV1(createDatabaseB20LaunchPoolRepository(client)),
    // One eth_getLogs per token, on the first pass that finds the launch's
    // window closed, and nothing on every pass after.
    buyerRepository: createDatabaseB20LaunchBuyersRepository(client),
  });

  let running = true;
  const removeSignals = installStopSignalsV1(() => {
    console.log(JSON.stringify({ event: 'b20_measure_worker_stopping', owner: OWNER }));
    running = false;
  });

  console.log(
    JSON.stringify({
      event: 'b20_measure_worker_started',
      owner: OWNER,
      maxLaunches: args.maxLaunches,
      // The number that decides whether a 24h pair can ever exist.
      minReMeasureIntervalMs: args.minReMeasureIntervalMs,
      maxLaunchAgeMs: args.maxLaunchAgeMs,
      idleMs: B20_MEASURE_CADENCE_V1.idleMs,
    }),
  );

  const summary = await runWorkerLoopV1({
    cadence: B20_MEASURE_CADENCE_V1,
    // Measurement has no cursor, so there is no "blocks behind" to chase; the
    // catch-up signal is the pass's own budget.
    catchUpThresholdBlocks: Number.POSITIVE_INFINITY,
    wait: sleepV1,
    shouldContinue: () => running,
    log: (entry) => console.log(JSON.stringify(entry)),
    pass: async () => {
      const outcome = await runB20MeasurePassV1({
        observations,
        deps,
        config: args,
        owner: OWNER,
        now: () => new Date(),
      });
      // Counts and categories only. Never a token address in an error, never a
      // provider message, never an endpoint.
      console.log(
        JSON.stringify({
          event: 'b20_measure_pass',
          result: outcome.result,
          eligible: outcome.eligible,
          attempted: outcome.attempted,
          observationsWritten: outcome.observationsWritten,
          idempotentRepeats: outcome.idempotentRepeats,
          notChecked: outcome.notChecked,
          failed: outcome.failed,
          // Only when there is something to say, and already scrubbed. Ten
          // identical failures with no reason read as ten bad tokens.
          ...(outcome.failureReasons.length > 0 ? { failureReasons: outcome.failureReasons } : {}),
          budgetExhausted: outcome.budgetExhausted,
          byState: outcome.byState,
        }),
      );
      return {
        result: outcome.result,
        budgetExhausted: outcome.budgetExhausted,
        // More candidates were eligible than the pass could attempt, so another
        // pass has work waiting.
        didWork: outcome.observationsWritten > 0 || outcome.notChecked > 0,
      };
    },
  });

  removeSignals();
  console.log(JSON.stringify({ event: 'b20_measure_worker_stopped', ...summary }));
  return summary.stoppedBecause === 'fatal' ? 4 : 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    console.error('  No observation was written for the candidate that failed.');
    await closeDb();
    process.exitCode = 5;
  });
