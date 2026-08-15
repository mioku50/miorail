import { createB20ReaderV1 } from '@mioagent/b20-control';
import { createDatabaseB20LaunchDeployerRepository } from '@mioagent/route-storage';
import { client, closeDb } from '@mioagent/db';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Reads the sender of each stored launch transaction. One RPC call per launch.
//
// This is the backfill for the only unforgeable identity anchor Miorail has.
// Everything identifying in a launch log was typed by whoever launched the
// token; the sender of the transaction is the one field the chain decided.
//
// THE INVARIANT, AND THE WHOLE REASON THIS IS A SCRIPT AND NOT A LOOP:
//
//   A FAILED READ WRITES NOTHING. An endpoint that timed out has not
//   established that a transaction is absent. Storing its silence as "no
//   sender" would turn a bad minute into a permanent fact about somebody's
//   launch, and this table has no way to tell the two apart afterwards.
//
// Read-only with respect to the chain: no signer, no wallet, no transaction,
// no allowance. It writes one row per launch to Miorail's own database and
// nothing else. Prints no endpoint, no key and no credential.
// ---------------------------------------------------------------------------

/** Paced, because base.org rate-limits a tight loop with HTTP 429 and a 429
 * that reaches the store as a failure is a launch left unread for no reason. */
const DELAY_MS_V1 = Number.parseInt(process.env.B20_SENDER_DELAY_MS ?? '', 10) || 120;
const DEFAULT_LIMIT_V1 = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) {
    // Named, never printed.
    console.error('BASE_MAINNET_RPC_URL is not set — nothing can be read.');
    process.exit(1);
  }
  const limitArg = Number.parseInt(process.argv[2] ?? '', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : DEFAULT_LIMIT_V1;

  const deployers = createDatabaseB20LaunchDeployerRepository(client);
  const reader = createB20ReaderV1({ rpcUrl });
  if (!reader.readTransaction) {
    console.error('this reader cannot read transactions');
    process.exit(1);
  }

  const before = await deployers.deployerCoverage();
  const queue = await deployers.selectLaunchesWithoutDeployer({ limit });
  console.log(
    `coverage before: ${before.launchesRead}/${before.launchesTotal} launches · reading up to ${queue.length}`,
  );

  let stored = 0;
  let absent = 0;
  let failed = 0;
  const readAtStart = Date.now();

  for (const launch of queue) {
    const result = await reader.readTransaction(launch.transactionHash);
    if (!result.ok) {
      // Nothing is written. The launch stays in the queue for the next run,
      // which is the correct outcome: not knowing is a state this schema can
      // represent, and a wrong "absent" is not.
      failed += 1;
      await sleep(DELAY_MS_V1);
      continue;
    }
    const transaction = result.value;
    await deployers.upsertDeployer({
      launchId: launch.launchId,
      chainId: 8453,
      deployerAddress: transaction?.from ?? null,
      transactionTo: transaction?.to ?? null,
      transactionBlockNumber: transaction?.blockNumber ?? null,
      readAt: new Date().toISOString(),
      source: 'base-rpc/v1',
    });
    if (transaction) stored += 1;
    else absent += 1;
    await sleep(DELAY_MS_V1);
  }

  const after = await deployers.deployerCoverage();
  const seconds = Math.round((Date.now() - readAtStart) / 1000);
  console.log(`read ${stored} senders · ${absent} transactions absent · ${failed} reads failed · ${seconds}s`);
  console.log(`coverage after:  ${after.launchesRead}/${after.launchesTotal} launches`);
  // A run where every read failed is an endpoint problem, and exiting 0 would
  // let a scheduler treat it as progress.
  if (queue.length > 0 && stored + absent === 0) {
    console.error('every read failed — the endpoint answered nothing, and nothing was stored');
    process.exit(1);
  }
}

void main().then(
  async () => {
    await closeDb();
    process.exit(0);
  },
  async (error: unknown) => {
    // The name only. A storage or transport error carries a connection string.
    console.error(`launch-sender read failed: ${error instanceof Error ? error.name : 'unknown'}`);
    await closeDb();
    process.exit(1);
  },
);
