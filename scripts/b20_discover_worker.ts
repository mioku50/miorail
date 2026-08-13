import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { client, closeDb } from '@mioagent/db';
import { createLaunchLogSourceV1 } from '@mioagent/b20-control';
import { createDatabaseB20DiscoverRepository } from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { parseB20DiscoverArgsV1 } from './b20DiscoverCli.js';
import { runB20DiscoverPassV1 } from './b20DiscoverRun.js';
import {
  B20_DISCOVER_CADENCE_V1,
  createInterruptibleWaitV1,
  installStopSignalsV1,
  runWorkerLoopV1,
} from './b20WorkerLoop.js';

// ---------------------------------------------------------------------------
// T73-LIVE §1 — B20 discovery as a service.
//
// The same bounded pass `pnpm b20:discover` runs, called in a loop that decides
// its own cadence from what the last pass reported. Nothing about the pass
// changed: same lease, same max-range and log-window limits, same one-commit
// cursor advance, same refusal categories.
//
// Concurrency is not this process's business. The lease in `b20_discover_cursors`
// is a database row with an owner and an expiry, taken by a conditional UPDATE,
// so two of these — during a deploy, after a crash, on two machines — do not
// both advance the cursor. A process-local boolean could not make that promise
// across a restart, which is exactly when it would be needed.
//
// It still cannot move an asset, guess a start block, or print a credential:
// those are properties of the pass, and this adds no code path around them.
// ---------------------------------------------------------------------------

const OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Beyond this far behind, passes run back to back. One default pass covers 800
 * blocks, so this is a couple of passes of lag — normal — and anything more is
 * a backlog worth burning cadence on. */
const CATCH_UP_THRESHOLD_BLOCKS = 2_400;

async function main(): Promise<number> {
  console.log('T73-LIVE B20 discovery worker');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const settings = parseB20DiscoverArgsV1(process.argv.slice(2), process.env);
  settings.help = false;

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    // Never the URL itself, here or anywhere.
    console.error('✗ BASE_MAINNET_RPC_URL is not set — a worker with no endpoint would read nothing');
    return 3;
  }

  const repository = createDatabaseB20DiscoverRepository(client);
  const source = createLaunchLogSourceV1({
    rpcUrl,
    timeoutMs: Math.max(5_000, Math.floor(settings.maxRuntimeMs / 3)),
  });

  let running = true;
  const interruptibleWait = createInterruptibleWaitV1();
  const removeSignals = installStopSignalsV1(() => {
    // Logged, because a service that stops silently looks like a crash.
    console.log(JSON.stringify({ event: 'b20_discover_worker_stopping', owner: OWNER }));
    running = false;
    interruptibleWait.wake();
  });

  console.log(
    JSON.stringify({
      event: 'b20_discover_worker_started',
      owner: OWNER,
      maxRange: settings.maxRange,
      logWindow: settings.logWindow,
      confirmations: settings.confirmations,
      idleMs: B20_DISCOVER_CADENCE_V1.idleMs,
    }),
  );

  const summary = await runWorkerLoopV1({
    cadence: B20_DISCOVER_CADENCE_V1,
    catchUpThresholdBlocks: CATCH_UP_THRESHOLD_BLOCKS,
    wait: interruptibleWait.wait,
    shouldContinue: () => running,
    log: (entry) => console.log(JSON.stringify(entry)),
    pass: async () => {
      const outcome = await runB20DiscoverPassV1({
        repository,
        source,
        config: settings,
        owner: OWNER,
        runId: randomUUID(),
        now: () => new Date(),
      });
      const blocksBehind =
        outcome.confirmedHead !== null && outcome.endCursorBlock !== null
          ? Math.max(0, Number(BigInt(outcome.confirmedHead) - BigInt(outcome.endCursorBlock)))
          : null;
      // One structured line per pass. Every field is a number or a category —
      // no endpoint, no token, no provider message.
      console.log(
        JSON.stringify({
          event: 'b20_discover_pass',
          result: outcome.result,
          cursor: outcome.endCursorBlock,
          confirmedHead: outcome.confirmedHead,
          blocksBehind,
          launchesInserted: outcome.launchesInserted,
          duplicates: outcome.duplicates,
          logWindowsAttempted: outcome.logWindowsAttempted,
          logWindowsCompleted: outcome.logWindowsCompleted,
          budgetExhausted: outcome.budgetExhausted,
          operatorState: outcome.operatorState,
        }),
      );
      return {
        result: outcome.result,
        budgetExhausted: outcome.budgetExhausted,
        blocksBehind,
        didWork: outcome.launchesRead > 0,
      };
    },
  });

  removeSignals();
  console.log(JSON.stringify({ event: 'b20_discover_worker_stopped', ...summary }));
  // A fatal refusal exits non-zero so systemd records a failure rather than a
  // clean stop — a decoder mismatch that looked like a normal shutdown is a
  // pipeline nobody notices has stopped.
  return summary.stoppedBecause === 'fatal' ? 4 : 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 5;
  });
