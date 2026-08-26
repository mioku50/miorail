/**
 * One check of every reviewed source of the OFFICIAL trust root.
 *
 * Fetches each source, parses it, and records what it said together with the
 * moment it was read. Membership moves only when a check completes: a source
 * that times out, or one whose document no longer parses, is stored as exactly
 * that and withdraws nothing. An asset does not stop being officially issued
 * because our request did.
 *
 * Reads only, apart from the two official-asset tables. No signer, no key, no
 * chain write, no RPC. The Coinbase and Backed sources are public HTTPS
 * documents; Dinari membership is ingested by its separate onchain adapter.
 *
 *   pnpm rwa:ingest-official            # check and record
 *   pnpm rwa:ingest-official --dry      # check and print, write nothing
 */
import { client, closeDb } from '@mioagent/db';
import {
  OFFICIAL_SOURCES_V1,
  fetchOfficialSourceV1,
  officialCorpusHashV1,
  officialDocumentHashV1,
  parseBaseDocsCorpusV1,
  parseBaseProductListV1,
  type OfficialParseResultV1,
  type OfficialSourceKeyV1,
} from '@mioagent/rwa-official';
import { BACKED_BTOKENS_SOURCE_URL_V1, fetchBackedBaseTokensV1 } from '@mioagent/rwa-issuer';
import {
  createDatabaseOfficialAssetRepository,
  createDatabaseRwaSignalRepository,
  createDatabaseUnderlyingAssetRepository,
  type OfficialAssetInputV1,
  type OfficialSourceSnapshotV1,
} from '@mioagent/route-storage';
import { officialSourceSignalsV1 } from '@mioagent/rwa-dossier';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;

const PARSERS_V1: Record<OfficialSourceKeyV1, (body: string) => OfficialParseResultV1> = {
  base_docs_technical: parseBaseDocsCorpusV1,
  base_product_list: parseBaseProductListV1,
};

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const repository = createDatabaseOfficialAssetRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const signals = createDatabaseRwaSignalRepository(client);
  const observedAt = new Date().toISOString();

  // Opened before the first source is fetched, and the pass that opens it says
  // nothing. Coinbase issued these thirteen equities well before Miorail first
  // read the document; reporting them as listings that just happened would
  // date somebody else's history to our first request.
  const watch = dry
    ? []
    : await signals.openSignalWatch({
        chainId: CHAIN_ID_V1,
        kinds: ['official_source_added_asset', 'official_source_removed_asset'],
        at: observedAt,
      });
  const watchOpenedNow = watch.some((row) => row.openedNow);
  if (watchOpenedNow) {
    console.log(`signals: watch opened at ${observedAt} — this pass reports no transitions\n`);
  }

  for (const kind of Object.keys(PARSERS_V1) as OfficialSourceKeyV1[]) {
    const source = OFFICIAL_SOURCES_V1[kind];
    const fetched = await fetchOfficialSourceV1({ url: source.url });

    let snapshot: OfficialSourceSnapshotV1;
    let assets: OfficialAssetInputV1[] = [];

    if (!fetched.ok) {
      snapshot = {
        sourceKind: kind,
        sourceUrl: source.url,
        observedAt,
        status: 'unreachable',
        documentHash: null,
        corpusHash: null,
        detail: fetched.detail,
      };
    } else {
      const parsed = PARSERS_V1[kind](fetched.body);
      if (!parsed.ok) {
        snapshot = {
          sourceKind: kind,
          sourceUrl: source.url,
          observedAt,
          status: 'unparsable',
          documentHash: officialDocumentHashV1(fetched.body),
          corpusHash: null,
          detail: `${parsed.refusal}: ${parsed.detail}`,
        };
      } else {
        snapshot = {
          sourceKind: kind,
          sourceUrl: source.url,
          observedAt,
          status: 'ok',
          documentHash: officialDocumentHashV1(fetched.body),
          corpusHash: officialCorpusHashV1(parsed.assets),
          detail:
            parsed.otherEntries.length > 0
              ? `set aside ${parsed.otherEntries.map((entry) => entry.label).join(', ')}`
              : null,
        };
        assets = parsed.assets.map((asset) => ({
          chainId: CHAIN_ID_V1,
          tokenAddress: asset.tokenAddress,
          sourceKind: kind,
          ticker: asset.ticker,
          displayName: asset.displayName,
          issuer: source.issuer,
          referenceFeedAddress: asset.referenceFeedAddress,
        }));
      }
    }

    const previous = await repository.latestSnapshot({ sourceKind: kind, successfulOnly: true });
    const corpusMoved =
      snapshot.corpusHash !== null && previous?.corpusHash !== snapshot.corpusHash;

    console.log(`\n${kind}`);
    console.log(`  ${snapshot.status}${snapshot.detail ? ` — ${snapshot.detail}` : ''}`);
    console.log(`  ${assets.length} asset(s)`);
    if (previous) {
      console.log(
        `  corpus ${corpusMoved ? 'CHANGED since' : 'unchanged since'} ${previous.observedAt}`,
      );
    }

    if (dry) {
      for (const asset of assets) {
        console.log(
          `    ${asset.ticker.padEnd(7)} ${asset.tokenAddress}  feed ${asset.referenceFeedAddress ?? '—'}`,
        );
      }
      continue;
    }

    const outcome = await repository.recordSnapshot({ snapshot, assets });
    if (outcome.added.length > 0) console.log(`  added:    ${outcome.added.join(', ')}`);
    if (outcome.delisted.length > 0) console.log(`  DELISTED: ${outcome.delisted.join(', ')}`);
    if (outcome.added.length === 0 && outcome.delisted.length === 0 && outcome.status === 'ok') {
      console.log('  membership unchanged');
    }

    if (watchOpenedNow) continue;
    // A delisted asset is not in `assets` -- this check is why it was dropped.
    // Its name comes from what the corpus already holds, so the signal can say
    // WHICH asset left rather than printing an address.
    const named = new Map(
      assets.map((asset) => [
        asset.tokenAddress,
        { ticker: asset.ticker, displayName: asset.displayName },
      ]),
    );
    for (const tokenAddress of outcome.delisted) {
      if (named.has(tokenAddress)) continue;
      const identity = await repository.officialIdentity({ chainId: CHAIN_ID_V1, tokenAddress });
      const listing =
        identity?.listings.find((row) => row.sourceKind === kind) ?? identity?.listings[0];
      if (listing)
        named.set(tokenAddress, { ticker: listing.ticker, displayName: listing.displayName });
    }
    const emitted = officialSourceSignalsV1({ outcome, named, sourceUrl: source.url });
    if (emitted.length > 0) {
      const recorded = await signals.recordSignals({
        chainId: CHAIN_ID_V1,
        recordedAt: new Date().toISOString(),
        signals: emitted,
      });
      console.log(
        `  signals: ${recorded.recorded.length} recorded, ${recorded.alreadyRecorded.length} already on file`,
      );
    }
  }

  // Backed's Base corpus is deliberately read from the v1 `btokens` API.
  // The v2 xStocks corpus currently names no Base deployment; treating it as
  // the replacement would silently withdraw all legacy Base bTokens.
  const backed = await fetchBackedBaseTokensV1();
  const backedSnapshot: OfficialSourceSnapshotV1 = backed.ok
    ? {
        sourceKind: 'backed_assets_api',
        sourceUrl: BACKED_BTOKENS_SOURCE_URL_V1,
        observedAt,
        status: 'ok',
        documentHash: backed.documentHash,
        corpusHash: backed.corpusHash,
        detail: `reviewed legacy bTokens corpus; ${backed.assets.length} instruments and ${backed.representations.length} exact Base representations`,
      }
    : {
        sourceKind: 'backed_assets_api',
        sourceUrl: BACKED_BTOKENS_SOURCE_URL_V1,
        observedAt,
        status: backed.reason === 'unparsable' ? 'unparsable' : 'unreachable',
        documentHash: null,
        corpusHash: null,
        detail: backed.detail,
      };
  const backedAssets: OfficialAssetInputV1[] = backed.ok
    ? backed.representations.map((row) => ({
        chainId: CHAIN_ID_V1,
        tokenAddress: row.tokenAddress,
        sourceKind: 'backed_assets_api',
        ticker: row.displaySymbol,
        displayName:
          row.representationKind === 'non_rebasing_erc4626_wrapper'
            ? `${row.displayName} wrapper`
            : row.displayName,
        issuer: 'Backed Assets',
        referenceFeedAddress: null,
      }))
    : [];
  console.log(`\nbacked_assets_api`);
  console.log(
    `  ${backedSnapshot.status}${backedSnapshot.detail ? ` — ${backedSnapshot.detail}` : ''}`,
  );
  if (dry) {
    for (const asset of backedAssets)
      console.log(`    ${asset.ticker.padEnd(8)} ${asset.tokenAddress}`);
  } else {
    const outcome = await repository.recordSnapshot({
      snapshot: backedSnapshot,
      assets: backedAssets,
    });
    console.log(
      `  membership ${outcome.added.length} added, ${outcome.delisted.length} delisted, ${outcome.stillListed.length} unchanged`,
    );
  }

  if (backed.ok && !dry) {
    const byInstrument = new Map(
      backed.representations.map((row) => [row.issuerInstrumentId, row]),
    );
    for (const row of byInstrument.values()) {
      await underlyings.declareUnderlying({
        underlyingKey: row.underlyingKey,
        assetClass: 'unknown',
        canonicalName: row.underlyingDisplaySymbol,
        displaySymbol: row.underlyingDisplaySymbol,
        identifierScheme: 'isin',
        identifierValue: row.underlyingIsin,
        sourceKind: 'backed_assets_api',
        sourceRef: `${BACKED_BTOKENS_SOURCE_URL_V1}#${row.issuerInstrumentId}`,
        sourceHash: backed.corpusHash,
        observedAt,
      });
    }
    for (const row of backed.representations) {
      await underlyings.bindRepresentation({
        chainId: CHAIN_ID_V1,
        tokenAddress: row.tokenAddress,
        underlyingKey: row.underlyingKey,
        sourceKind: 'backed_assets_api',
        sourceRef: `${BACKED_BTOKENS_SOURCE_URL_V1}#${row.issuerInstrumentId}`,
        sourceHash: backed.corpusHash,
        issuerId: 'backed',
        issuerInstrumentKey: row.issuerInstrumentKey,
        caip10: row.caip10,
        representationKind: row.representationKind,
        evidenceStrength: 'reviewed_machine_address_mapping',
        observedBlockNumber: null,
        observedBlockHash: null,
        observedAt,
      });
    }
    console.log(
      `  underlying identity: ${byInstrument.size} stable instruments, ${backed.representations.length} exact address bindings`,
    );
  }

  if (!dry) {
    const discrepancies = await repository.sourceDiscrepancies({ chainId: CHAIN_ID_V1 });
    console.log(`\nsource discrepancies: ${discrepancies.length}`);
    for (const row of discrepancies) {
      if (row.kind === 'listed_in_one_source') {
        console.log(
          `  ${row.ticker.padEnd(7)} ${row.tokenAddress}  in ${row.listedIn.join('+')}, not in ${row.missingFrom.join('+')}`,
        );
      } else if (row.kind === 'delisted_by_source') {
        console.log(
          `  ${row.ticker.padEnd(7)} ${row.tokenAddress}  dropped by ${row.sourceKind}, last seen ${row.lastSeenAt}`,
        );
      } else {
        console.log(
          `  ${row.ticker.padEnd(7)} maps to ${row.tokenAddresses.length} addresses: ${row.tokenAddresses.join(', ')}`,
        );
      }
    }
  }
}

main()
  .catch((error) => {
    console.error(
      'official asset ingestion failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
