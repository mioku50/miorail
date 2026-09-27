/**
 * One pass of the dividend declaration watcher (./dividendDeclarationWatch.ts).
 *
 * Reads the companies' own releases from EDGAR, Microsoft's newsroom and PR
 * Newswire; writes Miorail's own declaration rows and signals. No signer, no
 * chain write, no wallet. SEC is told who is asking by the product's name,
 * never a person's.
 *
 *   pnpm rwa:dividends
 */
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseDividendDeclarationRepositoryV1,
  createDatabaseOfficialAssetRepository,
  createDatabaseRwaSignalRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';

import { runDividendDeclarationWatchV1 } from './dividendDeclarationWatch.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const official = createDatabaseOfficialAssetRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);

  // Coinbase's documented tokens for one company: each converts its dividend.
  let coinbase: Array<{ tokenAddress: string; underlyingKey: string }> | null = null;
  const tokensOf = async (underlyingKey: string): Promise<string[]> => {
    if (!coinbase) {
      const assets = await official.officialAssets({ chainId: 8453, limit: 500, sourceKind: 'base_docs_technical' });
      coinbase = [];
      for (const asset of assets) {
        const found = await underlyings.underlyingOf({ chainId: 8453, tokenAddress: asset.tokenAddress });
        if (found) coinbase.push({ tokenAddress: asset.tokenAddress, underlyingKey: found.underlying.underlyingKey });
      }
    }
    return coinbase.filter((row) => row.underlyingKey === underlyingKey).map((row) => row.tokenAddress);
  };

  const pass = await runDividendDeclarationWatchV1({
    fetch: (url, init) => fetch(url, init),
    now: new Date(),
    declarations: createDatabaseDividendDeclarationRepositoryV1(client),
    signals: createDatabaseRwaSignalRepository(client),
    tokensOf,
  });
  console.log(JSON.stringify({ event: 'dividend_declarations', ...pass }));
}

main()
  .catch((cause) => {
    console.error(JSON.stringify({ event: 'dividend_declarations', outcome: 'failed', code: cause instanceof Error ? cause.name : 'error' }));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
