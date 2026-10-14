import type { ReviewedIssuerIdV1 } from './issuers.js';
import type { DefiUseKindV1, DefiVenueListingV1 } from './useAccess.js';

// Announcements are dated source claims, never measured permissions. The
// August Base post did not name a protocol version; binding it to V3 created a
// false "not there yet" after the Equities Hub launched. The current reviewed
// announcement explicitly names V4 and its seven Coinbase assets.

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
  /**
   * The exact contracts the announcement could have been about, when it names
   * an issuer rather than addresses: what that issuer had on Base when it was
   * published. A token the issuer launched later was not announced as
   * anything, so it gets no reading at all.
   */
  coversTokenAddresses?: readonly string[];
}

export const REVIEWED_VENUE_ANNOUNCEMENTS_V1: readonly ReviewedVenueAnnouncementV1[] = [
  {
    announcementId: 'aave-2026-09-25-v4-equities',
    venueId: 'aave_v4_equities',
    venueName: 'Aave v4 Equities',
    issuerId: 'coinbase',
    uses: ['collateral'],
    announcedBy: 'Aave Labs',
    announcedAt: '2026-09-25',
    sourceTitle: 'Coinbase Tokenized Stocks Now Live on Aave V4',
    sourceRef: 'https://aave.com/blog/coinbase-tokenized-stocks',
    quote: 'The equities are collateral-only at launch',
    coversTokenAddresses: [
      '0xb200000000000000000000c2e324d24d7eecd1fb', // AAPLc
      '0xb200000000000000000000d9192b6b456483c2e8', // AMZNc
      '0xb2000000000000000000002d0ba3164cc74f58b7', // GOOGLc
      '0xb2000000000000000000008bc8786b856e61707c', // METAc
      '0xb200000000000000000000ab99cfa739e253872b', // MSFTc
      '0xb20000000000000000000078ee7ce2fe4908108c', // NVDAc
      '0xb2000000000000000000001e800a7f5189430cd0', // TSLAc
    ],
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
  /** The token the card is about. An announcement scoped to exact contracts
   * says nothing about an unknown one. */
  tokenAddress: string | null;
  venues: readonly DefiVenueListingV1[];
  announcements?: readonly ReviewedVenueAnnouncementV1[];
}): VenueAnnouncementReadingV1[] {
  const { issuerId } = input;
  if (issuerId === null) return [];
  const token = input.tokenAddress?.toLowerCase() ?? null;
  const catalogue = input.announcements ?? REVIEWED_VENUE_ANNOUNCEMENTS_V1;
  return catalogue
    .filter((announcement) => announcement.issuerId === issuerId)
    .filter(
      (announcement) =>
        announcement.coversTokenAddresses === undefined ||
        (token !== null && announcement.coversTokenAddresses.includes(token)),
    )
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
