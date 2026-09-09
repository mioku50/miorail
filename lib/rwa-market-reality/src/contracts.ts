import { z } from 'zod';
import {
  MARKET_REALITY_MARKET_SESSIONS_V1,
  MARKET_REALITY_PUBLICATION_MODES_V1,
  MARKET_REALITY_REFERENCE_REASON_CODES_V1,
  MarketRealityBasisDecisionV1Schema,
  MarketRealityEvidenceSnapshotContractV1Schema,
  MarketRealityReferenceCalendarV1Schema,
  MarketRealityReferenceEvidenceV1Schema,
  MarketRealityReferenceStateV1Schema,
  type MarketRealityBasisDecisionV1,
  type MarketRealityReferenceStateV1,
} from '@mioagent/route-storage/market-reality-contracts';

export const MarketRealityEvidenceSnapshotV1Schema =
  MarketRealityEvidenceSnapshotContractV1Schema;

export {
  MARKET_REALITY_MARKET_SESSIONS_V1,
  MARKET_REALITY_PUBLICATION_MODES_V1,
  MARKET_REALITY_REFERENCE_REASON_CODES_V1,
  MarketRealityBasisDecisionV1Schema,
  MarketRealityReferenceCalendarV1Schema,
  MarketRealityReferenceEvidenceV1Schema,
  MarketRealityReferenceStateV1Schema,
};
export type { MarketRealityBasisDecisionV1, MarketRealityReferenceStateV1 };

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();

export const MarketRealityDirectionV1Schema = z.enum(['buy', 'sell']);
export type MarketRealityDirectionV1 = z.infer<typeof MarketRealityDirectionV1Schema>;

export const MarketRealityQuestionV1Schema = z
  .object({
    chainId: z.literal(8453),
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    direction: MarketRealityDirectionV1Schema,
    requestedCashAtomic: Digits,
    cashAsset: z.literal('USDC'),
    cashAddress: Address,
    cashDecimals: z.literal(6),
    destination: z.enum(['USDC', 'ETH']),
    exactSizeOnly: z.literal(true),
    baseOnly: z.literal(true),
  })
  .strict();
export type MarketRealityQuestionV1 = z.infer<typeof MarketRealityQuestionV1Schema>;

export const MarketRealityQuoteEvidenceV1Schema = z
  .object({
    kind: z.literal('router_quote'),
    source: z.string().min(1).max(100),
    direction: MarketRealityDirectionV1Schema,
    routeKey: z.string().min(1).max(300),
    candidateHash: Hash,
    evidenceHash: Hash,
    inputAtomic: Digits,
    outputAtomic: Digits,
    observedAt: Timestamp,
    expiresAt: Timestamp,
    blockNumber: Digits.nullable(),
    /**
     * The exact pools the priced route went through, as the router named them.
     *
     * `eip155:8453/aerodrome-cl-3:0x853f5f1b92b16714fe6cda67caad0856b83c7ab9` —
     * a chain, a protocol slug and a pool address, stored since the first
     * cash-exit run and never once shown.
     *
     * Base's own product page says Coinbase tokenized stocks have deep
     * liquidity on Aerodrome, and every priced card in this product was already
     * routing through an Aerodrome concentrated-liquidity pool. Reporting the
     * quote as "kyberswap" and stopping there named the aggregator that
     * answered and hid the venue that held the money — so the product looked
     * like it had missed the one venue it was actually measuring.
     *
     * This is attribution, never pricing. The number stays the router's; these
     * are the addresses that number went through, and each one can be checked
     * against the chain by reading the pool's own `factory()`.
     */
    liquiditySources: z.array(z.string().min(1).max(300)).max(100).default([]),
  })
  .strict();

export const MarketRealitySourceObservationV2Schema = z
  .object({
    source: z.string().min(1).max(100),
    status: z.enum(['quoted', 'no_route', 'unsized', 'measurement_failed', 'not_measured']),
    errorCode: z.string().min(1).max(120).nullable(),
    quoteEvidence: MarketRealityQuoteEvidenceV1Schema.nullable(),
    simulationEvidence: z
      .object({
        kind: z.literal('route_simulation'),
        status: z.literal('not_simulated'),
        evidenceHash: z.null(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Current evidence and history are not the same thing, and this is where the
// product stopped being able to say so.
//
// A router quote is good for about twenty seconds. The background sampler runs
// on a timer measured in tens of minutes. So every quote the sampler takes is
// expired before a reader arrives, and an engine that only knows "open quote or
// nothing" reports nothing — for a token it measured perfectly forty minutes
// ago.
//
// Both facts are real and they answer different questions:
//
//   current           what does this cost RIGHT NOW, on evidence still open
//   lastObservation   what did it cost the last time anybody looked, and when
//
// A background sample may never be rendered as the first. It is history, it is
// labelled with its age, and a surface that shows it must say so. That is the
// whole point of keeping them in separate fields rather than in one field with
// a freshness flag somebody can forget to read.
// ---------------------------------------------------------------------------

export const MarketRealityObservationV2Schema = z
  .object({
    source: z.string().min(1).max(100),
    /** What the router said. `not_measured` never appears here: an observation
     * exists because somebody measured. */
    status: z.enum(['quoted', 'no_route', 'unsized', 'measurement_failed']),
    errorCode: z.string().min(1).max(120).nullable(),
    observedAt: Timestamp,
    expiresAt: Timestamp,
    /** Cash returned at the exact size, when the observation carried a quote. */
    returnedCashAtomic: Digits.nullable(),
    /** True while this observation is still inside its own validity window. */
    open: z.boolean(),
  })
  .strict();
export type MarketRealityObservationV2 = z.infer<typeof MarketRealityObservationV2Schema>;

/**
 * Whether this representation has anything current, anything at all, or nothing.
 *
 * Three values because a reader needs three different sentences, and the middle
 * one is the ordinary state of this product: measured, and not measured
 * recently enough for the number to still be true.
 */
export const MARKET_REALITY_LIVENESS_V1 = ['live', 'history_only', 'never_measured'] as const;
export type MarketRealityLivenessV1 = (typeof MARKET_REALITY_LIVENESS_V1)[number];

export const MarketRealitySupplyV1Schema = z
  .object({
    state: z.enum(['positive_supply', 'zero_supply', 'supply_unknown']),
    totalSupplyAtomic: Digits.nullable(),
    decimals: z.number().int().min(0).max(36).nullable(),
    normalization: z.literal('raw_erc20_total_supply'),
    blockNumber: Digits.nullable(),
    blockHash: Hash.nullable(),
    observedAt: Timestamp.nullable(),
    evidenceHash: Hash.nullable(),
    source: z.literal('erc20_total_supply'),
    readOutcome: z.enum(['success', 'rpc_failure', 'decode_failure', 'not_observed']),
    fresh: z.boolean(),
    reason: z.string().min(1).max(240).nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const successful = row.readOutcome === 'success';
    if (
      successful !==
      (row.totalSupplyAtomic !== null &&
        row.decimals !== null &&
        row.blockNumber !== null &&
        row.blockHash !== null &&
        row.observedAt !== null &&
        row.evidenceHash !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a successful supply read carries one complete exact-address observation',
      });
    }
    if ((row.state !== 'supply_unknown') !== (successful && row.fresh)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only a fresh successful supply read establishes the current denominator state',
      });
    }
    if ((row.state === 'supply_unknown') !== (row.reason !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'unknown supply states explain why, established states do not',
      });
    }
    if (row.state === 'zero_supply' && row.totalSupplyAtomic !== '0') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'zero supply requires exact atomic zero',
      });
    }
    if (
      row.state === 'positive_supply' &&
      (row.totalSupplyAtomic === null || row.totalSupplyAtomic === '0')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'positive supply requires a positive amount',
      });
    }
  });

export const MarketRealityRepresentationV2Schema = z
  .object({
    tokenAddress: Address,
    issuerId: z.enum(['coinbase', 'dinari', 'backed']),
    issuerInstrumentKey: z.string().min(1).max(200),
    representationKind: z.enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper', 'dinari_dshare']),
    supply: MarketRealitySupplyV1Schema,
    status: z.enum(['full', 'unavailable', 'not_measured', 'measurement_failed']),
    routePolicyKey: Hash.nullable(),
    exactTestedTokenAtomic: Digits.nullable(),
    normalizedExposureAtomic: Digits.nullable(),
    normalizedExposureDecimals: z.number().int().min(0).max(36).nullable(),
    normalization: z.enum([
      'fresh_ratio_applied',
      'reviewed_token_already_applied',
      'not_established',
    ]),
    /** The multiplier's own clock: when it was last read, and when that read
     * stops counting. Four things on this row expire independently — the
     * router quote, the round trip, the reference session and this — and a
     * surface that can only age two of them silently attaches the wrong
     * deadline to the other two. Null where nothing is ratio-bound. */
    /* Defaulted rather than required so the field is additive on the wire: a
     * browser holding the new bundle can be talking to an API instance that
     * has not restarted yet, and that window is every deploy. */
    normalizationCheckedAt: Timestamp.nullable().default(null),
    normalizationExpiresAt: Timestamp.nullable().default(null),
    returnedCashAtomic: Digits.nullable(),
    effectivePriceAtomic: Digits.nullable(),
    effectivePriceDecimals: z.literal(8).nullable(),
    premiumDiscountBps: SignedDigits.nullable(),
    reference: MarketRealityReferenceStateV1Schema,
    basis: MarketRealityBasisDecisionV1Schema,
    sources: z.array(MarketRealitySourceObservationV2Schema).max(16),
    observedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable(),
    liveness: z.enum(MARKET_REALITY_LIVENESS_V1),
    /** The newest observation whatever its age. History, never a current price
     * — every field above it is computed from OPEN evidence only. */
    lastObservation: MarketRealityObservationV2Schema.nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.liveness === 'never_measured' && row.lastObservation !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liveness'],
        message: 'a representation with an observation has been measured',
      });
    }
    if (row.liveness !== 'never_measured' && row.lastObservation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastObservation'],
        message: 'a measured representation carries the observation that measured it',
      });
    }
    if (row.liveness === 'history_only' && row.status === 'full') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'a full answer requires open evidence, and history is not open evidence',
      });
    }
    if (row.premiumDiscountBps !== row.basis.premiumDiscountBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['premiumDiscountBps'],
        message: 'the compatibility field must equal the authoritative typed basis decision',
      });
    }
    // A reading and its deadline are one fact. Half of it would let a surface
    // print "read 20 min ago" with no window, or a window with nothing in it.
    if ((row.normalizationCheckedAt === null) !== (row.normalizationExpiresAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalizationCheckedAt'],
        message: 'a normalization reading and the instant it stops counting travel together',
      });
    }
    if (row.normalization === 'fresh_ratio_applied' && row.normalizationCheckedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalizationCheckedAt'],
        message: 'an applied ratio was read at a stated instant',
      });
    }
    // The token already carries its own exposure, so there is no second
    // reading to age. A clock here would be a deadline nobody set.
    if (row.normalization === 'reviewed_token_already_applied' && row.normalizationCheckedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['normalizationCheckedAt'],
        message: 'a token that already applies its own ratio has no separate reading to age',
      });
    }
  });

export type MarketRealityRepresentationV2 = z.infer<typeof MarketRealityRepresentationV2Schema>;

export const MarketRealityResponseV2Schema = z
  .object({
    schemaVersion: z.literal('market-reality/v2'),
    question: MarketRealityQuestionV1Schema,
    universe: z
      .object({
        reviewedRepresentationCount: z.number().int().min(0),
        positiveSupplyRepresentationCount: z.number().int().min(0),
        zeroSupplyRepresentationCount: z.number().int().min(0),
        unresolvedSupplyRepresentationCount: z.number().int().min(0),
      })
      .strict(),
    marketOutcomeCoverage: z
      .object({
        policy: z.literal('same_reviewed_router_policy_exact_size_direction_and_destination'),
        eligibleRepresentationCount: z.number().int().min(0),
        establishedOutcomeCount: z.number().int().min(0),
        status: z.enum(['complete', 'incomplete']),
        reason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    numericComparisonCoverage: z
      .object({
        policy: z.literal('fresh_numeric_quotes_same_exact_question_and_normalization'),
        eligibleRepresentationCount: z.number().int().min(0),
        pricedRepresentationCount: z.number().int().min(0),
        status: z.enum(['complete', 'incomplete']),
        reason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    ranking: z
      .object({
        status: z.literal('withheld'),
        policy: z.literal('withheld_phase_10b8'),
        orderedTokenAddresses: z.array(Address).max(0),
        reason: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    quoteEvidenceIsExecutionProof: z.literal(false),
    representations: z.array(MarketRealityRepresentationV2Schema).max(256),
    assembledAt: Timestamp,
  })
  .strict();
export type MarketRealityResponseV2 = z.infer<typeof MarketRealityResponseV2Schema>;

// ---------------------------------------------------------------------------
// The chooser.
//
// Phase 10B's first control is "which underlying", and until this existed
// there was no read that could answer it: the graph could be walked from a key
// but not enumerated. A surface with no list would have had to accept a typed
// ISIN, which is a research tool, not a product.
//
// `representationCount` and `issuerIds` are both here because they are
// different sentences. Two representations from one issuer is a structure
// choice — a rebasing token and its wrapper. Two representations from two
// issuers is the thing this whole phase exists to compare. A single number
// cannot tell a reader which one they are looking at.
// ---------------------------------------------------------------------------

export const MarketRealityIndexEntryV1Schema = z
  .object({
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    canonicalName: z.string().min(1).max(200),
    displaySymbol: z.string().min(1).max(40).nullable(),
    assetClass: z.enum(['equity', 'fund_share', 'other', 'unknown']),
    identifierScheme: z.string().min(1).max(40).nullable(),
    identifierValue: z.string().min(1).max(120).nullable(),
    representationCount: z.number().int().min(0),
    /**
     * How many of those representations have tokens outstanding.
     *
     * A separate sentence from `representationCount` for the same reason
     * `issuerIds` is: nine of the thirteen Coinbase tokenized stocks are
     * deployed contracts holding exactly zero, so a count of contracts says
     * nothing about whether a reader can do anything here. Zero is a measured
     * zero — a representation nobody has read is not counted as live.
     */
    liveRepresentationCount: z.number().int().min(0),
    issuerIds: z.array(z.enum(['coinbase', 'dinari', 'backed'])).max(8),
    /**
     * Whether a Coinbase B20 contract represents this security on Base.
     *
     * The one issuer distinction the consumer surface leads with, and it is a
     * fact about the corpus rather than a preference: B20 is the standard Base
     * documents, and it is the only one of the three whose representations
     * mostly price. Measured 2026-09-04 at $1,000 SELL: 10 of 13 Coinbase
     * representations hold a cash route, 2 of 21 Backed, and 0 of 96 Dinari.
     */
    coinbaseIssued: z.boolean(),
    /** True when more than one ISSUER carries it — the comparable case. */
    multiIssuer: z.boolean(),
  })
  .strict();
export type MarketRealityIndexEntryV1 = z.infer<typeof MarketRealityIndexEntryV1Schema>;

export const MarketRealityIndexV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality-index/v1'),
    chainId: z.literal(8453),
    /**
     * Which corpus this page is a slice of.
     *
     * `coinbase_b20` is the default because it is the question Base's own
     * documentation answers and the one a reader can act on. `all_representations`
     * is the same corpus unfiltered — nothing is removed from the evidence
     * store by the default, only from the first screen.
     */
    scope: z.enum(['coinbase_b20', 'all_representations']),
    /** Every reviewed underlying in `scope`, most-represented first. */
    entries: z.array(MarketRealityIndexEntryV1Schema).max(500),
    /** Corpus-wide, never the page: a count beside a filter is a claim about
     * the corpus, and this surface pages. */
    totals: z
      .object({
        underlyings: z.number().int().min(0),
        boundRepresentations: z.number().int().min(0),
        multiIssuerUnderlyings: z.number().int().min(0),
        /** Corpus-wide, whatever the scope: how many securities a Coinbase B20
         * contract represents, and how many the whole reviewed corpus holds.
         * Both are always reported so a scoped page can name what it is not
         * showing instead of leaving the reader to discover it. */
        coinbaseUnderlyings: z.number().int().min(0),
        allUnderlyings: z.number().int().min(0),
      })
      .strict(),
    observedAt: Timestamp,
  })
  .strict();
export type MarketRealityIndexV1 = z.infer<typeof MarketRealityIndexV1Schema>;

export const MARKET_REALITY_INDEX_SCOPES_V1 = ['coinbase_b20', 'all_representations'] as const;
export type MarketRealityIndexScopeV1 = (typeof MARKET_REALITY_INDEX_SCOPES_V1)[number];

// ---------------------------------------------------------------------------
// The series. Same exact question, moved along a time axis.
//
// `interpolated` is a literal `false` rather than a comment, because the one
// thing a chart makes irresistibly easy is drawing a line through a gap. A
// consumer that ever needs to know whether these points were smoothed can read
// it off the payload instead of trusting the code that produced it.
// ---------------------------------------------------------------------------

export const MARKET_REALITY_WINDOW_KEYS_V1 = ['1h', '6h', '24h', '7d'] as const;

export const MarketRealityHistoryPointV1Schema = z
  .object({
    observedAt: Timestamp,
    status: z.enum(['quoted', 'no_route', 'unsized', 'measurement_failed']),
    source: z.string().min(1).max(100),
    /** Cash at the exact size. Null on a point that is a failure or a refusal
     * — which is still a point, because an hour with no route is a fact. */
    returnedCashAtomic: Digits.nullable(),
    testedTokenAtomic: Digits.nullable(),
    errorCode: z.string().min(1).max(120).nullable(),
    /** The router set behind this point. Two points measured through different
     * sets are not comparable with each other. */
    approvedSources: z.array(z.string().min(1).max(100)).max(16),
    /** Exact append-only evidence captured with this run. Null means the run
     * predates Phase 10C.2A; history never reconstructs it later. */
    marketReality: MarketRealityEvidenceSnapshotV1Schema.nullable(),
  })
  .strict();
export type MarketRealityHistoryPointV1 = z.infer<typeof MarketRealityHistoryPointV1Schema>;

export const MarketRealityHistorySeriesV1Schema = z
  .object({
    tokenAddress: Address,
    issuerId: z.enum(['coinbase', 'dinari', 'backed']).nullable(),
    representationKind: z
      .enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper', 'dinari_dshare'])
      .nullable(),
    /** Oldest first. */
    points: z.array(MarketRealityHistoryPointV1Schema).max(500),
    pointCount: z.number().int().min(0),
    quotedCount: z.number().int().min(0),
    firstObservedAt: Timestamp.nullable(),
    lastObservedAt: Timestamp.nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.quotedCount > row.pointCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quotedCount'],
        message: 'a quoted point is a point',
      });
    }
    if ((row.pointCount === 0) !== (row.firstObservedAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstObservedAt'],
        message: 'a series with points has a first observation',
      });
    }
  });

export const MarketRealityHistoryV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality-history/v1'),
    chainId: z.literal(8453),
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    direction: MarketRealityDirectionV1Schema,
    requestedCashAtomic: Digits,
    destination: z.enum(['USDC', 'ETH']),
    window: z.enum(MARKET_REALITY_WINDOW_KEYS_V1),
    since: Timestamp,
    /** Never true. A gap in the record stays a gap. */
    interpolated: z.literal(false),
    representations: z.array(MarketRealityHistorySeriesV1Schema).max(256),
    assembledAt: Timestamp,
  })
  .strict();
export type MarketRealityHistoryV1 = z.infer<typeof MarketRealityHistoryV1Schema>;

// Phase 12.2. Re-exported from the contracts entry so the API and browser
// parse the same Radar payload the evaluator writes.
export {
  MARKET_REALITY_RADAR_CAPACITY_V1,
  MARKET_REALITY_RADAR_EVALUATION_OUTCOMES_V1,
  MarketRealityRadarEventV1Schema,
  MarketRealityRadarPublicWatchV1Schema,
  MarketRealityRadarResponseV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  type MarketRealityRadarEventV1,
  type MarketRealityRadarResponseV1,
  type MarketRealityRadarWatchInputV1,
} from './radar.js';

/**
 * What a live measurement actually spent.
 *
 * Returned beside the answer so a surface can say "nothing needed measuring"
 * instead of implying it refreshed — a button that silently did nothing reads
 * as a button that does not work.
 */
export const MarketRealityMeasurementV1Schema = z
  .object({
    /** Representations a router was asked about on this call. */
    measured: z.array(Address).max(256),
    /** Left alone: their evidence was still inside its own validity window. */
    reusedOpen: z.array(Address).max(256),
    /** Left alone: measured moments ago, inside the cooldown. */
    reusedCooldown: z.array(Address).max(256),
    /** Reviewed and visible, but no outstanding supply exists at the latest
     * fresh successful read, so there is no current position to size. */
    excludedZeroSupply: z.array(Address).max(256),
    /** Could not be measured, and accused of nothing. */
    unresolved: z
      .array(z.object({ tokenAddress: Address, reason: z.string().min(1).max(120) }).strict())
      .max(256),
    /** True when this caller joined a measurement already running for the same
     * exact question. Sharing, not staleness. */
    joinedInFlight: z.boolean(),
  })
  .strict();
export type MarketRealityMeasurementV1 = z.infer<typeof MarketRealityMeasurementV1Schema>;

/**
 * The answer plus what the measurement spent.
 *
 * `.extend` rather than `.and`: an intersection evaluates BOTH schemas against
 * the whole input, so a strict object on the left rejects the very key the
 * right-hand side adds. That failure arrives as a thrown parse error inside a
 * route's catch block and leaves a 500 with nothing in the log.
 */
export const MarketRealityLiveResponseV2Schema = MarketRealityResponseV2Schema.extend({
  measurement: MarketRealityMeasurementV1Schema,
}).strict();
export type MarketRealityLiveResponseV2 = z.infer<typeof MarketRealityLiveResponseV2Schema>;

// ---------------------------------------------------------------------------
// Pooled liquidity, as a fact two surfaces state.
//
// The measurement itself is taken elsewhere and stored; what lives here is the
// one derivation over it, because the Use & access board and the Stocks
// evidence bundle both publish this number and must not be able to disagree
// about it.
//
// The row is structural on purpose. It is the subset of a stored reading that
// a concentration figure needs, so this module — which the narrator runtime is
// allowed to import — never has to reach the package that can read a chain.
// ---------------------------------------------------------------------------

export interface PooledRowMeasurementV1 {
  poolAddress: string;
  /** Null when the chain named no venue for this pool. */
  venueId: string | null;
  venueName: string | null;
  tokenBalanceAtomic: string;
  tokenDecimals: number;
  pairedBalanceAtomic: string | null;
  pairedDecimals: number | null;
  pairedSymbol: string | null;
}

export interface PooledLiquidityMeasurementV1 {
  state: 'measured' | 'not_measured';
  blockNumber: number | null;
  readAt: string | null;
  rows: readonly PooledRowMeasurementV1[];
}

export interface PooledConcentrationV1 {
  lead: PooledRowMeasurementV1;
  poolCount: number;
  totalAtomic: string;
  /** The deepest pool's share of the pooled total, to one decimal place. */
  leadSharePercent: number;
  /** Venues the chain named, deduplicated. Never includes an unnamed row. */
  namedVenues: string[];
}

/**
 * How concentrated a token's pooled amount is, from the balances alone.
 *
 * A count is the dangerous figure here. "39 pools hold NVDAc" is true
 * arithmetic about a market that does not exist: one Aerodrome pool held about
 * 89% of it and two dozen of the rest were pairs against memecoins. So the
 * deepest pool's share is derived here and travels wherever the count does.
 *
 * The share is measured, never a threshold somebody chose. An earlier draft
 * called everything below a hundredth of the largest "noise" and silently
 * stopped firing, because on the real corpus those pairs sit at about a
 * fiftieth.
 *
 * Null when nothing was read, or when every row read zero — an absence to
 * state, not a zero to divide by.
 */
export function pooledConcentrationV1(
  rows: readonly PooledRowMeasurementV1[],
): PooledConcentrationV1 | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + BigInt(row.tokenBalanceAtomic), 0n);
  if (total <= 0n) return null;
  let lead = rows[0]!;
  for (const row of rows) {
    if (BigInt(row.tokenBalanceAtomic) > BigInt(lead.tokenBalanceAtomic)) lead = row;
  }
  return {
    lead,
    poolCount: rows.length,
    totalAtomic: total.toString(),
    leadSharePercent: Number((BigInt(lead.tokenBalanceAtomic) * 1000n) / total) / 10,
    namedVenues: [
      ...new Set(
        rows
          .filter((row) => row.venueId !== null && row.venueName !== null)
          .filter((row) => row.venueId !== 'unnamed_cl' && row.venueId !== 'unnamed_pair')
          .map((row) => row.venueName as string),
      ),
    ],
  };
}
