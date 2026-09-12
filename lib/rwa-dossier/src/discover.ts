// The leaf module, not the package index: the index pulls every repository
// behind it, one of which imports `node:crypto`, and this file is compiled into
// the browser bundle through `@mioagent/api-zod`.
import { RWA_SIGNAL_KINDS_V1 } from '@mioagent/route-storage/rwa-signal-kinds';
import { z } from 'zod';

import {
  ExecutableValueV1Schema,
  ReferenceExecutableComparisonV1Schema,
  ReferenceValueV1Schema,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Phase 6 — the Official Assets overview.
//
// The per-asset dossier answers "tell me everything about this contract" and
// costs a dozen chain reads to do it. This is the other read: thirteen assets
// on one screen, and the only live thing on it is the reference feed.
// Everything else comes from what the workers already stored.
//
// The distinction this contract exists to keep is the one the roadmap opens
// with: OFFICIAL IS NOT A MARKET. Coinbase issues thirteen tokenized equities
// on Base; four of them are on the product page and, measured, four of them
// have a cash route at any size. A surface that showed only the four would be
// hiding the most useful sentence it can say, and a surface that showed all
// thirteen with a price would be inventing twelve of them.
//
// So `market` is two independent axes and neither is allowed to stand in for
// the other:
//
//   * `routeStatus` -- did an approved router return a round trip, at exact
//     sizes only. This is what "active market" means on a card.
//   * `observation` -- has the ledger tail seen the token move through a
//     venue. Movements, never swaps: 2 of 34 measured transactions through the
//     v4 singleton carried no Swap event at all.
//
// An asset with no route and no observation reads as "not measured" until
// something has actually measured it. `not_measured` and
// `no_route_at_measured_sizes` are different words here for exactly that
// reason -- one is a fact about the asset and the other is a fact about us.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Timestamp = z.string().datetime();
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);

export const OFFICIAL_SOURCE_KINDS_V1 = [
  'base_docs_technical',
  'base_product_list',
  'backed_assets_api',
] as const;

/**
 * What a measured ladder said, in one word.
 *
 * `measurement_failed` is separate from the two no-route words on purpose. A
 * router that timed out and a router that answered "no route" look identical
 * in an empty result and mean opposite things, and this product has shipped
 * that confusion three times under a different name.
 *
 * The two no-route words are separate from each other for a reason the Phase 4
 * measurement is careful about. The ladder is sized in CASH, so it buys the
 * asset first to learn an exact token amount. If the buy leg has no route the
 * sell was never attempted -- which proves nothing about selling a position
 * somebody already holds, and must never be reported as "cannot be exited".
 *
 * It does prove something, though, and the something is worth a word:
 * `no_entry_route_at_measured_sizes` means an approved router would not sell
 * you the asset for cash at any measured size. Nine of thirteen Coinbase
 * tokenized equities read this way on 2026-08-25.
 */
export const OFFICIAL_ROUTE_STATUSES_V1 = [
  'cash_route_established',
  'no_route_at_measured_sizes',
  'no_entry_route_at_measured_sizes',
  'measurement_failed',
  'not_measured',
] as const;
export type OfficialRouteStatusV1 = (typeof OFFICIAL_ROUTE_STATUSES_V1)[number];

export const OfficialCashExitRungPreviewV1Schema = z
  .object({
    requestedCashAtomic: Digits,
    destination: z.enum(['USDC', 'ETH']),
    status: z.enum([
      'full',
      'partial',
      'buy_only',
      'unavailable',
      'not_measured',
      'measurement_failed',
    ]),
    roundTripCostBps: SignedDigits.nullable(),
    /** True when this rung's cost is a SMALLER rung's cost, carried forward
     * because the larger size did not complete. The reader must be able to see
     * that the number belongs to a different size. */
    derivedFromExactRung: z.boolean(),
    lowerBoundRequestedCashAtomic: Digits.nullable(),
    /**
     * The router explicitly refused the BUY leg at this size.
     *
     * Carried as a typed flag rather than left in an error string, because it
     * is the difference between "our measurement did not finish" and "no
     * approved router will sell you this at this size" -- and the second is a
     * fact about the market that a surface is entitled to state.
     */
    entryRouteRefused: z.boolean(),
  })
  .strict();
export type OfficialCashExitRungPreviewV1 = z.infer<typeof OfficialCashExitRungPreviewV1Schema>;

export const OfficialAssetMarketV1Schema = z
  .object({
    routeStatus: z.enum(OFFICIAL_ROUTE_STATUSES_V1),
    measuredAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    approvedSources: z.array(z.string().min(1).max(100)).max(16),
    /** The cash ladder, one rung per measured size, USDC destination first. */
    ladder: z.array(OfficialCashExitRungPreviewV1Schema).max(16),
    /** Independent of the ladder: what the token's own ledger showed. */
    observation: z
      .object({
        status: z.enum(['movements_observed', 'no_movements_observed', 'not_observed']),
        semantics: z.literal('venue_transfers_not_confirmed_swaps'),
        /** Identified pools holding this exact token as one side of the pair.
         * A singleton is excluded on purpose: it carries every pool on Base,
         * so counting it would credit this asset with somebody else's venue. */
        pairedPoolCount: z.number().int().min(0).nullable(),
        movementCount: z.number().int().min(0).nullable(),
      })
      .strict(),
  })
  .strict();
export type OfficialAssetMarketV1 = z.infer<typeof OfficialAssetMarketV1Schema>;

export const OfficialAssetSummaryV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    ticker: z.string().min(1).max(16),
    displayName: z.string().min(1).max(120).nullable(),
    issuer: z.string().min(1).max(80),
    /** Sources that still list it. Two names one asset; one is the ordinary
     * state of this corpus and is shown rather than reconciled. */
    listedIn: z.array(z.enum(OFFICIAL_SOURCE_KINDS_V1)).min(1).max(4),
    sourceDiscrepancy: z.boolean(),
    referenceValue: ReferenceValueV1Schema,
    executableValue: ExecutableValueV1Schema,
    comparison: ReferenceExecutableComparisonV1Schema,
    market: OfficialAssetMarketV1Schema,
    /** Contracts on file wearing this asset's name. Never a severity. */
    lookalikeCount: z.number().int().min(0),
  })
  .strict();
export type OfficialAssetSummaryV1 = z.infer<typeof OfficialAssetSummaryV1Schema>;

export const OfficialSourceStatusV1Schema = z
  .object({
    sourceKind: z.enum(OFFICIAL_SOURCE_KINDS_V1),
    sourceUrl: z.string().url().startsWith('https://'),
    /** Null before the source has ever been checked. */
    checkedAt: Timestamp.nullable(),
    status: z.enum(['ok', 'unreachable', 'unparsable']).nullable(),
    assetCount: z.number().int().min(0).nullable(),
    /** The newest SUCCESSFUL check, which is the freshness clock. A failed
     * check moves `checkedAt` and never this one. */
    lastSuccessfulAt: Timestamp.nullable(),
  })
  .strict();

export const OfficialAssetsOverviewV1Schema = z
  .object({
    schemaVersion: z.literal('official-assets-overview/v1'),
    chainId: z.literal(8453),
    observedAt: Timestamp,
    /**
     * Four counts that add up to the issuance, which is why the fourth is here
     * even when it is zero: three counts that do not sum invite the reader to
     * do the subtraction themselves and get a fifth number nobody measured.
     */
    counts: z
      .object({
        officialIssuance: z.number().int().min(0),
        cashRouteEstablished: z.number().int().min(0),
        noRouteAtMeasuredSizes: z.number().int().min(0),
        noEntryRouteAtMeasuredSizes: z.number().int().min(0),
        measurementFailed: z.number().int().min(0),
        notMeasured: z.number().int().min(0),
      })
      .strict(),
    sources: z.array(OfficialSourceStatusV1Schema).min(1).max(4),
    /** How far the ledger tail has read. The bound on every `not_observed`. */
    marketObservation: z
      .object({
        status: z.enum(['observed', 'never_run']),
        checkedThroughBlock: z.number().int().positive().nullable(),
        checkedAt: Timestamp.nullable(),
        /**
         * Pools the tail has identified, and counterparties it has not asked
         * about yet.
         *
         * A movement is only attributed once its counterparty is known to be a
         * venue, so with nothing identified the tail can read ten thousand
         * transfers and store zero events. Reporting THAT as "no movements
         * observed" would be a finding about thirteen assets authored entirely
         * by our own backlog.
         */
        identifiedVenueCount: z.number().int().min(0).nullable(),
        candidatesPendingIdentification: z.number().int().min(0).nullable(),
      })
      .strict(),
    assets: z.array(OfficialAssetSummaryV1Schema).max(64),
    gaps: z.array(z.string().min(1).max(120)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { counts } = value;
    const sum =
      counts.cashRouteEstablished +
      counts.noRouteAtMeasuredSizes +
      counts.noEntryRouteAtMeasuredSizes +
      counts.measurementFailed +
      counts.notMeasured;
    if (sum !== counts.officialIssuance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message: `the route counts sum to ${sum} and the issuance is ${counts.officialIssuance}`,
      });
    }
  });
export type OfficialAssetsOverviewV1 = z.infer<typeof OfficialAssetsOverviewV1Schema>;

// ---------------------------------------------------------------------------
// Lookalikes
// ---------------------------------------------------------------------------

export const LOOKALIKE_ALIAS_KINDS_V1 = ['published_ticker', 'underlying', 'display_name'] as const;

export const OfficialLookalikeCardV1Schema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: Address,
    officialAddress: Address,
    officialTicker: z.string().min(1).max(16),
    officialDisplayName: z.string().min(1).max(120).nullable(),
    matchKind: z.enum(['symbol_exact', 'symbol_normalized', 'name_normalized']),
    matchedAlias: z.enum(LOOKALIKE_ALIAS_KINDS_V1),
    matchedValue: z.string().min(1).max(120),
    /** What the contract itself declared when it was flagged. */
    declaredSymbol: z.string().max(120),
    declaredName: z.string().max(200),
    launchedAt: Timestamp.nullable(),
    firstFlaggedAt: Timestamp,
    lastSeenAt: Timestamp,
  })
  .strict();
export type OfficialLookalikeCardV1 = z.infer<typeof OfficialLookalikeCardV1Schema>;

/**
 * The sentence the tab carries, stored in code so no surface can soften it or
 * sharpen it into an accusation. It says what a row IS and what it is not, and
 * both halves are load-bearing.
 */
export const LOOKALIKE_DISCLAIMER_V1 =
  'Address identity remains authoritative. A resemblance is a match on declared metadata and does not establish fraud, intent, or any relationship between the contracts.';

export const OfficialLookalikeFeedV1Schema = z
  .object({
    schemaVersion: z.literal('official-lookalike-feed/v1'),
    chainId: z.literal(8453),
    observedAt: Timestamp,
    disclaimer: z.literal(LOOKALIKE_DISCLAIMER_V1),
    counts: z
      .object({
        total: z.number().int().min(0),
        publishedTicker: z.number().int().min(0),
        underlying: z.number().int().min(0),
        displayName: z.number().int().min(0),
      })
      .strict(),
    /** Null when the feed is unfiltered. */
    filteredBy: z.enum(LOOKALIKE_ALIAS_KINDS_V1).nullable(),
    /** Null before the corpus has ever been scanned. */
    lastScanAt: Timestamp.nullable(),
    cards: z.array(OfficialLookalikeCardV1Schema).max(200),
  })
  .strict();
export type OfficialLookalikeFeedV1 = z.infer<typeof OfficialLookalikeFeedV1Schema>;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// The kinds are NOT re-declared here. They were, until a new kind was added to
// the store and this list stayed behind: the wire schema then refused the very
// rows the repository had just written, and the failure surfaced as a signal
// feed that had silently stopped growing. One list, in the package that
// defines what a signal is.

export const RwaSignalCardV1Schema = z
  .object({
    signalId: z.string().min(1).max(40),
    kind: z.enum(RWA_SIGNAL_KINDS_V1),
    chainId: z.literal(8453),
    subjectAddress: Address,
    subjectTicker: z.string().min(1).max(16).nullable(),
    officialAddress: Address.nullable(),
    officialTicker: z.string().min(1).max(16).nullable(),
    occurredAt: Timestamp,
    recordedAt: Timestamp,
    facts: z.record(z.unknown()),
  })
  .strict();
export type RwaSignalCardV1 = z.infer<typeof RwaSignalCardV1Schema>;

export const RwaSignalFeedV1Schema = z
  .object({
    schemaVersion: z.literal('rwa-signal-feed/v1'),
    chainId: z.literal(8453),
    observedAt: Timestamp,
    /**
     * When each kind became observable.
     *
     * The feed publishes this because "no signals" and "nothing has been
     * watched yet" are the same empty list and opposite facts. A kind absent
     * from this array has never had an emitter run, and nothing before its
     * date can ever appear.
     */
    watching: z
      .array(z.object({ kind: z.enum(RWA_SIGNAL_KINDS_V1), watchingSince: Timestamp }).strict())
      .max(16),
    /**
     * The blocks the onchain corporate-action tail has actually read.
     *
     * A second date, and it is not the same date as `watching`. The watch opens
     * when an emitter first runs; this range is what was read, and it reaches
     * back behind the watch to before the first tokenized stock existed. Saying
     * only `watchingSince` over a two-month backfill would understate the
     * record to the point of being wrong: "nothing before today can appear
     * here" is false when the blocks before today were read and were empty.
     *
     * Null until the tail has ever run — and a surface must then say "nobody
     * has looked", never "nothing happened".
     */
    corporateActionRecord: z
      .object({
        fromBlock: z.number().int().positive(),
        toBlock: z.number().int().positive(),
        actions: z.number().int().min(0),
        /** Whether the range reaches back to before the first tokenized stock
         * existed. Decided here, where the genesis block is pinned, rather than
         * by a surface comparing numbers it has no source for — a range that
         * started later is still a range, and it must not be described as
         * complete. */
        sinceFirstStock: z.boolean(),
      })
      .strict()
      .nullable(),
    /** What is deliberately NOT reported here, so its absence is not read as
     * quiet. Rendered by the surface, not written by it. */
    notReported: z.array(z.string().min(1).max(200)).max(8),
    cards: z.array(RwaSignalCardV1Schema).max(200),
  })
  .strict();
export type RwaSignalFeedV1 = z.infer<typeof RwaSignalFeedV1Schema>;

/**
 * The one thing this feed will not report until Phase 2's gap is closed.
 *
 * Measured: of 34 transactions moving a tracked asset through the v4
 * singleton, 32 carried a Swap event and 2 did not. A "first trade" signal
 * firing because somebody seeded a pool would be a false statement about the
 * asset, so movements stay off this feed and the surface says so.
 */
export const RWA_SIGNALS_NOT_REPORTED_V1 = [
  'Trades. A movement through a venue is not a confirmed swap, and confirming one is a separate read that is not built yet.',
  'Price moves. Nothing here watches a quote between measurements.',
] as const;
