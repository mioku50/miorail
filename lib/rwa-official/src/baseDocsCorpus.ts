import {
  TICKER_SHAPE_V1,
  isAddressV1,
  type OfficialParseResultV1,
  type OfficialSourceAssetV1,
} from './sources.js';

// ---------------------------------------------------------------------------
// The complete issuance corpus, read out of Base's own integration guide.
//
// The document publishes two tables: the contract addresses, and the Chainlink
// proxies that carry each asset's reference value. This reads both and binds
// them, and the binding is the one place a ticker is allowed to matter -- it
// is the document's own key, joining two of its own tables, never a claim that
// a contract named AAPLc anywhere is this asset.
//
// The parser refuses rather than guesses. An empty corpus is a refusal, not an
// answer, because the day this page changes shape "zero official assets" would
// otherwise be indistinguishable from the truth.
// ---------------------------------------------------------------------------

// The asset table is found by its OWN header row first, and only then by the
// heading above it. That order exists because the heading has already been
// renamed once: when Base moved this document from `base-chain/asset-issuance/`
// to `build-on-base/integrate-defi/` the heading became `## Contract
// Addresses`, and that one capital letter left the corpus unparsable for two
// days -- long enough to have missed an issuance. A table's header row names
// its own columns, which is the part an integrator reads and the part a
// restyle cannot move; the heading stays as the fallback for a document that
// drops the header row instead.
const ADDRESS_TABLE_HEADER_V1 = /^[ \t]*\|[ \t]*Ticker[ \t]*\|[ \t]*Contract address[ \t]*\|/im;
const ADDRESS_HEADING_V1 = /^[ \t]*##[ \t]+Contract addresses[ \t]*$/im;
const FEED_TABLE_MARKER_V1 = '| Feed';

interface TableRowV1 {
  label: string;
  address: string;
}

/** Markdown table rows, as label plus the first address in the row. Separator
 * and header rows carry no address and drop out on their own. */
function tableRowsV1(block: string): TableRowV1[] {
  const rows: TableRowV1[] = [];
  for (const line of block.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const address = cells[1].replace(/`/g, '').trim();
    if (!isAddressV1(address)) continue;
    const label = cells[0].replace(/`/g, '').trim();
    if (label.length === 0) continue;
    rows.push({ label, address });
  }
  return rows;
}

/** Where the asset table begins, and the block that carries it. The block runs
 * to the next heading, so a table that is followed by prose keeps its rows and
 * a table that is followed by another section cannot absorb it. */
function addressSectionV1(markdown: string): { start: number; block: string } | null {
  for (const anchor of [ADDRESS_TABLE_HEADER_V1, ADDRESS_HEADING_V1]) {
    const found = anchor.exec(markdown);
    if (!found) continue;
    const rest = markdown.slice(found.index);
    const end = rest.search(/\n## /);
    return { start: found.index, block: end < 0 ? rest : rest.slice(0, end) };
  }
  return null;
}

/**
 * The feed a ticker binds to, or null.
 *
 * Exact match only. The document names feeds after the UNDERLYING equity
 * ("Coinbase AAPL") and assets after the token ("AAPLc"), so the bind drops
 * the token suffix and requires the rest to match character for character. A
 * near miss binds nothing, because a reference value attached to the wrong
 * asset is worse than no reference value at all.
 */
function feedForTickerV1(ticker: string, feeds: Map<string, string>): string | null {
  const exact = feeds.get(`Coinbase ${ticker}`);
  if (exact) return exact;
  if (!ticker.endsWith('c')) return null;
  return feeds.get(`Coinbase ${ticker.slice(0, -1)}`) ?? null;
}

export function parseBaseDocsCorpusV1(markdown: string): OfficialParseResultV1 {
  const section = addressSectionV1(markdown);
  if (section === null) {
    return {
      ok: false,
      refusal: 'contract_address_table_missing',
      detail:
        'the document carries neither a "| Ticker | Contract address |" table nor a contract-address heading',
    };
  }

  const feeds = new Map<string, string>();
  // The feed table lives in the price-feeds section, above the addresses. It is
  // found by its own header row rather than by a heading, because the heading
  // around it is prose that has been reworded before.
  const feedStart = markdown.indexOf(FEED_TABLE_MARKER_V1);
  if (feedStart >= 0 && feedStart < section.start) {
    // Bounded at the address heading, so the asset table cannot leak into the
    // feed map and bind an asset to its own address.
    for (const row of tableRowsV1(markdown.slice(feedStart, section.start))) {
      if (!feeds.has(row.label)) feeds.set(row.label, row.address.toLowerCase());
    }
  }

  const assets: OfficialSourceAssetV1[] = [];
  const otherEntries: { label: string; address: string }[] = [];
  const seenAddresses = new Set<string>();
  const seenTickers = new Set<string>();

  for (const row of tableRowsV1(section.block)) {
    const tokenAddress = row.address.toLowerCase();
    if (!TICKER_SHAPE_V1.test(row.label)) {
      otherEntries.push({ label: row.label, address: tokenAddress });
      continue;
    }
    if (seenAddresses.has(tokenAddress)) {
      return {
        ok: false,
        refusal: 'duplicate_address',
        detail: `the corpus lists ${tokenAddress} more than once`,
      };
    }
    if (seenTickers.has(row.label)) {
      return {
        ok: false,
        refusal: 'duplicate_ticker',
        detail: `the corpus lists the ticker ${row.label} more than once`,
      };
    }
    seenAddresses.add(tokenAddress);
    seenTickers.add(row.label);
    assets.push({
      tokenAddress,
      ticker: row.label,
      displayName: null,
      referenceFeedAddress: feedForTickerV1(row.label, feeds),
    });
  }

  if (assets.length === 0) {
    return {
      ok: false,
      refusal: 'no_asset_rows',
      detail: 'the contract address section carried no row that looks like a ticker and an address',
    };
  }
  return { ok: true, assets, otherEntries };
}
