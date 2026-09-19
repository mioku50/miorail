// ---------------------------------------------------------------------------
// The inputs the arithmetic needs, measured — and named when they are missing.
//
// `morphoBorrowMath` takes measured numbers and nothing else. This is what
// turns a venue's answer into those numbers, and its whole job is the part
// that is easy to get wrong: what to do when one of them is absent.
//
// THERE IS NO DEFAULT FOR AN UNREAD INPUT
//
// Measured 2026-09-19, one of NVDAc's four Morpho markets published
// `state.price: null` — the oracle did not answer. Substituting zero there
// computes a maximum borrow of zero and renders "you can borrow nothing",
// which is a MEASURED-sounding refusal built on no measurement at all. It is
// the same failure as [[a-gate-that-fails-open-must-say-so]] pointing the other
// way: a gate that fails CLOSED must say so too.
//
// So every absent input produces a typed refusal that names the missing thing,
// and no number downstream of it is computed.
//
// A POSITION IS NOT A ZERO
//
// `position: null` means nobody read this wallet in this market. A wallet with
// no position reads as an explicit zero position, and the two are different
// answers: the first cannot support any claim about what this reader could
// borrow, the second supports the full one.
//
// WALLET-BOUND, AND ONLY HERE
//
// A borrow capacity is a fact about one wallet. It belongs on the wallet-bound
// surface, is never narrated, and never reaches a public feed
// ([[b20-portfolio-scope-is-private]]).
// ---------------------------------------------------------------------------

import {
  morphoBorrowCapacityV1,
  morphoHealthV1,
  morphoLiquidationIncentiveWadV1,
  morphoLiquidationPriceV1,
  type MorphoBorrowCapacityV1,
  type MorphoHealthV1,
  type MorphoMarketStateV1,
  type MorphoPositionV1,
} from './morphoBorrowMath.js';

export const MORPHO_BORROW_GRAPHQL_URL_V1 = 'https://api.morpho.org/graphql';

/** Why no number was produced. Each one names a different missing thing. */
export const MORPHO_BORROW_REFUSALS_V1 = [
  /** The venue answered, and holds no market for this exact address. */
  'no_market_for_this_address',
  /** The market exists and its oracle returned nothing, so the collateral has no price. */
  'oracle_did_not_answer',
  /** The venue could not be reached, or answered something this build cannot read. */
  'venue_unread',
  /** No wallet was given. This surface never guesses one. */
  'no_wallet_given',
  /** A wallet was given and the venue did not answer for it. */
  'position_unread',
] as const;
export type MorphoBorrowRefusalV1 = (typeof MORPHO_BORROW_REFUSALS_V1)[number];

export interface MorphoBorrowMarketV1 {
  marketId: string;
  /** The venue's own curation of THIS market, never of the asset. */
  curated: boolean | null;
  /** Integer basis points: 6250 is 62.5%. */
  lltvBps: number;
  /** The exact contract, so an arrival can be measured against the right token
   * rather than against a symbol two contracts may share. */
  collateral: { address: string | null; symbol: string | null; decimals: number | null };
  loan: { address: string | null; symbol: string | null; decimals: number | null };
  /** The borrow rate the venue published, WAD-scaled, or null when it did not. */
  borrowApyWad: bigint | null;
  state: MorphoMarketStateV1;
}

export interface MorphoBorrowStandingV1 {
  market: MorphoBorrowMarketV1;
  /** Null means NOBODY READ this wallet here — never "the wallet has nothing". */
  position: MorphoPositionV1 | null;
  health: MorphoHealthV1 | null;
  capacity: MorphoBorrowCapacityV1 | null;
  /** The collateral price at which the position stops being healthy. */
  liquidationPrice: bigint | null;
  /** What a liquidator takes on top of the debt they repay, WAD-scaled. */
  liquidationIncentiveWad: bigint;
  /**
   * The venue's own published debt, when it gave one.
   *
   * Kept beside ours rather than instead of it. Measured on all six live
   * borrowers: the venue publishes `toAssetsDown` while the contract checks
   * `toAssetsUp`, so the two differ by one atomic unit, always in the
   * protocol's favour. A second opinion that disagrees by a known amount in a
   * known direction is worth carrying; silently preferring either one is not.
   */
  venuePublishedDebtAssets: bigint | null;
}

export type MorphoBorrowReadingV1 =
  | { state: 'read'; readAt: string; markets: readonly MorphoBorrowStandingV1[] }
  | { state: 'refused'; readAt: string; refusal: MorphoBorrowRefusalV1; detail: string | null };

/** Both roles are irrelevant here: a borrow needs the market where this token
 * is the COLLATERAL. Asking for the loan side too would return markets whose
 * capacity question is a different one. */
export const MORPHO_BORROW_MARKETS_QUERY_V1 = `query MiorailBorrowMarkets($chainId: [Int!], $address: [String!]) {
  markets(first: 20, where: { chainId_in: $chainId, collateralAssetAddress_in: $address }) {
    items {
      marketId lltv listed
      collateralAsset { address symbol decimals }
      loanAsset { address symbol decimals }
      state {
        blockNumber price supplyAssets borrowAssets borrowShares borrowApy
      }
    }
  }
}`;

export const MORPHO_BORROW_POSITIONS_QUERY_V1 = `query MiorailBorrowPositions($chainId: [Int!], $markets: [String!], $user: [String!]) {
  marketPositions(first: 20, where: { chainId_in: $chainId, marketUniqueKey_in: $markets, userAddress_in: $user }) {
    items {
      market { marketId }
      state { collateral borrowShares borrowAssets }
    }
  }
}`;

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** WAD from a JSON number, without ever letting a float reach the arithmetic. */
function apyWadV1(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return BigInt(Math.round(value * 1e18));
}

/** An exact address or nothing. A half-read address is worse than none: it
 * would be compared against a simulated transfer and quietly never match. */
function addressOrNullV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return ADDRESS_V1.test(address) ? address : null;
}

function bigOrNullV1(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 53) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function lltvBpsV1(raw: unknown): number | null {
  const wad = bigOrNullV1(raw);
  if (wad === null || wad <= 0n) return null;
  const bps = Number((wad * 10_000n) / 10n ** 18n);
  return Number.isInteger(bps) && bps > 0 && bps <= 10_000 ? bps : null;
}

export interface MorphoBorrowReaderDepsV1 {
  fetchImpl?: typeof fetch;
  url?: string;
  chainId?: number;
  now?: () => Date;
}

async function graphqlV1(
  deps: MorphoBorrowReaderDepsV1,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await (deps.fetchImpl ?? fetch)(deps.url ?? MORPHO_BORROW_GRAPHQL_URL_V1, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`morpho_http_${response.status}`);
  const body = (await response.json()) as { data?: unknown; errors?: unknown };
  if (body.errors) throw new Error('morpho_graphql_errors');
  return body.data;
}

/**
 * Every market this address is collateral in, with this wallet's position.
 *
 * `walletAddress` is optional, and its absence is a refusal rather than a
 * silent read of the market alone: a caller asking what can be borrowed is
 * asking about somebody, and answering as if about nobody is the exact
 * conflation this product exists to avoid.
 */
export async function readMorphoBorrowStandingV1(input: {
  tokenAddress: string;
  walletAddress: string | null;
  deps?: MorphoBorrowReaderDepsV1;
}): Promise<MorphoBorrowReadingV1> {
  const deps = input.deps ?? {};
  const readAt = (deps.now?.() ?? new Date()).toISOString();
  const chainId = deps.chainId ?? 8453;
  const token = input.tokenAddress.trim().toLowerCase();
  if (!ADDRESS_V1.test(token)) {
    return { state: 'refused', readAt, refusal: 'venue_unread', detail: 'not an exact Base address' };
  }
  const wallet = input.walletAddress?.trim().toLowerCase() ?? null;
  if (wallet === null) {
    return { state: 'refused', readAt, refusal: 'no_wallet_given', detail: null };
  }
  if (!ADDRESS_V1.test(wallet)) {
    return { state: 'refused', readAt, refusal: 'no_wallet_given', detail: 'not an exact address' };
  }

  let marketsData: unknown;
  try {
    marketsData = await graphqlV1(deps, MORPHO_BORROW_MARKETS_QUERY_V1, {
      chainId: [chainId],
      address: [token],
    });
  } catch (error) {
    return {
      state: 'refused',
      readAt,
      refusal: 'venue_unread',
      detail: error instanceof Error ? error.message.slice(0, 120) : null,
    };
  }

  const rawMarkets = (marketsData as { markets?: { items?: unknown[] } } | null)?.markets?.items ?? [];
  if (rawMarkets.length === 0) {
    return { state: 'refused', readAt, refusal: 'no_market_for_this_address', detail: null };
  }

  const parsed: MorphoBorrowMarketV1[] = [];
  let sawOracleGap = false;
  for (const entry of rawMarkets) {
    const row = entry as Record<string, any>;
    const marketId = typeof row.marketId === 'string' ? row.marketId : null;
    const lltvBps = lltvBpsV1(row.lltv);
    const price = bigOrNullV1(row.state?.price);
    const supply = bigOrNullV1(row.state?.supplyAssets);
    const borrowAssets = bigOrNullV1(row.state?.borrowAssets);
    const borrowShares = bigOrNullV1(row.state?.borrowShares);
    if (marketId === null || lltvBps === null || supply === null || borrowAssets === null || borrowShares === null) {
      continue;
    }
    if (price === null) {
      // The market is real and its collateral has no price. Dropping it
      // silently would report fewer markets than exist; pricing it at zero
      // would report a measured inability to borrow. Neither is true.
      sawOracleGap = true;
      continue;
    }
    parsed.push({
      marketId,
      curated: typeof row.listed === 'boolean' ? row.listed : null,
      lltvBps,
      collateral: {
        address: addressOrNullV1(row.collateralAsset?.address),
        symbol: typeof row.collateralAsset?.symbol === 'string' ? row.collateralAsset.symbol : null,
        decimals: Number.isInteger(row.collateralAsset?.decimals) ? row.collateralAsset.decimals : null,
      },
      loan: {
        address: addressOrNullV1(row.loanAsset?.address),
        symbol: typeof row.loanAsset?.symbol === 'string' ? row.loanAsset.symbol : null,
        decimals: Number.isInteger(row.loanAsset?.decimals) ? row.loanAsset.decimals : null,
      },
      borrowApyWad: apyWadV1(row.state?.borrowApy),
      state: {
        collateralPrice: price,
        lltvWad: (BigInt(lltvBps) * 10n ** 18n) / 10_000n,
        totalSupplyAssets: supply,
        totalBorrowAssets: borrowAssets,
        totalBorrowShares: borrowShares,
        blockNumber: Number.isInteger(row.state?.blockNumber) ? row.state.blockNumber : null,
      },
    });
  }

  if (parsed.length === 0) {
    return {
      state: 'refused',
      readAt,
      refusal: sawOracleGap ? 'oracle_did_not_answer' : 'venue_unread',
      detail: sawOracleGap ? 'every market for this address published no collateral price' : null,
    };
  }

  // One request for every position, so the positions and the market state a
  // caller compares them against were not read minutes apart.
  let positionsById = new Map<string, { collateral: bigint; borrowShares: bigint; published: bigint | null }>();
  let positionsRead = true;
  try {
    const positionsData = await graphqlV1(deps, MORPHO_BORROW_POSITIONS_QUERY_V1, {
      chainId: [chainId],
      markets: parsed.map((market) => market.marketId),
      user: [wallet],
    });
    const rows = (positionsData as { marketPositions?: { items?: unknown[] } } | null)?.marketPositions?.items ?? [];
    positionsById = new Map(
      rows.flatMap((entry) => {
        const row = entry as Record<string, any>;
        const id = typeof row.market?.marketId === 'string' ? row.market.marketId : null;
        const collateral = bigOrNullV1(row.state?.collateral);
        const borrowShares = bigOrNullV1(row.state?.borrowShares);
        if (id === null || collateral === null || borrowShares === null) return [];
        return [[id, { collateral, borrowShares, published: bigOrNullV1(row.state?.borrowAssets) }]] as const;
      }),
    );
  } catch {
    positionsRead = false;
  }

  const markets = parsed.map((market): MorphoBorrowStandingV1 => {
    const liquidationIncentiveWad = morphoLiquidationIncentiveWadV1(market.state.lltvWad);
    if (!positionsRead) {
      return {
        market,
        position: null,
        health: null,
        capacity: null,
        liquidationPrice: null,
        liquidationIncentiveWad,
        venuePublishedDebtAssets: null,
      };
    }
    // The venue answered about this wallet. A market it did not name is a
    // measured empty position, which is a different thing from an unread one.
    const found = positionsById.get(market.marketId);
    const position: MorphoPositionV1 = found
      ? { collateral: found.collateral, borrowShares: found.borrowShares }
      : { collateral: 0n, borrowShares: 0n };
    return {
      market,
      position,
      health: morphoHealthV1({ market: market.state, position }),
      capacity: morphoBorrowCapacityV1({ market: market.state, position }),
      liquidationPrice: morphoLiquidationPriceV1({ market: market.state, position }),
      liquidationIncentiveWad,
      venuePublishedDebtAssets: found?.published ?? null,
    };
  });

  // Curated first, then by what this wallet could actually borrow — the order
  // a reader wants, and the same rule the lending table already uses.
  const ranked = [...markets].sort((a, b) => {
    if ((a.market.curated === true) !== (b.market.curated === true)) {
      return a.market.curated === true ? -1 : 1;
    }
    const left = a.capacity?.assets ?? -1n;
    const right = b.capacity?.assets ?? -1n;
    return left === right ? 0 : right > left ? 1 : -1;
  });

  return { state: 'read', readAt, markets: ranked };
}
