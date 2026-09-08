import { z } from 'zod';

import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Signals: a transition somebody observed, not a state somebody queried.
//
// The whole interface is shaped by one rule, and migration 0055 states the
// reasoning: a change can only be reported by a writer that had already stored
// the state it changed from. Anything derived later from the state itself
// dates the event to the day we started looking.
//
// So an emitter opens its watch before it looks, the pass that opens the watch
// reports nothing, and `recordSignals` refuses a kind that is not being
// watched. That refusal is the load-bearing one: without it the first run of
// any new emitter would announce the entire corpus as news.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lowercase 20-byte address');

/**
 * Every kind, and what each one requires somebody to have observed.
 *
 * There is no `trade` kind. A movement through a venue is not a swap -- 2 of
 * 34 measured transactions were not -- so the two market kinds below are
 * driven by a cash-exit round trip that either completed or did not.
 */
export const RWA_SIGNAL_KINDS_V1 = [
  'official_source_added_asset',
  'official_source_removed_asset',
  'official_asset_lookalike_created',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_cash_exit_changed',
] as const;
export type RwaSignalKindV1 = (typeof RWA_SIGNAL_KINDS_V1)[number];

/**
 * The move that makes a cost change worth a row.
 *
 * Measured on the launch corpus over six hours, the median round-trip cost
 * moved by zero. A threshold this far above the observed drift is not a
 * sensitivity knob -- it is the line under which a "change" would be our own
 * quote noise wearing the asset's name.
 */
export const RWA_CASH_EXIT_CHANGE_THRESHOLD_BPS_V1 = 50;

const AddedFactsV1Schema = z
  .object({
    sourceKind: z.enum(['base_docs_technical', 'base_product_list', 'backed_assets_api']),
    sourceUrl: z.string().url().startsWith('https://'),
    ticker: z.string().min(1).max(16),
    displayName: z.string().min(1).max(120).nullable(),
  })
  .strict();

const LookalikeFactsV1Schema = z
  .object({
    matchKind: z.enum(['symbol_exact', 'symbol_normalized', 'name_normalized']),
    matchedAlias: z.enum(['published_ticker', 'underlying', 'display_name']),
    matchedValue: z.string().min(1).max(120),
    officialTicker: z.string().min(1).max(16),
    launchSymbol: z.string().max(120),
    launchName: z.string().max(200),
  })
  .strict();

/** The rung a market transition was decided on. Exact sizes only: a decade
 * ladder measured at four sizes cannot say anything about a fifth. */
const MarketFactsV1Schema = z
  .object({
    ticker: z.string().min(1).max(16),
    destination: z.enum(['USDC', 'ETH']),
    requestedCashAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    roundTripCostBps: z
      .string()
      .regex(/^-?(0|[1-9][0-9]*)$/)
      .nullable(),
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
  })
  .strict();

const CostFactsV1Schema = z
  .object({
    ticker: z.string().min(1).max(16),
    destination: z.enum(['USDC', 'ETH']),
    requestedCashAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    previousRoundTripCostBps: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    roundTripCostBps: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    /** Signed, in the direction the cost moved. Stored rather than derived so
     * a surface cannot subtract two numbers in the wrong order. */
    changeBps: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
    thresholdBps: z.literal(RWA_CASH_EXIT_CHANGE_THRESHOLD_BPS_V1),
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
  })
  .strict();

/**
 * One recorded transition.
 *
 * `occurredAt` is when the emitter observed the change; `recordedAt` is when
 * the row was written. They are separate fields because a pass that catches up
 * after an outage would otherwise date every finding to the moment it caught
 * up.
 */
export const RwaSignalV1Schema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('official_source_added_asset'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: AddedFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_source_removed_asset'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: AddedFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_asset_lookalike_created'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: Address,
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: LookalikeFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_asset_market_became_active'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: MarketFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_asset_market_became_unreachable'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: MarketFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_asset_cash_exit_changed'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: CostFactsV1Schema,
      })
      .strict(),
  ])
  .superRefine((row, ctx) => {
    if (row.officialAddress !== null && row.officialAddress === row.subjectAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a signal cannot name one contract as both its subject and the official asset',
      });
    }
  });

export type RwaSignalV1 = z.infer<typeof RwaSignalV1Schema>;

/** A stored signal, as read back. */
export interface RwaSignalRowV1 {
  signalId: string;
  kind: RwaSignalKindV1;
  chainId: number;
  subjectAddress: string;
  officialAddress: string | null;
  occurredAt: string;
  recordedAt: string;
  facts: Record<string, unknown>;
}

/** When a kind became observable, and whether this call is what opened it. */
export interface RwaSignalWatchRowV1 {
  chainId: number;
  kind: RwaSignalKindV1;
  watchingSince: string;
  /**
   * True only for the call that created the row. The emitter that sees it must
   * report nothing for that kind on that pass: everything looks new to
   * somebody who has just started looking.
   */
  openedNow: boolean;
}

export interface RwaSignalOutcomeV1 {
  /** Transitions written by this call. */
  recorded: string[];
  /** Transitions already on file. A re-run over the same window is not news. */
  alreadyRecorded: string[];
}

export function assertRwaSignalV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): RwaSignalV1 {
  const parsed = RwaSignalV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new RouteStorageIntegrityError(`rwa signal failed validation on ${direction}: ${detail}`);
}

/** The refusal raised when a signal would be recorded for a kind nobody was
 * watching. A distinct type so a caller cannot mistake it for a transport
 * failure and retry it into existence. */
export class RwaSignalNotWatchedError extends RouteStorageIntegrityError {
  constructor(kind: RwaSignalKindV1) {
    super(
      `refusing a ${kind} signal: that kind has no watch, so there is no earlier state it could be a change from`,
    );
    this.name = 'RwaSignalNotWatchedError';
  }
}

/**
 * The rule both repositories enforce, written once.
 *
 * Two failures it stops, and each one has produced a false feed elsewhere in
 * this product: a signal for a kind that has never been watched (the whole
 * corpus announced as news on the first pass), and a signal dated before the
 * watch opened (a backfill reporting history as if it had just happened).
 */
export function assertSignalIsWatchedV1(
  signal: RwaSignalV1,
  watch: ReadonlyMap<RwaSignalKindV1, string>,
): void {
  const watchingSince = watch.get(signal.kind);
  if (watchingSince === undefined) throw new RwaSignalNotWatchedError(signal.kind);
  if (Date.parse(signal.occurredAt) < Date.parse(watchingSince)) {
    throw new RouteStorageIntegrityError(
      `refusing a ${signal.kind} signal dated ${signal.occurredAt}: nothing was watching that kind until ${watchingSince}, so this is history rather than a change`,
    );
  }
}

export interface RwaSignalRepositoryV1 {
  /**
   * Declare that an emitter is now watching these kinds.
   *
   * Idempotent, and the `openedNow` flag is the whole point: the emitter that
   * opened a watch must skip that kind for the pass that opened it.
   */
  openSignalWatch(input: {
    chainId: number;
    kinds: readonly RwaSignalKindV1[];
    at: string;
  }): Promise<RwaSignalWatchRowV1[]>;

  /** Every open watch, for the surface that has to explain an empty feed. */
  signalWatch(input: { chainId: number }): Promise<Omit<RwaSignalWatchRowV1, 'openedNow'>[]>;

  /** One pass's transitions. Re-running over the same window writes nothing. */
  recordSignals(input: {
    chainId: number;
    recordedAt: string;
    signals: readonly RwaSignalV1[];
  }): Promise<RwaSignalOutcomeV1>;

  /** The feed. Newest first, bounded, optionally one kind. */
  recentSignals(input: {
    chainId: number;
    kinds?: readonly RwaSignalKindV1[];
    limit: number;
    /**
     * Only what occurred at or after this instant.
     *
     * "The newest fifty changes" and "what changed today" are different
     * questions, and a limit alone can only answer the first. On a busy day
     * this table records over a hundred transitions, so a caller asking about
     * today and reading a bare page of fifty would see two thirds of a day and
     * have no way to tell that from a quiet one. The window makes the span of
     * the answer a fact the caller supplied rather than one it has to infer
     * from the oldest row it happened to receive.
     *
     * Omitted means every recorded signal, which is what the rolling feed on
     * the screen asks for.
     */
    since?: string;
  }): Promise<RwaSignalRowV1[]>;

  /** One asset's own history, for the card that shows it. */
  signalsForSubject(input: {
    chainId: number;
    subjectAddress: string;
    limit: number;
  }): Promise<RwaSignalRowV1[]>;
}
