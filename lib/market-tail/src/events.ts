import type { AssetTransferV1 } from './ledger.js';
import type { VenueV1 } from './venues.js';

// ---------------------------------------------------------------------------
// Transfers with a venue on exactly one side.
//
// Named for what the log supports, which is NOT "a trade". A pool receives and
// pays the token when somebody swaps, and it also does so when somebody adds
// or removes liquidity. Measured over the shadow run's own range on
// 2026-08-25: of 34 transactions where a tracked asset moved through the
// Uniswap v4 singleton, 32 also carried a v4 `Swap` and 2 did not.
//
// Six per cent is small and it is not nothing: "first observed trade" firing
// because somebody seeded a pool would be a false claim about the asset, which
// is the exact failure this project keeps having. Confirming a transfer as a
// swap means reading the venue's own event, and that is a later and dearer
// read. Until then the store says what it saw.
// ---------------------------------------------------------------------------

export const VENUE_TRANSFER_DIRECTIONS_V1 = ['out_of_venue', 'into_venue'] as const;
export type VenueTransferDirectionV1 = (typeof VENUE_TRANSFER_DIRECTIONS_V1)[number];

export interface MarketVenueTransferV1 {
  tokenAddress: string;
  venueAddress: string;
  direction: VenueTransferDirectionV1;
  /**
   * The address on the other side.
   *
   * Whatever the pool paid or was paid by: a router as often as a person. It
   * is never a trader, and the column name is the whole guard -- there is no
   * field here that a surface could render as "who bought".
   */
  counterparty: string;
  amountAtomic: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

/**
 * The reading of a direction as a side.
 *
 * Tokens leaving a venue are tokens somebody acquired; tokens entering one are
 * tokens somebody disposed of. That much the log supports. It does NOT support
 * naming who did it, it does not become a price, and it does not distinguish a
 * swap from a liquidity change -- see the header.
 *
 * Kept as a function rather than a stored column so the claim travels with its
 * caveat instead of sitting in a database as a bare word.
 */
export function venueTransferSideV1(direction: VenueTransferDirectionV1): 'acquired' | 'disposed' {
  return direction === 'out_of_venue' ? 'acquired' : 'disposed';
}

/**
 * Transfers into venue transfers.
 *
 * Three things are dropped, each for a reason that is not a heuristic:
 *
 *   * either side is the zero address -- issuance and redemption are not
 *     trades, and a mint into a pool is seeding rather than buying;
 *   * neither side is a venue -- a wallet paying a wallet is not a trade;
 *   * BOTH sides are venues -- pool-to-pool routing inside one swap, which is
 *     one trade seen twice, and counting it would double every multi-hop;
 *   * the venue is only a candidate -- we have not asked it what it is, and
 *     "probably a pool" is not evidence.
 */
export function venueTransfersFromLedgerV1(input: {
  transfers: readonly AssetTransferV1[];
  venues: readonly VenueV1[];
}): MarketVenueTransferV1[] {
  const identified = new Map<string, VenueV1>();
  for (const venue of input.venues) {
    if (venue.kind === 'paired_pool' || venue.kind === 'singleton') {
      identified.set(venue.address.toLowerCase(), venue);
    }
  }

  const ZERO = '0x0000000000000000000000000000000000000000';
  const events: MarketVenueTransferV1[] = [];
  for (const transfer of input.transfers) {
    if (transfer.from === ZERO || transfer.to === ZERO) continue;
    const fromVenue = identified.has(transfer.from);
    const toVenue = identified.has(transfer.to);
    if (fromVenue === toVenue) continue;
    events.push({
      tokenAddress: transfer.tokenAddress,
      venueAddress: fromVenue ? transfer.from : transfer.to,
      direction: fromVenue ? 'out_of_venue' : 'into_venue',
      counterparty: fromVenue ? transfer.to : transfer.from,
      amountAtomic: transfer.amountAtomic,
      blockNumber: transfer.blockNumber,
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
    });
  }
  return events;
}
