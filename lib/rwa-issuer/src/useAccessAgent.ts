import { z } from 'zod';

import {
  POOL_VENUE_TIERS_V1,
  poolExplorerUrlV1,
  type PoolVenueIdV1,
} from '@mioagent/route-storage';

import { REVIEWED_ISSUERS_V1, type ReviewedIssuerIdV1 } from './issuers.js';
import {
  establishedDefiUsesV1,
  type DefiUseKindV1,
  type PooledLiquidityV1,
  type RepresentationUseAccessV1,
} from './useAccess.js';
import {
  venueAnnouncementReadingsV1,
  type ReviewedVenueAnnouncementV1,
} from './venueAnnouncements.js';
import { ecosystemSummaryV1, type RepresentationEcosystemV1 } from './ecosystemClaims.js';

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
  'What a trade of a given size would actually get. A pool balance is every position the contract holds, in range or out, plus uncollected fees — it is not depth and not a quote.',
] as const;

const DefiUseKindSchemaV1 = z.enum(['lend', 'borrow', 'collateral']);

/**
 * One pool, as an assistant needs it: which contract, whose venue, how much of
 * each side, and where a reader can open it.
 *
 * `venueTier` is the part that must not be dropped. `protocol` names the
 * exchange; `engine` names the AMM machinery and NOT whose front end runs on it
 * — Algebra licenses its engine to many DEXes — and `shape` says only whether
 * the pool is concentrated or a constant-product pair. An assistant that reads
 * `venueName` alone will call an engine an exchange, which is why the name
 * carries its own caveat too.
 */
const PoolRowSchemaV1 = z
  .object({
    poolAddress: z.string(),
    venueId: z.string().nullable(),
    venueName: z.string().nullable(),
    venueTier: z.enum(['protocol', 'engine', 'shape']).nullable(),
    /** The exchange's own page for this exact pool, where one is verified. */
    venuePageUrl: z.string().nullable(),
    explorerUrl: z.string(),
    /** Atomic plus its decimals. Never a float — the last digits are the
     * difference between $1,614,910.95 and $1,614,910. */
    tokenBalanceAtomic: z.string(),
    tokenDecimals: z.number().int().min(0).max(36),
    pairedTokenAddress: z.string().nullable(),
    pairedBalanceAtomic: z.string().nullable(),
    pairedDecimals: z.number().int().min(0).max(36).nullable(),
    pairedSymbol: z.string().nullable(),
  })
  .strict();

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

const EcosystemBlockSchemaV1 = z
  .object({
    listedBy: z.string(),
    sourceTitle: z.string(),
    sourceRef: z.string(),
    reviewedAt: z.string(),
    tally: z
      .object({
        named: z.number().int().nonnegative(),
        namesIt: z.number().int().nonnegative(),
        doesNot: z.number().int().nonnegative(),
        unread: z.number().int().nonnegative(),
        unchecked: z.number().int().nonnegative(),
      })
      .strict(),
    rows: z.array(
      z
        .object({
          appId: z.string(),
          appName: z.string(),
          claim: z.string(),
          category: z.enum([
            'issuance',
            'oracle',
            'exchange',
            'routing',
            'lending',
            'yield',
            'analytics',
            'wallet',
          ]),
          measured: z.enum(['listed', 'not_listed', 'unread', 'unchecked']),
          /** What was read, in a reader's words. Never an id. */
          evidence: z.string().nullable(),
          /** The id behind it, for a caller that wants to check the claim. */
          detail: z.string().nullable(),
          reason: z.string().nullable(),
        })
        .strict(),
    ),
    /** Miorail's own reading of the tally, written by no model. */
    summary: z.string(),
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
    /**
     * The pools that hold this exact address.
     *
     * `defi` answers a LENDING question, and for these tokens the honest answer
     * is almost always no — while an Aerodrome concentrated-liquidity pool held
     * 3,715 NVDAc against $1.6M of USDC. An assistant asked about LP or pools
     * and given only the lending venues will report that the token has no DeFi
     * use, which is false and is our omission rather than the token's property.
     *
     * `not_measured` is a statement about Miorail and never about the token: it
     * means nobody checked, which is not the same as none.
     */
    pools: z.discriminatedUnion('state', [
      z
        .object({
          state: z.literal('measured'),
          blockNumber: z.number().int().nonnegative().nullable(),
          readAt: z.string().nullable(),
          poolCount: z.number().int().nonnegative(),
          /**
           * The deepest pool's share of everything measured in pools, 0-100.
           *
           * The number that stops a COUNT from lying: thirty-nine pools hold
           * NVDAc and one of them holds about 88% of it, while twenty-four of
           * the rest are memecoin pairs. Null when nothing is pooled at all.
           */
          deepestSharePercent: z.number().min(0).max(100).nullable(),
          rows: z.array(PoolRowSchemaV1),
        })
        .strict(),
      z.object({ state: z.literal('not_measured'), reason: z.string() }).strict(),
    ]),
    announcements: z.array(AnnouncementRowSchemaV1),
    /**
     * Who Base says supports these stocks, against who Miorail can see
     * supporting THIS address.
     *
     * `measured` here carries the SAME four words the announcements above use,
     * and `unchecked` is load-bearing in both: most of the apps Base names are
     * apps Miorail does not read, and an assistant that reports them as
     * refusals publishes our reach under their names. Null when the caller
     * supplied no ecosystem evidence at all.
     */
    ecosystem: EcosystemBlockSchemaV1.nullable(),
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
/**
 * The pooled reading, projected for an assistant.
 *
 * Ranked by MEASURED balance and never by count, and the deepest pool's share
 * travels with the count so the two cannot be read apart. A count on its own is
 * true arithmetic about a market that does not exist.
 */
export function agentPoolsV1(
  pools: PooledLiquidityV1 | undefined,
): UseAccessAgentOutputV1['pools'] {
  if (!pools || pools.state !== 'measured' || pools.rows.length === 0) {
    return {
      state: 'not_measured',
      reason:
        'Miorail did not check the pools holding this address. Not checked is not the same as none: pools may exist and hold real amounts.',
    };
  }
  const total = pools.rows.reduce((sum, row) => sum + BigInt(row.tokenBalanceAtomic), 0n);
  const lead = BigInt(pools.rows[0]!.tokenBalanceAtomic);
  return {
    state: 'measured',
    blockNumber: pools.blockNumber,
    readAt: pools.readAt,
    poolCount: pools.rows.length,
    deepestSharePercent: total > 0n ? Number((lead * 1000n) / total) / 10 : null,
    rows: pools.rows.map((row) => ({
      poolAddress: row.poolAddress,
      venueId: row.venueId,
      venueName: row.venueName,
      venueTier:
        row.venueId && row.venueId in POOL_VENUE_TIERS_V1
          ? POOL_VENUE_TIERS_V1[row.venueId as PoolVenueIdV1]
          : null,
      venuePageUrl: row.venuePageUrl,
      explorerUrl: poolExplorerUrlV1(row.poolAddress),
      tokenBalanceAtomic: row.tokenBalanceAtomic,
      tokenDecimals: row.tokenDecimals,
      pairedTokenAddress: row.pairedTokenAddress,
      pairedBalanceAtomic: row.pairedBalanceAtomic,
      pairedDecimals: row.pairedDecimals,
      pairedSymbol: row.pairedSymbol,
    })),
  };
}

/**
 * The ecosystem card, projected for an assistant.
 *
 * The deterministic summary travels WITH the rows rather than being left for
 * the caller to compose: the sentence that must not be lost is the last one —
 * that most of the list was never read — and a model handed thirty rows and no
 * sentence will write "only six of thirty support it" every time.
 */
export function agentEcosystemV1(
  ecosystem: RepresentationEcosystemV1 | undefined,
  subject: { displaySymbol: string | null; tokenAddress: string },
): UseAccessAgentOutputV1['ecosystem'] {
  if (!ecosystem) return null;
  return {
    ...ecosystem,
    summary: ecosystemSummaryV1({
      displaySymbol: subject.displaySymbol,
      tokenAddress: subject.tokenAddress,
      readings: ecosystem.rows.map((row) => ({
        app: {
          appId: row.appId,
          appName: row.appName,
          claim: row.claim,
          category: row.category,
          binding: { kind: 'none' },
        },
        measured: row.measured,
        evidence: row.evidence,
        detail: row.detail,
        reason: row.reason,
      })),
    }),
  };
}

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
  /** The pooled reading, so the summary can name the use these tokens actually
   * have. Optional so a caller that measured no pools reads unchanged. */
  pools?: UseAccessAgentOutputV1['pools'];
  /**
   * The ecosystem card's own sentence, appended verbatim.
   *
   * Here rather than only in the block, because an assistant told to read
   * `miorailSummary` first will answer from it alone — and the question this
   * card exists for ("Base says Aave supports these") is asked against a page
   * the user has already read.
   */
  ecosystem?: UseAccessAgentOutputV1['ecosystem'];
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

  // Pools come LAST in the paragraph and first in importance, because the
  // lending sentences above are the ones that mislead on their own: an
  // assistant asked "does this token have any DeFi use?" and given four lending
  // venues that all said no will answer "none", while the token's largest
  // onchain use by a wide margin is an AMM position.
  if (input.pools) {
    if (input.pools.state === 'not_measured') {
      parts.push(
        `Miorail did not check the pools holding ${name} on this call. That is a gap in this reading, not an absence of pools.`,
      );
    } else {
      const deepest = input.pools.rows[0];
      const venue = deepest?.venueTier === 'protocol' && deepest.venueName ? ` on ${deepest.venueName}` : '';
      parts.push(
        `${name} is held by ${input.pools.poolCount} pool${input.pools.poolCount === 1 ? '' : 's'} on Base`
          + (input.pools.deepestSharePercent === null
            ? '.'
            : `, and the deepest one${venue} holds ${input.pools.deepestSharePercent}% of everything measured in pools — a pool count is not a market.`),
      );
      parts.push(
        'These are balances the pool contracts hold, in range or out, plus uncollected fees. They are not depth and not a quote: what a trade of a given size would get is a separate measurement.',
      );
      if (deepest && deepest.venueTier !== 'protocol' && deepest.venueName) {
        parts.push(
          `The deepest pool's venue is ${deepest.venueTier === 'engine' ? 'only identified as far as its AMM engine' : 'not identified beyond the kind of pool it is'}, so name the pool by its address rather than by an exchange.`,
        );
      }
    }
  }

  if (input.ecosystem) parts.push(input.ecosystem.summary);

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
  const pools = agentPoolsV1(use.pools);
  const ecosystem = agentEcosystemV1(use.ecosystem, {
    displaySymbol: input.displaySymbol,
    tokenAddress: use.tokenAddress,
  });

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
        pools,
        ecosystem,
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
    pools,
    announcements,
    ecosystem,
  });
}
