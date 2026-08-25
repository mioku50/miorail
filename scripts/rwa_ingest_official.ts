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
 * chain write, no RPC. Both sources are public https documents.
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
import {
  createDatabaseOfficialAssetRepository,
  type OfficialAssetInputV1,
  type OfficialSourceSnapshotV1,
} from '@mioagent/route-storage';

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
  const observedAt = new Date().toISOString();

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
    const corpusMoved = snapshot.corpusHash !== null && previous?.corpusHash !== snapshot.corpusHash;

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
        console.log(`    ${asset.ticker.padEnd(7)} ${asset.tokenAddress}  feed ${asset.referenceFeedAddress ?? '—'}`);
      }
      continue;
    }

    const outcome = await repository.recordSnapshot({ snapshot, assets });
    if (outcome.added.length > 0) console.log(`  added:    ${outcome.added.join(', ')}`);
    if (outcome.delisted.length > 0) console.log(`  DELISTED: ${outcome.delisted.join(', ')}`);
    if (outcome.added.length === 0 && outcome.delisted.length === 0 && outcome.status === 'ok') {
      console.log('  membership unchanged');
    }
  }

  if (!dry) {
    const discrepancies = await repository.sourceDiscrepancies({ chainId: CHAIN_ID_V1 });
    console.log(`\nsource discrepancies: ${discrepancies.length}`);
    for (const row of discrepancies) {
      if (row.kind === 'listed_in_one_source') {
        console.log(`  ${row.ticker.padEnd(7)} ${row.tokenAddress}  in ${row.listedIn.join('+')}, not in ${row.missingFrom.join('+')}`);
      } else if (row.kind === 'delisted_by_source') {
        console.log(`  ${row.ticker.padEnd(7)} ${row.tokenAddress}  dropped by ${row.sourceKind}, last seen ${row.lastSeenAt}`);
      } else {
        console.log(`  ${row.ticker.padEnd(7)} maps to ${row.tokenAddresses.length} addresses: ${row.tokenAddresses.join(', ')}`);
      }
    }
  }
}

main()
  .catch((error) => {
    console.error('official asset ingestion failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
