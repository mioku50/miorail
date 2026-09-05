import { z } from 'zod';

import { REVIEWED_ISSUERS_V1, type ReviewedIssuerIdV1 } from './issuers.js';
import {
  establishedDefiUsesV1,
  type DefiUseKindV1,
  type RepresentationUseAccessV1,
} from './useAccess.js';
import {
  venueAnnouncementReadingsV1,
  type ReviewedVenueAnnouncementV1,
} from './venueAnnouncements.js';

// ---------------------------------------------------------------------------
// Use & access, for an assistant rather than for a screen.
//
// This exists because of a measured failure mode, not a feature request. The
// Miorail MCP surface returned no DeFi at all — neither the public server nor
// the connected one carried a single venue field — so an assistant asked "can
// I use NVDAc as collateral on Aave?" had nothing to read and answered from
// the thing it could reach: Base's own announcement of 24 August 2026. The
// announcement is real. The listing has not happened. Silence is what let the
// announcement become the answer.
//
// So the shape here is deliberate in three ways.
//
//  1. It carries the announcement AND the reading, joined and separate. An
//     assistant that sees only the reading contradicts a blog post its user
//     just read; one that sees only the announcement states a permission that
//     does not exist. Both are on the page, and which is which is typed.
//  2. `blockTag` names the fields it governs, in the payload. The envelope
//     used to document it as covering every onchain field, and a careful
//     reader took it at its word and filed the discrepancy as a defect. A
//     machine reader has no comment to fall back on, so the coverage is data.
//  3. Nothing here is wallet-bound. `walletBound: false` is a literal, not a
//     computed flag: this tool is public, and a public read cannot say whether
//     any particular address may transfer.
// ---------------------------------------------------------------------------

export const USE_ACCESS_AGENT_SCHEMA_VERSION_V1 = 'miorail-agent-use-access/v1';

/**
 * What this tool does NOT answer.
 *
 * A constant, and deliberately not derived from the payload. An absence list
 * computed from what happened to be missing shrinks on a good day, which is
 * exactly when a reader is most likely to over-read the result. These stay
 * true on every call.
 */
export const USE_ACCESS_NOT_STATED_V1: readonly string[] = [
  'Whether a listed asset can be borrowed, supplied or posted as collateral RIGHT NOW: caps, pause flags, available liquidity and risk parameters are not read here.',
  'Whether any particular wallet may transfer or use this token. This is a public read and holds no wallet.',
  'Eligibility of any kind — KYC, jurisdiction, or legal permission to hold or trade a security.',
  'Any venue outside the ones named in `checkedVenues`. A miss is bounded by where Miorail looked and is never a statement about DeFi as a whole.',
  'What a future integration will do. An announcement is a dated claim by a named party, never a measurement.',
] as const;

const DefiUseKindSchemaV1 = z.enum(['lend', 'borrow', 'collateral']);

const VenueRowSchemaV1 = z
  .object({
    venueId: z.string(),
    venueName: z.string(),
    state: z.enum(['listed', 'not_listed', 'unread']),
    uses: z
      .object({
        lend: z.boolean().nullable(),
        borrow: z.boolean().nullable(),
        collateral: z.boolean().nullable(),
      })
      .strict(),
    curated: z.boolean().nullable(),
    marketRef: z.string().nullable(),
    reason: z.string().nullable(),
    /** Where this row came from, and when. Never the envelope's block. */
    observed: z
      .object({ source: z.enum(['chain_head', 'venue_catalogue']), at: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();

const AnnouncementRowSchemaV1 = z
  .object({
    announcementId: z.string(),
    venueId: z.string(),
    venueName: z.string(),
    announcedBy: z.string(),
    announcedAt: z.string(),
    sourceTitle: z.string(),
    sourceRef: z.string(),
    quote: z.string(),
    announcedUses: z.array(DefiUseKindSchemaV1),
    /**
     * What the venue itself said about this exact address.
     *
     * `unchecked` is not `not_listed`. A venue nobody read must never render
     * as a venue that refused, and an assistant that collapses the two will
     * tell a user a thing was denied when nothing was asked.
     */
    measured: z.enum(['listed', 'not_listed', 'unread', 'unchecked']),
    measuredReason: z.string().nullable(),
    establishedUses: z.array(DefiUseKindSchemaV1),
    unstatedUses: z.array(DefiUseKindSchemaV1),
  })
  .strict();

export const UseAccessAgentInputV1Schema = z
  .object({
    address: z
      .string()
      .min(1)
      .describe(
        'The EXACT Base contract address (0x…) or CAIP-10 of one representation. This tool never resolves a ticker or a company name: different issuers publish different contracts for the same company, and choosing between them is not Miorail’s decision. Use list_reviewed_stocks then get_representations to obtain an address.',
      ),
  })
  .strict();
export type UseAccessAgentInputV1 = z.infer<typeof UseAccessAgentInputV1Schema>;

export const UseAccessAgentOutputV1Schema = z
  .object({
    schemaVersion: z.literal(USE_ACCESS_AGENT_SCHEMA_VERSION_V1),
    chain: z.literal('base'),
    /** A literal. A public read holds no wallet and can never answer for one. */
    walletBound: z.literal(false),
    tokenAddress: z.string(),
    caip10: z.string(),
    underlyingKey: z.string(),
    displaySymbol: z.string().nullable(),
    issuerId: z.string().nullable(),
    /** Read this first and prefer its wording to your own. */
    miorailSummary: z
      .object({
        summary: z.string(),
        checkedVenues: z.array(z.string()),
        establishedUses: z.array(
          z.object({ kind: DefiUseKindSchemaV1, venues: z.array(z.string()) }).strict(),
        ),
        notStated: z.array(z.string()),
      })
      .strict(),
    observedAt: z.string(),
    blockTag: z.string().nullable(),
    /**
     * The fields the block above governs, by name.
     *
     * `defi` is not among them and never was: two venues answer at head and
     * two from catalogues that publish no block. Each venue row carries its
     * own `observed` instead.
     */
    blockTagCovers: z.array(z.string()),
    transfers: z.discriminatedUnion('state', [
      z.object({ state: z.literal('read'), transfersPaused: z.boolean() }).strict(),
      z.object({ state: z.literal('unread'), reason: z.string() }).strict(),
    ]),
    transferPolicies: z.array(
      z
        .object({
          scope: z.enum(['sender', 'receiver', 'executor']),
          state: z.enum(['unrestricted', 'bound', 'unread']),
          policyId: z.string().nullable(),
          policyExists: z.boolean().nullable(),
          reason: z.string().nullable(),
        })
        .strict(),
    ),
    bridge: z
      .object({
        state: z.enum(['none_detected', 'detected', 'unread']),
        configuredPeers: z.array(z.number()).nullable(),
        reason: z.string().nullable(),
      })
      .strict(),
    defi: z
      .object({ checkedVenues: z.array(z.string()), venues: z.array(VenueRowSchemaV1) })
      .strict(),
    announcements: z.array(AnnouncementRowSchemaV1),
  })
  .strict();
export type UseAccessAgentOutputV1 = z.infer<typeof UseAccessAgentOutputV1Schema>;

/**
 * A stored issuer id, or null.
 *
 * A binding written before migration 0059 carries no issuer typing, and an
 * announcement scoped to one issuer must never be shown against a row whose
 * issuer is unknown. Null is that case, and it is not an error.
 */
export function reviewedIssuerIdOrNullV1(raw: unknown): ReviewedIssuerIdV1 | null {
  return typeof raw === 'string' && (REVIEWED_ISSUERS_V1 as readonly string[]).includes(raw)
    ? (raw as ReviewedIssuerIdV1)
    : null;
}

/** `0x…` or CAIP-10, and nothing else. A ticker is refused, not guessed at. */
export function exactUseAccessAddressV1(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const address = trimmed.startsWith('eip155:8453:') ? trimmed.slice('eip155:8453:'.length) : trimmed;
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function useSentenceV1(uses: readonly { kind: DefiUseKindV1; venues: string[] }[]): string {
  const label: Readonly<Record<DefiUseKindV1, string>> = {
    lend: 'supplied to earn',
    borrow: 'borrowed',
    collateral: 'posted as collateral',
  };
  return uses.map((entry) => `${label[entry.kind]} at ${entry.venues.join(', ')}`).join('; ');
}

/**
 * Miorail's own reading of the same rows, written by no model.
 *
 * The tool descriptions in this project all point an assistant at a
 * deterministic summary for the same reason: the dangerous sentence here is
 * never a number, it is the leap from "four venues did not list this" to "this
 * cannot be used in DeFi", and from "Base announced it" to "you can do it now".
 * Both leaps are pre-empted in words the caller may repeat verbatim.
 */
export function useAccessAgentSummaryV1(input: {
  displaySymbol: string | null;
  tokenAddress: string;
  uses: readonly { kind: DefiUseKindV1; venues: string[] }[];
  checkedVenues: readonly string[];
  announcements: readonly UseAccessAgentOutputV1['announcements'][number][];
  /** Venues that answered. A venue that could not be read is in neither this
   * list nor the established uses, and must never be counted as a refusal. */
  answeredVenues: readonly string[];
  unreadVenues: readonly string[];
}): string {
  const name = input.displaySymbol ?? input.tokenAddress;
  const parts: string[] = [];

  if (input.checkedVenues.length === 0) {
    parts.push(`Miorail checked no lending venue for ${name}.`);
  } else if (input.uses.length > 0) {
    parts.push(
      `At the venues Miorail checked (${input.checkedVenues.join(', ')}), ${name} can be ${useSentenceV1(input.uses)}.`,
    );
    parts.push(
      'A venue listing this address is not a statement that the operation would succeed right now: caps, pause flags, liquidity and risk parameters were not read.',
    );
    if (input.unreadVenues.length > 0) {
      parts.push(
        `${input.unreadVenues.join(', ')} could not be read on this call, so ${input.unreadVenues.length === 1 ? 'that venue' : 'those venues'} said nothing either way.`,
      );
    }
  } else if (input.answeredVenues.length === 0) {
    // Every venue failed to answer. Saying "none of them lists it" here would
    // dress Miorail's own read failure in the token's name -- the sentence
    // this project has shipped by accident three times and now refuses to.
    parts.push(
      `None of the venues Miorail checked (${input.checkedVenues.join(', ')}) could be read on this call, so this reading says nothing about where ${name} can be used. That is a gap in Miorail's reading, not a fact about ${name}.`,
    );
  } else {
    parts.push(
      `None of the venues that answered (${input.answeredVenues.join(', ')}) lists ${name}. Other venues exist and were not checked, so this is not a statement that ${name} is absent from DeFi.`,
    );
    if (input.unreadVenues.length > 0) {
      parts.push(
        `${input.unreadVenues.join(', ')} could not be read on this call, so ${input.unreadVenues.length === 1 ? 'that venue' : 'those venues'} said nothing either way.`,
      );
    }
  }

  for (const announcement of input.announcements) {
    const said = `${announcement.announcedBy} announced on ${announcement.announcedAt} that this issuer's stocks can be ${useSentenceV1([{ kind: announcement.announcedUses[0] ?? 'collateral', venues: [announcement.venueName] }])}`;
    if (announcement.measured === 'listed') {
      parts.push(
        `${said}, and ${announcement.venueName} does name this exact address today${announcement.unstatedUses.length > 0 ? ' — though the reading does not establish every use the announcement named' : ''}.`,
      );
    } else if (announcement.measured === 'not_listed') {
      parts.push(
        `${said}. ${announcement.venueName} does not name this exact address today. Both are true: the announcement is real and the listing has not happened. Do not tell a user they can do this now.`,
      );
    } else if (announcement.measured === 'unread') {
      parts.push(
        `${said}. ${announcement.venueName} could not be read on this call, so nothing here confirms or denies it.`,
      );
    } else {
      parts.push(
        `${said}. ${announcement.venueName} was not among the venues this reading checked, so nothing here confirms or denies it.`,
      );
    }
  }

  return parts.join(' ');
}

/** The agent projection of one assembled reading. Pure: no clock, no network. */
export function useAccessForAgentV1(input: {
  use: RepresentationUseAccessV1;
  underlyingKey: string;
  displaySymbol: string | null;
  issuerId: ReviewedIssuerIdV1 | null;
  announcements?: readonly ReviewedVenueAnnouncementV1[];
}): UseAccessAgentOutputV1 {
  const { use } = input;
  const readings = venueAnnouncementReadingsV1({
    issuerId: input.issuerId,
    venues: use.defi.venues,
    announcements: input.announcements,
  });
  const announcements = readings.map((reading) => ({
    announcementId: reading.announcement.announcementId,
    venueId: reading.announcement.venueId,
    venueName: reading.announcement.venueName,
    announcedBy: reading.announcement.announcedBy,
    announcedAt: reading.announcement.announcedAt,
    sourceTitle: reading.announcement.sourceTitle,
    sourceRef: reading.announcement.sourceRef,
    quote: reading.announcement.quote,
    announcedUses: [...reading.announcement.uses],
    measured: reading.measured,
    measuredReason: reading.reason,
    establishedUses: [...reading.establishedUses],
    unstatedUses: [...reading.unstatedUses],
  }));
  const uses = establishedDefiUsesV1(use.defi).filter((entry) => entry.venues.length > 0);
  const unreadVenues = use.defi.venues
    .filter((venue) => venue.state === 'unread')
    .map((venue) => venue.venueName);
  const answeredVenues = use.defi.venues
    .filter((venue) => venue.state !== 'unread')
    .map((venue) => venue.venueName);

  return UseAccessAgentOutputV1Schema.parse({
    schemaVersion: USE_ACCESS_AGENT_SCHEMA_VERSION_V1,
    chain: 'base',
    walletBound: false,
    tokenAddress: use.tokenAddress,
    caip10: use.caip10,
    underlyingKey: input.underlyingKey,
    displaySymbol: input.displaySymbol,
    issuerId: input.issuerId,
    miorailSummary: {
      summary: useAccessAgentSummaryV1({
        displaySymbol: input.displaySymbol,
        tokenAddress: use.tokenAddress,
        uses,
        checkedVenues: use.defi.checkedVenues,
        announcements,
        answeredVenues,
        unreadVenues,
      }),
      checkedVenues: [...use.defi.checkedVenues],
      establishedUses: uses,
      notStated: [...USE_ACCESS_NOT_STATED_V1],
    },
    observedAt: use.observedAt,
    blockTag: use.blockTag,
    blockTagCovers: ['transfers', 'transferPolicies', 'bridge'],
    transfers: use.transfers,
    transferPolicies: use.transferPolicies.map((row) => ({
      scope: row.scope,
      state: row.state,
      policyId: row.state === 'bound' ? row.policyId : null,
      policyExists: row.state === 'bound' ? row.policyExists : null,
      reason: row.state === 'unread' ? row.reason : null,
    })),
    bridge: {
      state: use.bridge.state,
      configuredPeers: use.bridge.state === 'detected' ? use.bridge.configuredPeers : null,
      // An OFT probe that reverted is an ANSWER — there is no bridge at this
      // address — and a probe that could not run is not. They are different
      // states here for the same reason they are different states on the card.
      reason: use.bridge.state === 'unread' ? use.bridge.reason : null,
    },
    defi: {
      checkedVenues: [...use.defi.checkedVenues],
      venues: use.defi.venues.map((venue) => ({
        venueId: venue.venueId,
        venueName: venue.venueName,
        state: venue.state,
        uses: venue.uses,
        curated: venue.curated ?? null,
        marketRef: venue.marketRef,
        reason: venue.reason,
        observed: venue.observed ?? null,
      })),
    },
    announcements,
  });
}
