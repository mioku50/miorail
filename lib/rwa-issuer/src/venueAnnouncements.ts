import type { ReviewedIssuerIdV1 } from './issuers.js';
import type { DefiUseKindV1, DefiVenueListingV1 } from './useAccess.js';

// ---------------------------------------------------------------------------
// What a named party ANNOUNCED about a venue, kept apart from what the venue
// answers.
//
// Base published, on 24 August 2026, that Coinbase tokenized stocks can be
// used as collateral on Aave. Read Aave's own reserve list on Base today and
// there are fifteen reserves, not one of them a B20 address. Both sentences
// are true, and the DeFi card said only the second one — "No reviewed
// integration found in the venues Miorail checked" — to a reader who had just
// read the first. That reader concludes our data is stale. It is not; the
// listing has not happened yet.
//
// So an announcement is stored as what it is: a dated claim by a named party,
// with the sentence it rests on, and NEVER as a use. It cannot make a use
// axis true, cannot colour a chip, cannot enter `establishedDefiUsesV1`. The
// only thing it does is stand beside the measurement and say who expected
// what, so the reader can tell "not yet" from "we did not look" from "we
// looked and it is there".
//
// The four readings below are that distinction, and the fourth one is the
// reason this file exists twice over: a venue nobody checked must never
// render as a venue that said no.
// ---------------------------------------------------------------------------

export interface ReviewedVenueAnnouncementV1 {
  announcementId: string;
  /** The same venue id the reader answers under, so the two can be joined. */
  venueId: string;
  /** The venue's name, pinned here so an UNCHECKED venue still has one. */
  venueName: string;
  /** Whose representations the claim covers. Never widened to an asset class. */
  issuerId: ReviewedIssuerIdV1;
  /** The uses the announcement names, in the announcement's own words. */
  uses: readonly DefiUseKindV1[];
  /** Who said it. Not the venue, and not us. */
  announcedBy: string;
  /** The publication's own date. */
  announcedAt: string;
  /** What was published. */
  sourceTitle: string;
  sourceRef: string;
  /** The sentence the claim rests on, verbatim. */
  quote: string;
}

/**
 * Base, 24 August 2026.
 *
 * Two sentences in that post name Aave by name; the second is the one a user
 * acts on, so it is the one quoted. Neither names a date, a market, or a
 * contract — which is exactly why it is filed as an announcement and not as
 * evidence about an address.
 *
 * Coinbase only. The post is about "tokenized stocks issued by Coinbase, built
 * on the B20 standard"; a Backed tracker certificate is not in it, and must
 * not inherit it.
 */
export const REVIEWED_VENUE_ANNOUNCEMENTS_V1: readonly ReviewedVenueAnnouncementV1[] = [
  {
    announcementId: 'base-2026-08-24-aave-collateral',
    venueId: 'aave_v3',
    venueName: 'Aave v3',
    issuerId: 'coinbase',
    uses: ['collateral'],
    announcedBy: 'Base',
    announcedAt: '2026-08-24',
    sourceTitle: 'Stocks just got updated.',
    // The post itself refuses every non-browser client, so this is the
    // publisher's blog rather than a deep link we could not verify. The title
    // and date above identify the document.
    sourceRef: 'https://blog.base.org',
    quote:
      'Use your tokenized NVIDIA stock as collateral for an onchain loan on Aave, supply Apple to a decentralized exchange to earn yield, or build automated trading strategies.',
  },
];

/**
 * What the venue said about this exact address, against what was announced.
 *
 * `unchecked` is not a weaker `not_listed`. It means the venue was never in
 * the source set — a caller with no chain reader gets the two HTTP venues and
 * no Aave at all — and rendering silence as a refusal would put our own
 * missing capability under the venue's name.
 */
export type VenueAnnouncementMeasuredV1 = 'listed' | 'not_listed' | 'unread' | 'unchecked';

export interface VenueAnnouncementReadingV1 {
  announcement: ReviewedVenueAnnouncementV1;
  measured: VenueAnnouncementMeasuredV1;
  /** Why the venue could not be read. Only ever set for `unread`. */
  reason: string | null;
  /**
   * Of the uses the announcement names, those the reading itself establishes,
   * and those it does not state. Both are empty unless the venue LISTED the
   * address: when it did not, the state already says everything, and when it
   * did, "a reserve exists" and "it may be posted as collateral" are two
   * different permissions and Aave's reserve list only answers the first.
   */
  establishedUses: DefiUseKindV1[];
  unstatedUses: DefiUseKindV1[];
}

/**
 * The announcements that cover this issuer, read against this address's venue
 * listings.
 *
 * A null issuer returns nothing: an announcement scoped to one issuer must not
 * be shown on a card whose issuer is unknown.
 */
export function venueAnnouncementReadingsV1(input: {
  issuerId: ReviewedIssuerIdV1 | null;
  venues: readonly DefiVenueListingV1[];
  announcements?: readonly ReviewedVenueAnnouncementV1[];
}): VenueAnnouncementReadingV1[] {
  const { issuerId } = input;
  if (issuerId === null) return [];
  const catalogue = input.announcements ?? REVIEWED_VENUE_ANNOUNCEMENTS_V1;
  return catalogue
    .filter((announcement) => announcement.issuerId === issuerId)
    .map((announcement) => {
      const listing = input.venues.find((venue) => venue.venueId === announcement.venueId);
      if (!listing) {
        return {
          announcement,
          measured: 'unchecked' as const,
          reason: null,
          establishedUses: [],
          unstatedUses: [],
        };
      }
      if (listing.state !== 'listed') {
        return {
          announcement,
          measured: listing.state,
          reason: listing.state === 'unread' ? listing.reason : null,
          establishedUses: [],
          unstatedUses: [],
        };
      }
      const establishedUses = announcement.uses.filter((use) => listing.uses[use] === true);
      const unstatedUses = announcement.uses.filter((use) => listing.uses[use] !== true);
      return {
        announcement,
        measured: 'listed' as const,
        reason: null,
        establishedUses,
        unstatedUses,
      };
    });
}
