import type { ReviewedIssuerIdV1 } from './issuers.js';

// ---------------------------------------------------------------------------
// Who Base says supports these stocks, against who Miorail can see supporting
// THIS address.
//
// Base's own stocks page names thirty apps, each with a sentence about what it
// does with tokenized stocks: three lenders, seven places to swap or route, an
// oracle, wallets, vaults, analytics. A reader arrives having read that page.
// Miorail's DeFi card checks four lending venues and answers about those four,
// which is correct and is not the question the reader came with.
//
// The gap between the two is the product. It is the same gap the Aave
// announcement opened — see venueAnnouncements.ts, which this file deliberately
// mirrors — widened from one claim to a registry: a claim is a dated sentence
// by a named party, a reading is what a venue's own data says about one exact
// address, and the two never merge.
//
// Three rules hold the whole file up.
//
//  1. A CLAIM IS NEVER A MEASUREMENT. Being on Base's page is not evidence
//     that an app touches this contract. Nothing here can colour a chip green
//     on its own, enter `establishedDefiUsesV1`, or make a use axis true.
//  2. `unchecked` IS NOT `not_listed`. Twenty-four of the thirty are apps
//     Miorail does not read at all. Rendering that silence as a refusal would
//     publish our own reach under somebody else's name — the exact failure
//     this project has shipped by accident more than once.
//  3. THE REGISTRY IS REVIEWED, THE BINDING IS JUDGED. The names and the
//     sentences are Base's, quoted; deciding that the card "Morpho" is the
//     venue we read as `morpho` is a human call, so it is pinned here with a
//     date rather than guessed from a string match at runtime.
// ---------------------------------------------------------------------------

/** What the app does with the asset, in the reader's terms rather than ours. */
export type EcosystemCategoryV1 =
  | 'issuance'
  | 'oracle'
  | 'exchange'
  | 'routing'
  | 'lending'
  | 'yield'
  | 'analytics'
  | 'wallet';

/**
 * What Miorail would read to find out whether this app touches one address.
 *
 * `none` is a first-class member, not a gap to be filled in later. It says the
 * honest thing about twenty-four of the thirty: there is no reading behind
 * them, so the row can only ever report the claim.
 */
export type EcosystemBindingV1 =
  | { kind: 'defi_venue'; venueId: string }
  | { kind: 'pool_venue'; venueIds: readonly string[] }
  | { kind: 'route_source'; sourceId: string }
  | { kind: 'reference_feed' }
  | { kind: 'issuer_of_record'; issuerId: ReviewedIssuerIdV1 }
  | { kind: 'none' };

export interface ReviewedEcosystemAppV1 {
  appId: string;
  appName: string;
  /** Base's own sentence about this app, verbatim. Never rewritten by us. */
  claim: string;
  category: EcosystemCategoryV1;
  binding: EcosystemBindingV1;
}

/**
 * Where the list came from and when a human read it.
 *
 * The same document the product-list corpus is parsed from, so the thirty
 * names and the ten addresses were published side by side on one page. The
 * date is when the cards were reviewed, not when the page was last fetched:
 * the addresses are re-read every six hours, these sentences are not.
 */
export const BASE_STOCKS_ECOSYSTEM_SOURCE_V1 = {
  listedBy: 'Base',
  sourceTitle: 'Coinbase Tokenized Stocks',
  sourceRef: 'https://brand.base.org/stocks',
  reviewedAt: '2026-09-12',
} as const;

/**
 * The thirty apps Base's stocks page names, in the page's own order.
 *
 * Six carry a binding Miorail can actually read. That ratio is not a gap to be
 * apologised for in prose — it is the measurement this card exists to publish,
 * and it is why `unchecked` has copy of its own.
 */
export const BASE_STOCKS_ECOSYSTEM_V1: readonly ReviewedEcosystemAppV1[] = [
  {
    appId: 'aerodrome',
    appName: 'Aerodrome',
    claim: 'Deep liquidity for tokenized stock trading pairs.',
    category: 'exchange',
    // Both factories: the published concentrated-liquidity factory is not the
    // one the deepest pool sits in, and a binding to a single id would have
    // missed exactly the pool that holds the money.
    binding: { kind: 'pool_venue', venueIds: ['aerodrome_cl', 'aerodrome_v2'] },
  },
  {
    appId: 'aave',
    appName: 'Aave',
    claim: 'Lend and borrow against tokenized stock positions.',
    category: 'lending',
    binding: { kind: 'defi_venue', venueId: 'aave_v3' },
  },
  {
    appId: 'chainlink',
    appName: 'Chainlink',
    claim: 'Price feeds and data infrastructure for tokenized stocks.',
    category: 'oracle',
    binding: { kind: 'reference_feed' },
  },
  {
    appId: 'coinbase',
    appName: 'Coinbase',
    claim: 'The issuer of tokenized stocks on Base.',
    category: 'issuance',
    binding: { kind: 'issuer_of_record', issuerId: 'coinbase' },
  },
  {
    appId: '0x',
    appName: '0x',
    claim: 'Swap tokenized stocks with aggregated DEX liquidity.',
    category: 'routing',
    binding: { kind: 'none' },
  },
  {
    appId: 'morpho',
    appName: 'Morpho',
    claim: 'Lend and borrow tokenized stocks with optimized rates.',
    category: 'lending',
    binding: { kind: 'defi_venue', venueId: 'morpho' },
  },
  {
    appId: '1inch',
    appName: '1inch',
    claim: 'Find the best rates across Base DEXs for stock swaps.',
    category: 'routing',
    binding: { kind: 'none' },
  },
  {
    appId: 'euler',
    appName: 'Euler',
    claim: 'Modular lending and borrowing for tokenized stocks.',
    category: 'lending',
    // Base names three lenders and Miorail reads two of them. Leaving this
    // `none` is what makes that sentence true on the screen instead of only in
    // a backlog.
    binding: { kind: 'none' },
  },
  {
    appId: 'kyberswap',
    appName: 'KyberSwap',
    claim: 'Efficient token swaps with concentrated liquidity.',
    category: 'routing',
    binding: { kind: 'route_source', sourceId: 'kyberswap' },
  },
  {
    appId: 'cow_swap',
    appName: 'CoW Swap',
    claim: 'MEV-protected trading for tokenized stock orders.',
    category: 'routing',
    binding: { kind: 'none' },
  },
  {
    appId: 'beefy',
    appName: 'Beefy',
    claim: 'Auto-compounding vaults for tokenized stock yields.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'glider',
    appName: 'Glider',
    claim: 'Track performance and automate portfolio strategies.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
  {
    appId: 'superform',
    appName: 'Superform',
    claim: 'Cross-chain yield strategies with tokenized stocks.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'lifi',
    appName: 'LI.FI',
    claim: 'Bridge and swap tokenized stocks across chains.',
    category: 'routing',
    binding: { kind: 'none' },
  },
  {
    appId: 'steakhouse',
    appName: 'Steakhouse',
    claim: 'Risk analytics and portfolio insights for onchain stocks.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
  {
    appId: 'bitget_wallet',
    appName: 'Bitget Wallet',
    claim: 'Mobile wallet for managing tokenized stock positions.',
    category: 'wallet',
    binding: { kind: 'none' },
  },
  {
    appId: 'sosovalue',
    appName: 'SoSoValue',
    claim: 'Research and analytics for tokenized stock markets.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
  {
    appId: 'grow',
    appName: 'Grow',
    claim: 'Simplified DeFi investing with tokenized stocks.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'liminal_cash',
    appName: 'Liminal Cash',
    claim: 'Onchain cash management with tokenized stocks.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'matcha',
    appName: 'Matcha',
    claim: 'DEX aggregator for the best token swap prices.',
    category: 'routing',
    binding: { kind: 'none' },
  },
  {
    appId: 'avici',
    appName: 'Avici',
    claim: 'Social trading platform for tokenized stocks.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
  {
    appId: 'zoth',
    appName: 'Zoth',
    claim: 'Institutional-grade RWA infrastructure.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'reserve',
    appName: 'Reserve',
    claim: 'Stablecoin infrastructure powering stock settlements.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'dialectic',
    appName: 'Dialectic',
    claim: 'Quantitative research and trading strategies.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
  {
    appId: 'centrifuge',
    appName: 'Centrifuge',
    claim: 'Real-world asset financing infrastructure.',
    category: 'issuance',
    binding: { kind: 'none' },
  },
  {
    appId: 'okx_wallet',
    appName: 'OKX Wallet',
    claim: 'Multi-chain wallet for managing tokenized stocks.',
    category: 'wallet',
    binding: { kind: 'none' },
  },
  {
    appId: 'ample_money',
    appName: 'Ample.Money',
    claim: 'Save in stablecoins and automatically enter prize draws.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'fomo',
    appName: 'Fomo',
    claim: 'Mobile-first wallet for tokenized stocks.',
    category: 'wallet',
    binding: { kind: 'none' },
  },
  {
    appId: 'makina',
    appName: 'Makina',
    claim: 'Vault infrastructure for institutional-grade onchain strategies.',
    category: 'yield',
    binding: { kind: 'none' },
  },
  {
    appId: 'zyfai',
    appName: 'ZyfAI',
    claim: 'AI-powered portfolio tools for tokenized stocks.',
    category: 'analytics',
    binding: { kind: 'none' },
  },
] as const;

/**
 * What was found when Miorail looked for this app's own data about one exact
 * address.
 *
 * The same four words the announcement readings use, and for the same reason:
 * a surface that already knows how to render "announced but not listed" must
 * not learn a second vocabulary for the identical distinction.
 */
export type EcosystemMeasuredV1 = 'listed' | 'not_listed' | 'unread' | 'unchecked';

export interface EcosystemClaimReadingV1 {
  app: ReviewedEcosystemAppV1;
  measured: EcosystemMeasuredV1;
  /**
   * What was read, in words a reader uses. Only ever set when something was.
   *
   * Deliberately carries no address, market id or selector: this string is
   * rendered on the consumer line beside the app's name, and the rule on these
   * screens is that a reader deciding what they can do is not helped by a
   * 32-byte market key. The key goes in `detail`, which the evidence drawer
   * renders and the card does not.
   */
  evidence: string | null;
  /** The id behind the reading, for the evidence drawer. Never on the card. */
  detail: string | null;
  /** Why the read failed. Only ever set for `unread`. */
  reason: string | null;
}

/** A venue listing, structurally. Kept structural so useAccess can import this
 * file without this file importing useAccess. */
export interface EcosystemVenueRowV1 {
  venueId: string;
  venueName: string;
  state: 'listed' | 'not_listed' | 'unread';
  curated?: boolean | null;
  marketRef?: string | null;
  reason?: string | null;
}

/** A measured pool row, structurally. Only the venue is needed here. */
export interface EcosystemPoolRowV1 {
  venueId: string | null;
}

/**
 * The routers Miorail asked, and the ones that came back with a route.
 *
 * Both lists, because the difference is the whole point: a router that was
 * never asked is `unchecked`, and only a router that was asked and returned
 * nothing is a router that did not route this address.
 */
export interface EcosystemRouteSourcesV1 {
  asked: readonly string[];
  quoted: readonly string[];
}

export interface EcosystemEvidenceV1 {
  /** Whose representation this is, so `issuer_of_record` can be answered. */
  issuerId: ReviewedIssuerIdV1 | null;
  venues?: readonly EcosystemVenueRowV1[];
  /** Null rather than an empty list when nobody measured the pools. */
  poolRows?: readonly EcosystemPoolRowV1[] | null;
  routeSources?: EcosystemRouteSourcesV1 | null;
  /** The reference feed the reviewed source binds to this address, if any. */
  referenceFeedAddress?: string | null;
  apps?: readonly ReviewedEcosystemAppV1[];
}

function venueReadingV1(
  app: ReviewedEcosystemAppV1,
  venueId: string,
  venues: readonly EcosystemVenueRowV1[] | undefined,
): EcosystemClaimReadingV1 {
  const row = venues?.find((venue) => venue.venueId === venueId);
  if (!row) return { app, measured: 'unchecked', evidence: null, detail: null, reason: null };
  if (row.state === 'unread') {
    return { app, measured: 'unread', evidence: null, detail: null, reason: row.reason ?? null };
  }
  if (row.state !== 'listed') {
    return { app, measured: 'not_listed', evidence: null, detail: null, reason: null };
  }
  // A permissionless market proves a market EXISTS, not that the venue
  // accepted the asset, and the difference belongs in the sentence rather than
  // in a stronger word.
  return {
    app,
    measured: 'listed',
    evidence:
      row.curated === false
        ? 'a market names this address, though the venue has not listed it'
        : 'the venue names this address',
    detail: row.marketRef ? `market ${row.marketRef}` : null,
    reason: null,
  };
}

/**
 * Every claim on the registry, read against this address.
 *
 * Order is the page's own, unchanged: re-sorting by outcome would put the apps
 * Miorail happens to read at the top and quietly present our coverage as the
 * ecosystem's shape.
 */
export function ecosystemClaimReadingsV1(
  evidence: EcosystemEvidenceV1,
): EcosystemClaimReadingV1[] {
  const apps = evidence.apps ?? BASE_STOCKS_ECOSYSTEM_V1;
  return apps.map((app): EcosystemClaimReadingV1 => {
    switch (app.binding.kind) {
      case 'defi_venue':
        return venueReadingV1(app, app.binding.venueId, evidence.venues);
      case 'pool_venue': {
        const rows = evidence.poolRows;
        if (!rows) return { app, measured: 'unchecked', evidence: null, detail: null, reason: null };
        const venueIds = app.binding.venueIds;
        const held = rows.filter((row) => row.venueId !== null && venueIds.includes(row.venueId));
        return held.length === 0
          ? { app, measured: 'not_listed', evidence: null, detail: null, reason: null }
          : {
              app,
              measured: 'listed',
              evidence: `holds this address in ${held.length} measured pool${held.length === 1 ? '' : 's'}`,
              detail: null,
              reason: null,
            };
      }
      case 'route_source': {
        const sources = evidence.routeSources;
        const sourceId = app.binding.sourceId;
        if (!sources || !sources.asked.includes(sourceId)) {
          return { app, measured: 'unchecked', evidence: null, detail: null, reason: null };
        }
        return sources.quoted.includes(sourceId)
          ? {
              app,
              measured: 'listed',
              evidence: 'returned a route for this address',
              detail: null,
              reason: null,
            }
          : { app, measured: 'not_listed', evidence: null, detail: null, reason: null };
      }
      case 'reference_feed': {
        const feed = evidence.referenceFeedAddress ?? null;
        return feed === null
          ? { app, measured: 'unchecked', evidence: null, detail: null, reason: null }
          : {
              app,
              measured: 'listed',
              evidence: 'a published reference feed is bound to this address',
              detail: `feed ${feed}`,
              reason: null,
            };
      }
      case 'issuer_of_record': {
        if (evidence.issuerId === null) {
          return { app, measured: 'unchecked', evidence: null, detail: null, reason: null };
        }
        return evidence.issuerId === app.binding.issuerId
          ? {
              app,
              measured: 'listed',
              evidence: 'issuer of record for this address',
              detail: null,
              reason: null,
            }
          : { app, measured: 'not_listed', evidence: null, detail: null, reason: null };
      }
      default:
        return { app, measured: 'unchecked', evidence: null, detail: null, reason: null };
    }
  });
}

export interface EcosystemTallyV1 {
  named: number;
  namesIt: number;
  doesNot: number;
  unread: number;
  unchecked: number;
}

export function ecosystemTallyV1(readings: readonly EcosystemClaimReadingV1[]): EcosystemTallyV1 {
  return {
    named: readings.length,
    namesIt: readings.filter((row) => row.measured === 'listed').length,
    doesNot: readings.filter((row) => row.measured === 'not_listed').length,
    unread: readings.filter((row) => row.measured === 'unread').length,
    unchecked: readings.filter((row) => row.measured === 'unchecked').length,
  };
}

/**
 * Miorail's own reading of the tally, written by no model.
 *
 * The dangerous sentence is not a number here either: it is the leap from
 * "twenty-four apps are not checked" to "twenty-four apps do not support this",
 * so the last clause is not optional and is never dropped when the count is
 * small.
 */
export function ecosystemSummaryV1(input: {
  displaySymbol: string | null;
  tokenAddress: string;
  readings: readonly EcosystemClaimReadingV1[];
}): string {
  const name = input.displaySymbol ?? input.tokenAddress;
  const tally = ecosystemTallyV1(input.readings);
  const read = tally.namesIt + tally.doesNot + tally.unread;
  const parts: string[] = [
    `${BASE_STOCKS_ECOSYSTEM_SOURCE_V1.listedBy} names ${tally.named} apps for tokenized stocks.`,
  ];
  if (read === 0) {
    parts.push(
      `Miorail reads none of them for ${name} on this call, so nothing here says whether any of them supports it.`,
    );
    return parts.join(' ');
  }
  const named = input.readings.filter((row) => row.measured === 'listed').map((row) => row.app.appName);
  const not = input.readings.filter((row) => row.measured === 'not_listed').map((row) => row.app.appName);
  parts.push(
    `Miorail reads ${read} of them for ${name}: ${
      named.length > 0 ? `${named.join(', ')} name this exact address` : 'none of them names this exact address'
    }${not.length > 0 ? `, ${not.join(', ')} do not` : ''}.`,
  );
  if (tally.unread > 0) {
    const unread = input.readings.filter((row) => row.measured === 'unread').map((row) => row.app.appName);
    parts.push(`${unread.join(', ')} could not be read on this call, so ${unread.length === 1 ? 'it said' : 'they said'} nothing either way.`);
  }
  if (tally.unchecked > 0) {
    parts.push(
      `The other ${tally.unchecked} are apps Miorail does not read at all. That is the limit of Miorail's reach, never a statement that they refused ${name} or that they do not support it.`,
    );
  }
  return parts.join(' ');
}

/** One registry row on the wire: the claim and the reading, flat and joined. */
export interface EcosystemAppRowV1 {
  appId: string;
  appName: string;
  claim: string;
  category: EcosystemCategoryV1;
  measured: EcosystemMeasuredV1;
  evidence: string | null;
  detail: string | null;
  reason: string | null;
}

/**
 * The whole card, ready to be carried by a payload.
 *
 * The source travels with the rows rather than sitting in a caption: a reader
 * — or an assistant — that sees the thirty names without seeing whose list
 * they are has been handed Miorail's opinion about an ecosystem.
 */
export interface RepresentationEcosystemV1 {
  listedBy: string;
  sourceTitle: string;
  sourceRef: string;
  reviewedAt: string;
  tally: EcosystemTallyV1;
  rows: EcosystemAppRowV1[];
}

export function ecosystemBlockV1(evidence: EcosystemEvidenceV1): RepresentationEcosystemV1 {
  const readings = ecosystemClaimReadingsV1(evidence);
  return {
    ...BASE_STOCKS_ECOSYSTEM_SOURCE_V1,
    tally: ecosystemTallyV1(readings),
    rows: readings.map((reading) => ({
      appId: reading.app.appId,
      appName: reading.app.appName,
      claim: reading.app.claim,
      category: reading.app.category,
      measured: reading.measured,
      evidence: reading.evidence,
      detail: reading.detail,
      reason: reading.reason,
    })),
  };
}
