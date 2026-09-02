import type { DinariStockV1 } from './dinariStockApi.js';
import { baseRepresentationsOfV1 } from './dinariStockApi.js';

// ---------------------------------------------------------------------------
// The half of the Dinari binding the catalogue cannot supply from sandbox.
//
// `baseRepresentationsOfV1` is the real answer: the issuer names its own Base
// contracts in `tokens`, and when it does, nothing here is needed. In the
// SANDBOX environment that array carries test-chain addresses only — Dinari's
// own devnet and Sepolia — so a hundred dShares that plainly exist on Base
// match nothing, and production access is gated behind a verification form that
// is currently closed.
//
// WHY A SYMBOL JOIN IS ALLOWED HERE, WHEN A TICKER IDENTIFIES NOTHING
//
// Because both sides are the same issuer's own publication of the same record:
// the contract's `symbol()` was set by Dinari's factory, and the catalogue row's
// `symbol` is Dinari's own. This is not "the market calls this AAPL"; it is one
// party's two statements about one instrument, reconciled.
//
// And it is only allowed while the reconciliation is unambiguous. A symbol that
// appears twice on either side refuses every contract carrying it rather than
// picking one — two different contracts filed under one name is the exact
// failure this product exists to prevent.
//
// The key issued is still `dinari:stock_id:<uuid>`, the scheme this repository
// already accepts from this source. The composite FIGI is not the key: it is
// the CROSS-CHECK, put to the registry that issues FIGIs before anything is
// stored, and the same answer says whether the row is a common stock or a fund.
// ---------------------------------------------------------------------------

export interface DinariOnchainDShareV1 {
  tokenAddress: string;
  /** As read from the contract. Null when `symbol()` did not answer. */
  symbol: string | null;
}

export type DinariSymbolRefusalV1 =
  | 'no_symbol_onchain'
  | 'symbol_not_in_catalogue'
  | 'duplicate_symbol_onchain'
  | 'duplicate_symbol_in_catalogue';

export interface DinariSymbolMatchV1 {
  tokenAddress: string;
  onchainSymbol: string;
  joinSymbol: string;
  stock: DinariStockV1;
  /** True when the issuer named this exact Base address itself, in which case
   * the symbol was not needed and the binding is stronger. */
  namedByIssuer: boolean;
}

export interface DinariSymbolJoinV1 {
  matched: DinariSymbolMatchV1[];
  refused: { tokenAddress: string; symbol: string | null; reason: DinariSymbolRefusalV1 }[];
}

/**
 * `AAPL.dw` and `AAPL` are the same security.
 *
 * Dinari deploys a wrapped variant beside the plain one and marks it with a
 * `.dw` suffix. The catalogue carries the bare symbol only, so without this
 * roughly half the contracts join to nothing — and with it both variants bind
 * to the security they are both a representation of.
 */
export function normaliseDShareSymbolV1(symbol: string | null | undefined): string | null {
  if (!symbol) return null;
  const trimmed = symbol.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  return trimmed.endsWith('.DW') ? trimmed.slice(0, -3) : trimmed;
}

export function joinDinariBySymbolV1(input: {
  onchain: readonly DinariOnchainDShareV1[];
  catalogue: readonly DinariStockV1[];
  chainId?: number;
}): DinariSymbolJoinV1 {
  const chainId = input.chainId ?? 8453;

  // The issuer's own address list first. Anything it names is matched by
  // ADDRESS and never needs a symbol.
  const stockByNamedAddress = new Map<string, DinariStockV1>();
  for (const stock of input.catalogue) {
    for (const address of baseRepresentationsOfV1(stock, chainId)) {
      stockByNamedAddress.set(address.toLowerCase(), stock);
    }
  }

  const stockBySymbol = new Map<string, DinariStockV1>();
  const duplicateCatalogueSymbols = new Set<string>();
  for (const stock of input.catalogue) {
    const symbol = normaliseDShareSymbolV1(stock.symbol);
    if (!symbol) continue;
    if (stockBySymbol.has(symbol)) duplicateCatalogueSymbols.add(symbol);
    stockBySymbol.set(symbol, stock);
  }

  // A repeated symbol on chain is only a problem when it is the EXACT same
  // symbol on two contracts. `AAPL` and `AAPL.dw` normalise together on
  // purpose: they are two representations of one security, which is a thing
  // this model already has a shape for.
  const exactCounts = new Map<string, number>();
  for (const row of input.onchain) {
    const exact = row.symbol?.trim().toUpperCase();
    if (exact) exactCounts.set(exact, (exactCounts.get(exact) ?? 0) + 1);
  }

  const matched: DinariSymbolMatchV1[] = [];
  const refused: DinariSymbolJoinV1['refused'] = [];
  for (const row of input.onchain) {
    const address = row.tokenAddress.toLowerCase();
    const named = stockByNamedAddress.get(address);
    const exact = row.symbol?.trim().toUpperCase() ?? null;
    if (named) {
      matched.push({
        tokenAddress: address,
        onchainSymbol: exact ?? named.symbol.toUpperCase(),
        joinSymbol: normaliseDShareSymbolV1(named.symbol) ?? named.symbol.toUpperCase(),
        stock: named,
        namedByIssuer: true,
      });
      continue;
    }
    const joinSymbol = normaliseDShareSymbolV1(row.symbol);
    if (!exact || !joinSymbol) {
      refused.push({ tokenAddress: address, symbol: row.symbol, reason: 'no_symbol_onchain' });
      continue;
    }
    if ((exactCounts.get(exact) ?? 0) > 1) {
      refused.push({ tokenAddress: address, symbol: exact, reason: 'duplicate_symbol_onchain' });
      continue;
    }
    if (duplicateCatalogueSymbols.has(joinSymbol)) {
      refused.push({ tokenAddress: address, symbol: exact, reason: 'duplicate_symbol_in_catalogue' });
      continue;
    }
    const stock = stockBySymbol.get(joinSymbol);
    if (!stock) {
      refused.push({ tokenAddress: address, symbol: exact, reason: 'symbol_not_in_catalogue' });
      continue;
    }
    matched.push({
      tokenAddress: address,
      onchainSymbol: exact,
      joinSymbol,
      stock,
      namedByIssuer: false,
    });
  }
  return { matched, refused };
}
