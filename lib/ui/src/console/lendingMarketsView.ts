// ---------------------------------------------------------------------------
// One lending market at a time, because "listed" is three different claims.
//
// A venue-level answer collapses questions that have different answers in the
// same reply:
//
//   1. A market EXISTS for this exact address.
//   2. There is money in it to borrow RIGHT NOW.
//   3. YOU could borrow from it.
//
// Measured on Base, 2026-09-19: NVDAc sits in four Morpho markets. Three are
// empty and uncurated. The fourth is Morpho-curated at 62.5% LLTV and holds
// $15,425 of collateral — against $835 of borrowable liquidity. Every one of
// those four rows satisfies (1). One satisfies (2), barely. None of them
// answers (3), and this module never pretends to: whether a particular wallet
// can borrow depends on the position it already holds, which Miorail does not
// have. The screen says that rather than leaving a reader to assume it.
//
// WHY PERMISSIONLESS MAKES THIS WORSE THAN AT AAVE
//
// On Morpho anyone can deploy a market against any token. So the mere presence
// of a row proves somebody deployed a contract, not that a venue accepted the
// asset — [[defi-listing-vs-permissionless-market]]. Curation is per MARKET,
// not per asset, and this renders it per market for that reason.
//
// The bug that made this section necessary: the venue reading carried ONE
// `marketRef`, taken as the first market the API returned. On NVDAc that put
// `curated: true` beside the id of an empty uncurated market — the flag
// describing one market and the pointer another.
// ---------------------------------------------------------------------------

export interface LendingMarketWireV1 {
  marketId?: string | null;
  curated?: boolean | null;
  role?: string | null;
  loanAssetSymbol?: string | null;
  collateralAssetSymbol?: string | null;
  lltvBps?: number | null;
  collateralUsd?: number | null;
  supplyUsd?: number | null;
  borrowUsd?: number | null;
  liquidityUsd?: number | null;
}

export interface LendingMarketRowV1 {
  /** Short, for a table cell. The full id travels in `marketId`. */
  label: string;
  marketId: string;
  /** The venue's own curation of THIS market. */
  curated: boolean | null;
  /** "62.5%", or null when the venue did not publish terms. */
  lltv: string | null;
  /** What is in it. Null renders as "—", never as zero. */
  collateral: string | null;
  borrowed: string | null;
  /** The number that answers claim (2). */
  available: string | null;
  /** One sentence a reader can act on, or the honest absence of one. */
  note: string;
  tone: 'neutral' | 'warn' | 'off';
}

export interface LendingMarketsViewV1 {
  title: string;
  /** Curated first, then deepest. The order a reader would want them in. */
  rows: readonly LendingMarketRowV1[];
  /** What this section does NOT answer, said out loud. */
  caveats: readonly string[];
}

function usdV1(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // Under a dollar is still money, and rounding it to $0 would render a live
  // market as an empty one.
  if (value > 0 && value < 1) return '<$1';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function lltvV1(bps: number | null | undefined): string | null {
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0) return null;
  // 6250 is 62.5%, and 62.5 rounded to 62 is the kind of small wrong number a
  // reader acts on.
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function shortIdV1(marketId: string): string {
  return marketId.length > 14 ? `${marketId.slice(0, 10)}…${marketId.slice(-4)}` : marketId;
}

export function lendingMarketsViewV1(input: {
  venueName: string;
  markets: readonly LendingMarketWireV1[] | null | undefined;
}): LendingMarketsViewV1 | null {
  const markets = (input.markets ?? []).filter(
    (market): market is LendingMarketWireV1 & { marketId: string } =>
      typeof market.marketId === 'string' && market.marketId.length > 0,
  );
  if (markets.length === 0) return null;

  const ranked = [...markets].sort((a, b) => {
    if ((a.curated === true) !== (b.curated === true)) return a.curated === true ? -1 : 1;
    return (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
  });

  const rows = ranked.map((market): LendingMarketRowV1 => {
    const available = usdV1(market.liquidityUsd);
    const collateral = usdV1(market.collateralUsd);
    const pair =
      market.collateralAssetSymbol && market.loanAssetSymbol
        ? `${market.collateralAssetSymbol} / ${market.loanAssetSymbol}`
        : shortIdV1(market.marketId);

    // The three states a reader actually distinguishes between, in order of how
    // much use the market is to them.
    let note: string;
    let tone: LendingMarketRowV1['tone'];
    if (market.curated !== true) {
      // Not a warning about the market — a statement about who made it. Anyone
      // can deploy one, so its existence is not the venue's endorsement.
      note = 'Deployed by anyone — not on the venue’s own list.';
      tone = 'neutral';
    } else if (market.liquidityUsd === null || market.liquidityUsd === undefined) {
      note = 'The venue did not say how much is available to borrow.';
      tone = 'neutral';
    } else if (market.liquidityUsd < 1) {
      note = 'On the venue’s list, and nothing is available to borrow right now.';
      tone = 'off';
    } else {
      note = `On the venue’s list. ${available} available to borrow right now.`;
      tone = 'neutral';
    }

    return {
      label: pair,
      marketId: market.marketId,
      curated: typeof market.curated === 'boolean' ? market.curated : null,
      lltv: lltvV1(market.lltvBps),
      collateral,
      borrowed: usdV1(market.borrowUsd),
      available,
      note,
      tone,
    };
  });

  return {
    title: `${input.venueName} markets for this exact address`,
    rows,
    caveats: [
      // Claim (3), refused by name. The alternative is a reader taking a
      // non-zero liquidity figure as permission.
      'Whether YOU could borrow here depends on what you already hold and on the venue’s own checks at the moment you try. Miorail does not read your position and does not answer that.',
      'Liquidity and rates move continuously. These were read when this page was assembled, not now.',
    ],
  };
}

/** The one-line answer, for a surface with no room for a table.
 *
 * Kept beside the table rather than written at a call site, because "listed"
 * is the word that hides the difference and every caller reaches for it. */
export function lendingMarketsHeadlineV1(view: LendingMarketsViewV1 | null): string | null {
  if (view === null) return null;
  const curated = view.rows.filter((row) => row.curated === true);
  const usable = curated.filter(
    (row) => row.available !== null && row.available !== '<$1' && row.available !== '$0',
  );
  if (curated.length === 0) {
    return `${view.rows.length} market${view.rows.length === 1 ? '' : 's'} exist here, none on the venue’s own list.`;
  }
  if (usable.length === 0) {
    return `${curated.length} market${curated.length === 1 ? '' : 's'} on the venue’s list, with nothing available to borrow right now.`;
  }
  return `${curated.length} market${curated.length === 1 ? '' : 's'} on the venue’s list, ${usable[0]!.available} available to borrow.`;
}
