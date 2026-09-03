// ---------------------------------------------------------------------------
// Discovery aliases — a name for a security, never a name for a contract.
//
// Most reviewed rows carry the TICKER in both name fields, because issuer
// enrichment does not always reach a company name: `NVDA` is stored with the
// canonical name `NVDA`. So "nvidia" matched nothing, and a caller was told to
// try the ticker — honest, and useless to anyone who does not already know it.
//
// The rule that keeps this safe is the one the whole product runs on: an alias
// resolves to a SECURITY, and a security is identified by its ISIN. It never
// resolves to an address, an issuer or a representation. Two consequences
// follow, and both are the point:
//
//   * A row matches an alias only when the row's own stored identifier is that
//     exact ISIN. If a ticker is ever rebound to a different security, the
//     alias stops matching rather than pointing at the wrong company.
//   * Matching an alias still returns every representation of that security,
//     from every issuer, unchosen. Discovery widens; it never selects.
//
// The list is deliberately short. It exists for reviewed rows whose stored
// naming is a ticker and nothing else — a row that already carries a real
// company name is found by the ordinary substring match and needs no entry.
// ---------------------------------------------------------------------------

export interface DiscoveryAliasV1 {
  /** What a person types, lowercased. */
  readonly name: string;
  /** The ISIN this is a name for. Verified against the reviewed row it covers. */
  readonly isin: string;
}

export const REVIEWED_DISCOVERY_ALIASES_V1: readonly DiscoveryAliasV1[] = [
  { name: 'nvidia', isin: 'US67066G1040' }, // NVDA
  { name: 'tesla', isin: 'US88160R1014' }, // TSLA
  { name: 'microsoft', isin: 'US5949181045' }, // MSFT
  { name: 'google', isin: 'US02079K3059' }, // GOOGL
  { name: 'alphabet', isin: 'US02079K3059' }, // GOOGL
  { name: 'coinbase', isin: 'US19260Q1076' }, // COIN
  { name: 'gamestop', isin: 'US36467W1099' }, // GME
  { name: 'microstrategy', isin: 'US5949724083' }, // MSTR
  // The company's current legal name. Kept because it is what a reader would
  // type today, and it can only ever reach this one ISIN.
  { name: 'strategy', isin: 'US5949724083' }, // MSTR
] as const;

/**
 * The shortest query an alias will answer.
 *
 * Two characters can be inside almost any word, and an alias firing on "st"
 * would quietly widen every search. The ordinary substring match is unaffected
 * — it keeps its own behaviour for short queries.
 */
export const DISCOVERY_ALIAS_MIN_QUERY_V1 = 3;

/**
 * The ISINs a query names through an alias.
 *
 * Matches in both directions on purpose. "nvid" should reach NVIDIA, and so
 * should "nvidia corporation" — the stored-value substring match can only do
 * the first, because it asks whether the STORED text contains the query.
 */
export function discoveryAliasIsinsV1(rawQuery: string): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < DISCOVERY_ALIAS_MIN_QUERY_V1) return [];
  const hits = REVIEWED_DISCOVERY_ALIASES_V1.filter(
    (alias) => alias.name.includes(query) || query.includes(alias.name),
  ).map((alias) => alias.isin);
  return [...new Set(hits)];
}
