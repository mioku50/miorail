import type { UnderlyingAssetRepositoryV1 } from '@mioagent/route-storage';
import { isValidIsinV1 } from '@mioagent/route-storage';
import { OFFICIAL_SOURCES_V1, type OfficialSourceAssetV1 } from '@mioagent/rwa-official';

/** API identity has its own provenance and never borrows an onchain anchor.
 * Retain already reviewed bindings when they agree. A changed ISIN is a review
 * conflict, not permission to silently reassign a holder's stock to a company.
 */
export async function bindCoinbaseStocksApiV1(input: {
  assets: readonly OfficialSourceAssetV1[];
  underlyings: UnderlyingAssetRepositoryV1;
  sourceHash: string;
  observedAt: string;
}): Promise<{ established: number; retained: number; conflicts: string[] }> {
  const result = { established: 0, retained: 0, conflicts: [] as string[] };
  for (const asset of input.assets) {
    const isin = asset.underlyingIsin;
    if (!isin || !isValidIsinV1(isin))
      throw new Error('Coinbase API binding requires a checked ISIN');
    const underlyingKey = `security:isin:${isin}`;
    const existing = await input.underlyings.underlyingOf({
      chainId: 8453,
      tokenAddress: asset.tokenAddress,
    });
    if (existing) {
      if (existing.underlying.underlyingKey !== underlyingKey) {
        result.conflicts.push(asset.tokenAddress);
        continue;
      }
      if (existing.binding.sourceKind !== 'coinbase_stocks_api') {
        result.retained += 1;
        continue;
      }
    }
    const sourceRef = `${OFFICIAL_SOURCES_V1.coinbase_stocks_api.url}#${asset.tokenAddress}`;
    await input.underlyings.declareUnderlying({
      underlyingKey,
      assetClass: 'equity',
      canonicalName: asset.displayName ?? `ISIN ${isin}`,
      displaySymbol: asset.ticker.endsWith('c') ? asset.ticker.slice(0, -1) : asset.ticker,
      identifierScheme: 'isin',
      identifierValue: isin,
      sourceKind: 'coinbase_stocks_api',
      sourceRef,
      sourceHash: input.sourceHash,
      observedAt: input.observedAt,
    });
    await input.underlyings.bindRepresentation({
      chainId: 8453,
      tokenAddress: asset.tokenAddress,
      underlyingKey,
      sourceKind: 'coinbase_stocks_api',
      sourceRef,
      sourceHash: input.sourceHash,
      issuerId: 'coinbase',
      issuerInstrumentKey: `coinbase:b20_address:${asset.tokenAddress}`,
      caip10: `eip155:8453:${asset.tokenAddress}`,
      representationKind: 'b20_asset',
      evidenceStrength: 'reviewed_machine_address_mapping',
      observedBlockNumber: null,
      observedBlockHash: null,
      observedAt: input.observedAt,
    });
    result.established += 1;
  }
  return result;
}
