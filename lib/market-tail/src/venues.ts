import {
  TOKEN0_SELECTOR_V1,
  TOKEN1_SELECTOR_V1,
  UNISWAP_V4_SINGLETON_V1,
  VENUE_CANDIDATE_MIN_PER_SIDE_V1,
} from './constants.js';
import type { AssetTransferV1 } from './ledger.js';

// ---------------------------------------------------------------------------
// Which counterparties are venues.
//
// Discovered from behaviour, then confirmed by asking the address itself. A
// pinned factory address is a guess that ages; a contract that both pays and
// receives the same token is a pool now, whoever deployed it and whichever
// protocol it belongs to. Nothing in this file knows the name of a venue.
// ---------------------------------------------------------------------------

export const VENUE_KINDS_V1 = ['candidate', 'paired_pool', 'singleton', 'not_a_venue'] as const;
export type VenueKindV1 = (typeof VENUE_KINDS_V1)[number];

export interface VenueV1 {
  address: string;
  kind: VenueKindV1;
  token0: string | null;
  token1: string | null;
}

const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';

/**
 * Addresses worth spending two calls on.
 *
 * Both sides, because a pool pays AND receives; a threshold, because
 * identifying every counterparty costs more than the answer is worth.
 *
 * Issuance is skipped whole, not just on the zero side. A holder who was
 * minted tokens and later redeemed them has appeared on both sides without
 * ever touching a market, and counting either leg would put a wallet in the
 * queue for two calls it will fail.
 */
export function venueCandidatesFromTransfersV1(input: {
  transfers: readonly AssetTransferV1[];
  minPerSide?: number;
  /** Addresses already identified, of any kind. Not re-proposed. */
  known?: readonly string[];
}): string[] {
  const minimum = input.minPerSide ?? VENUE_CANDIDATE_MIN_PER_SIDE_V1;
  const known = new Set((input.known ?? []).map((address) => address.toLowerCase()));
  const paid = new Map<string, number>();
  const received = new Map<string, number>();

  for (const transfer of input.transfers) {
    if (transfer.from === ZERO_ADDRESS_V1 || transfer.to === ZERO_ADDRESS_V1) continue;
    paid.set(transfer.from, (paid.get(transfer.from) ?? 0) + 1);
    received.set(transfer.to, (received.get(transfer.to) ?? 0) + 1);
  }

  const candidates: string[] = [];
  for (const [address, out] of paid) {
    if (known.has(address)) continue;
    if (out < minimum) continue;
    if ((received.get(address) ?? 0) < minimum) continue;
    candidates.push(address);
  }
  return candidates.sort();
}

/**
 * What an address answered when asked what pair it holds.
 *
 * `null` for a reader means the call did not complete, which is OUR failure
 * and leaves the address a candidate. An address that answers nothing readable
 * is `not_a_venue` -- a stored answer, not an absence, and the only thing that
 * stops the same router being probed every hour forever.
 */
export function venueFromPairReadsV1(input: {
  address: string;
  token0: string | null;
  token1: string | null;
}): VenueV1 {
  const address = input.address.toLowerCase();
  if (address === UNISWAP_V4_SINGLETON_V1) {
    // Every v4 pool lives in this one contract, so it has no pair to answer
    // with. Recorded as what it is rather than probed for what it lacks.
    return { address, kind: 'singleton', token0: null, token1: null };
  }
  const token0 = (input.token0 ?? '').toLowerCase();
  const token1 = (input.token1 ?? '').toLowerCase();
  const readable = /^0x[0-9a-f]{40}$/.test(token0) && /^0x[0-9a-f]{40}$/.test(token1);
  if (!readable || token0 === ZERO_ADDRESS_V1 || token1 === ZERO_ADDRESS_V1) {
    return { address, kind: 'not_a_venue', token0: null, token1: null };
  }
  return { address, kind: 'paired_pool', token0, token1 };
}

/** Decodes an `eth_call` return word into an address, or null when the call
 * did not answer with one. */
export function addressFromCallResultV1(result: string | null | undefined): string | null {
  const value = (result ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) return null;
  const address = `0x${value.slice(26)}`;
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

export { TOKEN0_SELECTOR_V1, TOKEN1_SELECTOR_V1 };
