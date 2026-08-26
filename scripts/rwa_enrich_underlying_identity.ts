/**
 * Enrich exact Coinbase B20 addresses with reviewed underlying identifiers.
 *
 * The contract is asked for `extraMetadata("isin")` at one pinned Base block.
 * A value is accepted only when an issuer prospectus independently names the
 * same underlying ISIN. Empty metadata, an unknown ISIN or an RPC failure
 * writes no binding and remains `unknown`; symbol/name are never consulted.
 */
import { createHash } from 'node:crypto';
import { createB20ReaderV1, decodeStringV1, selectorV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseOfficialAssetRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ABI encoding of extraMetadata("isin"): offset 32, byte length 4, then the
// UTF-8 bytes. The selector is computed from the reviewed signature rather
// than copied, and the existing total string decoder refuses malformed output.
const wordV1 = (hex: string) => hex.padStart(64, '0');
const EXTRA_METADATA_ISIN_CALL_V1 =
  `0x${selectorV1('extraMetadata(string)')}${wordV1('20')}${wordV1('4')}${'6973696e'.padEnd(64, '0')}` as const;

const REVIEWED_PROSPECTUS_BY_UNDERLYING_ISIN_V1: Readonly<
  Record<string, { displayName: string; displaySymbol: string; sourceRef: string }>
> = {
  US0378331005: {
    displayName: 'Apple Inc.',
    displaySymbol: 'AAPL',
    sourceRef:
      'https://assets.ctfassets.net/o10es7wu5gm1/6t7LV7NUfghwRYjZpReFYH/6e08881544b683a4c886aaa809c2d51a/Coinbase_Onchain_SPV_Ltd_-_Prospectus__AAPL__-_FSRA_VERSION.pdf#page=67',
  },
  US02079K3059: {
    displayName: 'Alphabet Inc. Class A',
    displaySymbol: 'GOOGL',
    sourceRef:
      'https://assets.ctfassets.net/o10es7wu5gm1/4Z7WbCZC0rQ6AkkEV6sBgX/b6ecb474929fa9b4802b258a7ef6e948/Coinbase_Onchain_SPV_Ltd_-_Prospectus__GOOGL__-_FSRA_VERSION.pdf#page=67',
  },
  US30303M1027: {
    displayName: 'Meta Platforms, Inc.',
    displaySymbol: 'META',
    sourceRef:
      'https://assets.ctfassets.net/o10es7wu5gm1/2gDWS1KtCTyWQzb5z0skEH/e179f6168f80a54d1bfc036df2ad7e99/Coinbase_Onchain_SPV_Ltd_-_Prospectus__META__-_FSRA_VERSION.pdf#page=67',
  },
  US67066G1040: {
    displayName: 'NVIDIA Corporation',
    displaySymbol: 'NVDA',
    sourceRef:
      'https://assets.ctfassets.net/o10es7wu5gm1/7N224uw3q8ouQcHhuzs9rx/c0326c67068da144f47db1c4b66a1ee5/Coinbase_Onchain_SPV_Ltd_-_Prospectus__NVDA__-_FSRA_VERSION.pdf#page=67',
  },
};

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const rpcUrl = rpcUrlV1();
  if (!rpcUrl.startsWith('https://'))
    throw new Error('a dedicated HTTPS Base Mainnet RPC is required');

  const official = createDatabaseOfficialAssetRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const reader = createB20ReaderV1({ rpcUrl });
  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok)
    throw new Error('Base block anchor unavailable; no identity decision was written');

  const identities = await official.officialAssets({
    chainId: 8453,
    limit: 1_000,
    sourceKind: 'base_docs_technical',
  });
  const observedAt = new Date().toISOString();
  let established = 0;
  let unknown = 0;
  let unread = 0;

  for (const identity of identities) {
    const address = identity.tokenAddress.toLowerCase();
    const result = await reader.call({
      to: address,
      data: EXTRA_METADATA_ISIN_CALL_V1,
      blockTag: anchor.value.blockTag,
    });
    if (!result.ok) {
      unread += 1;
      console.log(`${address}  unread — no claim written`);
      continue;
    }
    let isin: string;
    try {
      isin = (decodeStringV1(result.value) ?? '').trim().toUpperCase();
    } catch {
      unread += 1;
      console.log(`${address}  undecodable — no claim written`);
      continue;
    }
    const reviewed = REVIEWED_PROSPECTUS_BY_UNDERLYING_ISIN_V1[isin];
    if (!reviewed) {
      unknown += 1;
      console.log(`${address}  ${isin || 'empty'} — no reviewed identifier match`);
      continue;
    }
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          chainId: 8453,
          address,
          isin,
          blockNumber: anchor.value.blockNumber,
          blockHash: anchor.value.blockHash,
          sourceRef: reviewed.sourceRef,
        }),
      )
      .digest('hex');
    if (!dry) {
      await underlyings.declareUnderlying({
        underlyingKey: `security:isin:${isin}`,
        assetClass: 'equity',
        canonicalName: reviewed.displayName,
        displaySymbol: reviewed.displaySymbol,
        identifierScheme: 'isin',
        identifierValue: isin,
        sourceKind: 'coinbase_b20_metadata',
        sourceRef: reviewed.sourceRef,
        sourceHash,
        observedAt,
      });
      await underlyings.bindRepresentation({
        chainId: 8453,
        tokenAddress: address,
        underlyingKey: `security:isin:${isin}`,
        sourceKind: 'coinbase_b20_metadata',
        sourceRef: `${reviewed.sourceRef}#extraMetadata(isin)`,
        sourceHash,
        issuerId: 'coinbase',
        issuerInstrumentKey: `coinbase:b20_address:${address}`,
        caip10: `eip155:8453:${address}`,
        representationKind: 'b20_asset',
        evidenceStrength: 'reviewed_machine_mapping_with_onchain_cross_check',
        observedBlockNumber: anchor.value.blockNumber,
        observedBlockHash: anchor.value.blockHash,
        observedAt,
      });
    }
    established += 1;
    console.log(`${address}  ${isin} established${dry ? ' (dry)' : ''}`);
  }
  console.log(
    `underlying identity at Base block ${anchor.value.blockNumber}: ${established} established, ${unknown} unknown, ${unread} unread`,
  );
}

main()
  .catch((error) => {
    console.error(
      'underlying identity enrichment failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
