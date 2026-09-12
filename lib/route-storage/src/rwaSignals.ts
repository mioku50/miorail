import { z } from 'zod';

import type { RwaSignalKindV1 } from './rwaSignalKinds.js';
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
const TxHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected a lowercase 32-byte transaction hash');
const PositiveDigits = z.string().regex(/^[1-9][0-9]*$/, 'expected a positive integer string');

// The kinds live in their own leaf module so the browser-facing Discover
// contract can import them without dragging every repository behind this index
// into a webpack bundle. Re-exported here so nothing that already imports them
// from this file has to change.
export {
  RWA_SIGNAL_KINDS_V1,
  RWA_ONCHAIN_SIGNAL_KINDS_V1,
  type RwaSignalKindV1,
  type RwaOnchainSignalKindV1,
} from './rwaSignalKinds.js';

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
 * An announcement, as the issuer bracketed it.
 *
 * Three fields are nullable and the fourth says why: Base publishes topic0 for
 * `Announcement` and does not publish which of its parameters are indexed, so
 * a layout this build cannot read arrives as `topic_only` -- the action
 * executed, in this transaction, and its words were somewhere we could not
 * read them. The raw log is kept in `b20_corporate_actions` either way.
 *
 * `EndAnnouncement` is deliberately not a signal. It closes a bracket the
 * opening event already reported; recording both would report one corporate
 * action twice.
 */
const CorporateActionFactsV1Schema = z
  .object({
    event: z.literal('announcement'),
    announcementId: z.string().min(1).max(200).nullable(),
    description: z.string().min(1).max(2_000).nullable(),
    uri: z.string().min(1).max(2_000).nullable(),
    payloadState: z.enum(['decoded', 'topic_only']),
    transactionHash: TxHash,
    blockNumber: PositiveDigits,
  })
  .strict();

/**
 * The number of underlying shares one token unit redeems for, changed.
 *
 * Both setters are reported. Which one an issuer used -- the deprecated
 * `updateMultiplier` or the scheduled `updateUIMultiplier` -- is not the
 * holder's problem, and a feed that carried only one of them would be silent
 * on a dividend that happened to use the other.
 */
const MultiplierChangeFactsV1Schema = z
  .object({
    event: z.enum(['multiplier_updated', 'ui_multiplier_updated']),
    /** WAD-scaled, never pre-divided. Null when the log's layout was unread. */
    multiplierWad: PositiveDigits.nullable(),
    payloadState: z.enum(['decoded', 'topic_only']),
    transactionHash: TxHash,
    blockNumber: PositiveDigits,
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
    z
      .object({
        kind: z.literal('official_asset_corporate_action_announced'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        /** The BLOCK's own time. Not when we read it: an announcement executed
         * when it executed, and a tail catching up must not date it to the
         * moment it caught up. */
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: CorporateActionFactsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('official_asset_multiplier_changed'),
        chainId: z.literal(8453),
        subjectAddress: Address,
        officialAddress: z.null(),
        occurredAt: z.string().datetime(),
        dedupeKey: z.string().min(1).max(200),
        facts: MultiplierChangeFactsV1Schema,
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
