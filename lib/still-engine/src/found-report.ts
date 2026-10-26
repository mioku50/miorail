// Browser-safe evidence for Found. Raw token amounts and USD estimates remain separate.
export type FoundVenueId = 'uniswap-v3' | 'aerodrome-unstaked' | 'aerodrome-rewards';
export interface FoundAmount { token: string; raw: string }
export interface FoundClaim { contract: string; tokenId: string | null; amounts: FoundAmount[] }
export interface FoundVenue {
  id: FoundVenueId;
  label: string;
  state: 'waiting' | 'reading' | 'complete' | 'partial';
  unit: 'NFTs' | 'gauges';
  coverage: { total: number | null; visited: number; measured: number; failed: number };
  positions: number | null;
  amounts: FoundAmount[];
  /** Positive balance deltas, with the NFT or gauge that produced each one. */
  claims: FoundClaim[];
  issues: string[];
}
export interface FoundToken extends FoundAmount {
  symbol: string | null;
  decimals: number | null;
  valueCents: string | null;
  quote: { source: 'DefiLlama'; usd: string; at: string; confidence: number } | null;
}
export interface FoundReport {
  kind: 'still.found';
  version: 1;
  address: string;
  state: 'queued' | 'reading' | 'complete' | 'partial' | 'unavailable';
  reading: { block: string; blockTime: string; assembledAt: string } | null;
  discovery: { voterPools: number | null; classifiedPools: number; unidentifiedPools: number; nftManagers: number };
  venues: FoundVenue[];
  tokens: FoundToken[];
  /** Known priced amounts only. Null until at least one amount was priced, or all measured zero. */
  valueCents: string | null;
  valueComplete: boolean;
  notMeasured: string[];
}

export function emptyFoundReport(address: string): FoundReport {
  return {
    kind: 'still.found', version: 1, address, state: 'queued', reading: null,
    discovery: { voterPools: null, classifiedPools: 0, unidentifiedPools: 0, nftManagers: 0 },
    venues: [
      { id: 'uniswap-v3', label: 'Uniswap v3 collectible tokens', unit: 'NFTs' },
      { id: 'aerodrome-unstaked', label: 'Aerodrome unstaked collectible tokens', unit: 'NFTs' },
      { id: 'aerodrome-rewards', label: 'Aerodrome staked AERO rewards', unit: 'gauges' },
    ].map((v) => ({ ...v, state: 'waiting', coverage: { total: null, visited: 0, measured: 0, failed: 0 }, positions: null, amounts: [], claims: [], issues: [] })) as FoundVenue[],
    tokens: [], valueCents: null, valueComplete: false,
    notMeasured: ['Uniswap v4', 'Aerodrome V2', 'Positions held through vaults, lockers or other accounts'],
  };
}
