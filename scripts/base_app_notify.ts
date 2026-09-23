/**
 * One pass of Base App notifications — what is said, to whom and how often is
 * in ./baseAppNotify.ts.
 *
 * Reads Miorail's own records and Base's list of wallets that turned
 * notifications on; writes only its cursor and a per-wallet daily count. No
 * signer, no chain write, no wallet. The Base Dashboard key is read from the
 * environment and is never printed.
 *
 *   pnpm base-app:notify --dry     reads and plans, sends and writes nothing
 *   pnpm base-app:notify
 */
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseBaseAppNotificationRepositoryV1,
  createDatabaseOfficialAssetRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';

import {
  baseAppNotifyConfigV1,
  createBaseAppNotifyClientV1,
  runBaseAppNotifyV1,
  type StockNamesV1,
} from './baseAppNotify.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const config = baseAppNotifyConfigV1(process.env);
  if (!config) {
    console.log(JSON.stringify({ event: 'base_app_notify', outcome: 'off' }));
    return;
  }

  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const official = createDatabaseOfficialAssetRepository(client);
  const report = await runBaseAppNotifyV1({
    repository: createDatabaseBaseAppNotificationRepositoryV1(client),
    client: createBaseAppNotifyClientV1({ config }),
    // A lookup that fails fails the pass, which advances nothing: a push is
    // never dropped because a name could not be read this minute.
    names: async (tokens) => {
      const found = new Map<string, StockNamesV1>();
      for (const token of new Set(tokens.map((address) => address.toLowerCase()))) {
        const [binding, identity] = await Promise.all([
          underlyings.underlyingOf({ chainId: 8453, tokenAddress: token }),
          official.officialIdentity({ chainId: 8453, tokenAddress: token }),
        ]);
        const symbol = binding?.underlying.displaySymbol ?? null;
        const representation = identity?.listings[0]?.ticker ?? null;
        if (symbol || representation) found.set(token, { symbol, representation });
      }
      return (address) => found.get(address.toLowerCase()) ?? null;
    },
    now: () => new Date(),
    dry,
  });
  console.log(JSON.stringify({ event: 'base_app_notify', dry, ...report }));
  // Base down or throttling is a later pass's problem; a key Base no longer
  // takes is the operator's, and a failed unit is how that gets seen.
  if (report.stoppedBy && /http_(401|403|404)$/.test(report.stoppedBy)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('base app notify failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
