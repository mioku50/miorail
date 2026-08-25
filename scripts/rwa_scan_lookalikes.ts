/**
 * Which contracts in the launch index are wearing an official asset's name.
 *
 * Reads the official corpus and the B20 launch index, both already stored, and
 * writes what resembles what. No RPC, no network, no chain read: this is a
 * comparison of two things Miorail already knows, which is why it is cheap
 * enough to run over the whole index.
 *
 * What it does NOT do, and cannot be made to do without a schema change: call
 * anything a scam. A row says two strings matched and two addresses did not.
 *
 *   pnpm rwa:scan-lookalikes --dry
 *   pnpm rwa:scan-lookalikes
 */
import { client, closeDb } from '@mioagent/db';
import { lookalikeMatchV1, type OfficialIdentityForMatchV1 } from '@mioagent/rwa-lookalike';
import {
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialLookalikeRepository,
  createDatabaseRwaSignalRepository,
  type OfficialLookalikeRowV1,
} from '@mioagent/route-storage';
import { lookalikeSignalsV1 } from '@mioagent/rwa-dossier';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;

interface LaunchRowV1 {
  token_address: string;
  symbol: string;
  name: string;
  detected_at: string | null;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const official = createDatabaseOfficialAssetRepository(client);
  const lookalikes = createDatabaseOfficialLookalikeRepository(client);
  const signals = createDatabaseRwaSignalRepository(client);

  const assets = await official.officialAssets({ chainId: CHAIN_ID_V1, limit: 200 });
  if (assets.length === 0) {
    throw new Error('no official asset is currently listed — run pnpm rwa:ingest-official first');
  }
  // One identity per address, with every spelling the corpus gives it. Two
  // sources listing the same asset must not make it two officials.
  const officials: OfficialIdentityForMatchV1[] = assets.map((asset) => ({
    tokenAddress: asset.tokenAddress,
    ticker: asset.listings[0].ticker,
    displayName: asset.listings.map((listing) => listing.displayName).find((name) => name) ?? null,
  }));
  const corpus = officials.map((asset) => asset.tokenAddress);

  const launches = (await client`
    SELECT token_address, symbol, name, detected_at
      FROM b20_launches
     WHERE chain_id = ${CHAIN_ID_V1} AND canonical = true`) as unknown as LaunchRowV1[];

  console.log(`${officials.length} official asset(s) against ${launches.length} indexed launch(es)\n`);

  const observedAt = new Date().toISOString();
  const rows: OfficialLookalikeRowV1[] = [];
  for (const launch of launches) {
    const match = lookalikeMatchV1({
      launch: {
        tokenAddress: launch.token_address,
        symbol: launch.symbol ?? '',
        name: launch.name ?? '',
      },
      officials,
    });
    if (!match) continue;
    rows.push({
      chainId: CHAIN_ID_V1,
      tokenAddress: match.tokenAddress,
      officialAddress: match.officialAddress,
      matchKind: match.matchKind,
      matchedAlias: match.matchedAlias,
      matchedValue: match.matchedValue,
      launchSymbol: (launch.symbol ?? '').slice(0, 120),
      launchName: (launch.name ?? '').slice(0, 200),
      launchedAt: launch.detected_at ? new Date(launch.detected_at).toISOString() : null,
      firstFlaggedAt: observedAt,
      lastSeenAt: observedAt,
    });
  }

  const byOfficial = new Map<string, number>();
  for (const row of rows) byOfficial.set(row.officialAddress, (byOfficial.get(row.officialAddress) ?? 0) + 1);
  const tickerOf = new Map(officials.map((asset) => [asset.tokenAddress, asset.ticker]));

  const byAlias = new Map<string, number>();
  for (const row of rows) byAlias.set(row.matchedAlias, (byAlias.get(row.matchedAlias) ?? 0) + 1);
  console.log(`${rows.length} contract(s) resemble an official asset`);
  // Which SPELLING was worn is the distinction that matters: nobody names a
  // token AAPLc by accident, while COIN and META are ordinary words.
  for (const [alias, count] of [...byAlias].sort(([, a], [, b]) => b - a)) {
    console.log(`  ${alias.padEnd(18)} ${count}`);
  }
  for (const [address, count] of [...byOfficial].sort(([, a], [, b]) => b - a)) {
    console.log(`  ${(tickerOf.get(address) ?? address).padEnd(8)} ${count}`);
  }

  if (dry) {
    for (const row of rows.slice(0, 20)) {
      console.log(
        `    ${row.tokenAddress}  ${row.matchedAlias.padEnd(16)} ${row.matchKind.padEnd(18)} "${row.launchSymbol}" / "${row.launchName}"`,
      );
    }
    if (rows.length > 20) console.log(`    … and ${rows.length - 20} more`);
    return;
  }

  // Opened BEFORE the scan runs. The pass that opens a watch reports nothing:
  // the first scan of an index holding 22,000 launches would otherwise
  // announce every contract that has ever worn the name as news, and the
  // oldest of them launched months ago.
  const [watch] = await signals.openSignalWatch({
    chainId: CHAIN_ID_V1,
    kinds: ['official_asset_lookalike_created'],
    at: observedAt,
  });

  const outcome = await lookalikes.recordLookalikes({
    chainId: CHAIN_ID_V1,
    officialAddresses: corpus,
    rows,
  });
  console.log(`\nnewly flagged ${outcome.flagged.length}, already known ${outcome.refreshed.length}`);
  for (const address of outcome.flagged.slice(0, 20)) console.log(`  + ${address}`);

  if (watch?.openedNow) {
    console.log(
      `\nsignals: watch opened at ${watch.watchingSince} — this pass reports nothing, because nothing here is a change yet`,
    );
    return;
  }
  const emitted = lookalikeSignalsV1({
    flagged: outcome.flagged,
    rows,
    officialTickers: tickerOf,
    occurredAt: observedAt,
  });
  const recorded = await signals.recordSignals({
    chainId: CHAIN_ID_V1,
    recordedAt: new Date().toISOString(),
    signals: emitted,
  });
  console.log(
    `signals: ${recorded.recorded.length} recorded, ${recorded.alreadyRecorded.length} already on file`,
  );
}

main()
  .catch((error) => {
    console.error('lookalike scan failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
