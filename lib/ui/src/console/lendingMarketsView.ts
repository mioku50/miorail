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
//
// A SUMMARY MAY BE COARSER THAN ITS LIST. IT MAY NOT DISAGREE WITH IT.
//
// The headline is the same failure one level up. It used to compute
// availability over the CURATED subset while the table below it showed every
// market, so a dry curated market beside a funded uncurated one printed
// "nothing available to borrow right now" above a row reading $97. Both
// sentences were on one screen and they contradicted each other.
//
// Two rules follow, and `lendingMarketsHeadlineV1` exists so they live in one
// place instead of at every call site:
//
//   * every clause states the set it is quantified over — the whole list — and
//     is computed over that same set;
//   * a claim of absence requires a measurement of absence. "Nothing" is only
//     sayable when every market in the list was priced and every figure was
//     zero. An unread market makes the answer "we were not told", and a figure
//     under a dollar is money, so it is never rounded down into "nothing".
//
// Neither rule reaches claim (3). No amount of liquidity, in any market, is
// evidence that a particular reader could draw it — so nothing here is ever
// phrased in the second person, and the caveat refusing (3) is a constant of
// the view rather than something a flush market can switch off.
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
  /** The number that answers claim (2), as it is rendered. */
  available: string | null;
  /** The same number before rendering, so a summary of these rows is computed
   * from what was measured and never parsed back out of its own table cell. */
  availableUsd: number | null;
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

/** Claim (3), refused by name. A constant of the view: the alternative is a
 * reader taking a non-zero liquidity figure as permission. */
export const LENDING_PERSONAL_CAVEAT_V1 =
  'Whether YOU could borrow here depends on what you already hold and on the venue’s own checks at the moment you try. Miorail does not read your position and does not answer that.';

/** The venue's figure, normalised once. Everything else reads this, so the
 * rendered cell and the sentence above the table cannot disagree about what
 * the number was. */
function usdNumberV1(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function usdV1(value: number | null | undefined): string | null {
  const usd = usdNumberV1(value);
  if (usd === null) return null;
  // Under a dollar is still money, and rounding it to $0 would render a live
  // market as an empty one.
  if (usd > 0 && usd < 1) return '<$1';
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** Four states, because "we were not told" and "there is none" are different
 * answers and only one of them licenses the word "nothing". */
type AvailabilityV1 = 'unknown' | 'none' | 'dust' | 'funded';

function availabilityV1(usd: number | null): AvailabilityV1 {
  if (usd === null) return 'unknown';
  if (usd === 0) return 'none';
  return usd < 1 ? 'dust' : 'funded';
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
    return (usdNumberV1(b.liquidityUsd) ?? -1) - (usdNumberV1(a.liquidityUsd) ?? -1);
  });

  const rows = ranked.map((market): LendingMarketRowV1 => {
    const availableUsd = usdNumberV1(market.liquidityUsd);
    const available = usdV1(market.liquidityUsd);
    const pair =
      market.collateralAssetSymbol && market.loanAssetSymbol
        ? `${market.collateralAssetSymbol} / ${market.loanAssetSymbol}`
        : shortIdV1(market.marketId);

    // The states a reader actually distinguishes between, in order of how much
    // use the market is to them. Each one is a sentence the row's own cells
    // cannot contradict — in particular a `<$1` cell never sits beside the word
    // "nothing".
    let note: string;
    let tone: LendingMarketRowV1['tone'];
    if (market.curated !== true) {
      // Not a warning about the market — a statement about who made it. Anyone
      // can deploy one, so its existence is not the venue's endorsement.
      note = 'Deployed by anyone — not on the venue’s own list.';
      tone = 'neutral';
    } else {
      switch (availabilityV1(availableUsd)) {
        case 'unknown':
          note = 'The venue did not say how much is available to borrow.';
          tone = 'neutral';
          break;
        case 'none':
          note = 'On the venue’s list, and nothing is available to borrow right now.';
          tone = 'off';
          break;
        case 'dust':
          // Not "nothing": the cell says `<$1` and the two must agree.
          note = 'On the venue’s list, with under $1 available to borrow right now.';
          tone = 'off';
          break;
        default:
          note = `On the venue’s list. ${available} available to borrow right now.`;
          tone = 'neutral';
      }
    }

    return {
      label: pair,
      marketId: market.marketId,
      curated: typeof market.curated === 'boolean' ? market.curated : null,
      lltv: lltvV1(market.lltvBps),
      collateral: usdV1(market.collateralUsd),
      borrowed: usdV1(market.borrowUsd),
      available,
      availableUsd,
      note,
      tone,
    };
  });

  return {
    title: `${input.venueName} markets for this exact address`,
    rows,
    caveats: [
      LENDING_PERSONAL_CAVEAT_V1,
      'Liquidity and rates move continuously. These were read when this page was assembled, not now.',
    ],
  };
}

function countV1(n: number): string {
  return `${n} market${n === 1 ? '' : 's'}`;
}

/** The one-line answer, for a surface with no room for a table.
 *
 * Kept beside the table rather than written at a call site, because "listed"
 * is the word that hides the difference and every caller reaches for it — and
 * because a summary written at a call site is a summary nobody checked against
 * the rows it summarises. */
export function lendingMarketsHeadlineV1(view: LendingMarketsViewV1 | null): string | null {
  if (view === null) return null;
  const rows = view.rows;
  const curated = rows.filter((row) => row.curated === true);

  // Clause one: how many exist, and how many the venue put its name to. Counted
  // over the whole list, which is the set the table shows.
  const existence =
    curated.length === 0
      ? `${countV1(rows.length)} here, none on the venue’s own list`
      : curated.length === rows.length
        ? rows.length === 1
          ? '1 market here, on the venue’s list'
          : `${countV1(rows.length)} here, all on the venue’s list`
        : `${countV1(rows.length)} here, ${curated.length} on the venue’s list`;

  // Clause two: availability, over that SAME whole list. Taking the deepest
  // market makes the sentence a maximum over the rows, so no row can hold a
  // figure that contradicts it.
  const priced = rows.filter((row) => row.availableUsd !== null);
  const unpriced = rows.length - priced.length;
  const deepest = [...priced].sort((a, b) => b.availableUsd! - a.availableUsd!)[0];
  const them = rows.length === 1 ? 'it' : 'any of them';

  let availability: string;
  switch (deepest === undefined ? 'unknown' : availabilityV1(deepest.availableUsd)) {
    case 'funded':
      availability =
        deepest!.curated === true
          ? `The most available to borrow right now is ${deepest!.available}, in a market on the venue’s list.`
          : `The most available to borrow right now is ${deepest!.available}, and it is in a market the venue did not list.`;
      break;
    case 'dust':
      availability = `Under $1 available to borrow in ${them} right now.`;
      if (unpriced > 0) availability += ` The venue gave no figure for ${unpriced} of them.`;
      break;
    case 'none':
      availability =
        unpriced === 0
          ? `Nothing available to borrow in ${them} right now.`
          : `Nothing available to borrow in the ${countV1(priced.length)} the venue gave figures for, and it gave none for the other ${unpriced}.`;
      break;
    default:
      // Not one market was priced. Absence of a figure is not a figure of zero.
      availability = `The venue did not say how much is available to borrow in ${them}.`;
  }

  return `${existence}. ${availability}`;
}
