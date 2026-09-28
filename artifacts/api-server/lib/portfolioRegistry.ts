import { client } from '@mioagent/db';
import { createDatabaseOfficialAssetRepository, type OfficialAssetIdentityV1 } from '@mioagent/route-storage';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// A wallet's tokens, against Miorail's official asset registry.
//
// The balance provider names a token by the symbol its contract chose, and a
// contract can choose anything. A wallet on production held 15 "AAPLc" named
// "Apple Inc," at 0x2a97…8636, and the balances card listed it beside the
// real NVDAc as one more holding. The official AAPLc is 0xb200…d1fb. The
// provider did not flag it as spam, so nothing on the screen said so.
//
// Two marks, both joined by ADDRESS:
//   * `official` — this contract is an issuer-published asset;
//   * `lookalike` — it wears an official asset's ticker at another address.
// A resemblance is two strings that matched and two addresses that did not.
// It is never a claim about who made the contract or why.
// ---------------------------------------------------------------------------

export interface PortfolioRegistryMarkV1 {
  standing: 'official' | 'lookalike';
  /** The official ticker, as its issuer publishes it. */
  ticker: string;
  /** For a lookalike: the contract that ticker belongs to. */
  officialAddress?: string;
}

/**
 * The names an official asset is protected under.
 *
 * Its published ticker, and for Coinbase the stock's own ticker as well: the
 * token behind "NVDAc" calls itself "NVDA" onchain, so another "NVDA" is the
 * closer copy. Backed's roots are not protected. "bHIGH" and "bCOIN" would
 * make every token called HIGH or COIN a lookalike.
 */
function protectedNamesV1(asset: OfficialAssetIdentityV1): { name: string; ticker: string }[] {
  const tickers = [...new Set(asset.listings.map((listing) => listing.ticker).filter(Boolean))];
  const names: { name: string; ticker: string }[] = [];
  for (const ticker of tickers) {
    names.push({ name: ticker.toLowerCase(), ticker });
    if (asset.issuer === 'coinbase' && /^[A-Z0-9]{2,}c$/.test(ticker)) {
      names.push({ name: ticker.slice(0, -1).toLowerCase(), ticker });
    }
  }
  return names;
}

/** Marks by lowercase address; a token the registry says nothing about is absent. */
export function portfolioRegistryMarksV1(
  tokens: readonly { symbol: string; address: string }[],
  officials: readonly OfficialAssetIdentityV1[],
): Map<string, PortfolioRegistryMarkV1> {
  const byAddress = new Map(officials.map((asset) => [asset.tokenAddress.toLowerCase(), asset]));
  const byName = new Map<string, { ticker: string; officialAddress: string }>();
  // Coinbase first: when a name is protected twice, the stock's own ticker
  // names the closer copy.
  const ordered = [...officials].sort((left, right) => Number(right.issuer === 'coinbase') - Number(left.issuer === 'coinbase'));
  for (const asset of ordered) {
    for (const entry of protectedNamesV1(asset)) {
      if (!byName.has(entry.name)) byName.set(entry.name, { ticker: entry.ticker, officialAddress: asset.tokenAddress.toLowerCase() });
    }
  }

  const marks = new Map<string, PortfolioRegistryMarkV1>();
  for (const token of tokens) {
    const address = token.address.toLowerCase();
    const official = byAddress.get(address);
    if (official) {
      const ticker = official.listings.find((listing) => listing.ticker)?.ticker;
      if (ticker) marks.set(address, { standing: 'official', ticker });
      continue;
    }
    const resembled = byName.get(token.symbol.trim().toLowerCase());
    if (resembled) marks.set(address, { standing: 'lookalike', ticker: resembled.ticker, officialAddress: resembled.officialAddress });
  }
  return marks;
}

const REGISTRY_TTL_MS_V1 = 5 * 60_000;
let cached: { at: number; assets: Promise<OfficialAssetIdentityV1[]> } | null = null;

/** A testing seam; production never replaces it. */
export const portfolioRegistryRuntime = {
  now: (): number => Date.now(),
  /** The registry changes when an issuer publishes, so five minutes is fresh. */
  officialAssets: (): Promise<OfficialAssetIdentityV1[]> => {
    const now = portfolioRegistryRuntime.now();
    if (!cached || now - cached.at > REGISTRY_TTL_MS_V1) {
      const assets = createDatabaseOfficialAssetRepository(client).officialAssets({ chainId: 8453, limit: 500 });
      cached = { at: now, assets };
      assets.catch(() => {
        if (cached?.assets === assets) cached = null;
      });
    }
    return cached.assets;
  },
};

/**
 * The same tokens, each carrying its registry mark when it has one.
 *
 * Mainnet only: the registry is Base mainnet's. A registry Miorail could not
 * read leaves every token unmarked, which says nothing either way, and logs
 * a code.
 */
export async function withRegistryMarksV1<T extends { symbol: string; address: string }>(
  tokens: readonly T[],
  chainEnv: string,
): Promise<(T & { registry?: PortfolioRegistryMarkV1 })[]> {
  if (chainEnv !== 'mainnet' || tokens.length === 0) return [...tokens];
  let officials: OfficialAssetIdentityV1[];
  try {
    officials = await portfolioRegistryRuntime.officialAssets();
  } catch {
    logger.warn('Portfolio registry read failed', { code: 'portfolio_registry_unread' });
    return [...tokens];
  }
  const marks = portfolioRegistryMarksV1(tokens, officials);
  return tokens.map((token) => {
    const mark = marks.get(token.address.toLowerCase());
    return mark ? { ...token, registry: mark } : token;
  });
}

export function clearPortfolioRegistryCacheForTests(): void {
  cached = null;
}
