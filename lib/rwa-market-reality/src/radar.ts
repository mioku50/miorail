import { z } from 'zod';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  marketRealitySnapshotForObservationV1,
  type CashExitMeasurementRunV1,
  type CashExitSourceObservationV1,
} from '@mioagent/route-storage/official-cash-exit';
import type { MarketRealityEvidenceSnapshotV1 } from '@mioagent/route-storage/market-reality-contracts';

// ---------------------------------------------------------------------------
// Phase 12.2 — Radar watches one exact market question.
//
// A watch is not a ticker alert. Its identity includes the reviewed Base
// address, exact cash rung, direction, destination and reviewed route policy.
// Only two successful comparable points can make an event. A failed provider
// call remains a gap and deliberately does not advance the baseline.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const PositiveDigits = z.string().regex(/^[1-9][0-9]*$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Timestamp = z.string().datetime();
const UnderlyingKey = z
  .string()
  .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
  .max(200);

export const MARKET_REALITY_RADAR_CAPACITY_V1 = 25;

const MarketRealityRadarWatchInputObjectV1Schema = z
  .object({
    underlyingKey: UnderlyingKey,
    tokenAddress: Address,
    direction: z.enum(['buy', 'sell']),
    requestedCashAtomic: PositiveDigits,
    destination: z.enum(['USDC', 'ETH']),
    routePolicyKey: Hash,
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
  })
  .strict();

export const MarketRealityRadarWatchInputV1Schema =
  MarketRealityRadarWatchInputObjectV1Schema
  .superRefine((row, ctx) => {
    if (new Set(row.approvedSources).size !== row.approvedSources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedSources'],
        message: 'approved sources must be unique',
      });
    }
  });
export type MarketRealityRadarWatchInputV1 = z.infer<
  typeof MarketRealityRadarWatchInputV1Schema
>;

export const MARKET_REALITY_RADAR_EVALUATION_OUTCOMES_V1 = [
  'baseline',
  'compared',
  'measurement_failed',
  'unsized',
  'policy_changed',
] as const;
export type MarketRealityRadarEvaluationOutcomeV1 =
  (typeof MARKET_REALITY_RADAR_EVALUATION_OUTCOMES_V1)[number];

const MarketRealityRadarWatchObjectV1Schema = MarketRealityRadarWatchInputObjectV1Schema.extend({
  watchId: Hash,
  userId: z.string().min(1).max(200),
  chainId: z.literal(8453),
  issuerId: z.enum(['coinbase', 'dinari', 'backed']),
  representationKind: z.enum([
    'b20_asset',
    'rebasing_erc20',
    'non_rebasing_erc4626_wrapper',
  ]),
  createdAt: Timestamp,
  lastEvaluatedAt: Timestamp.nullable(),
  lastComparableAt: Timestamp.nullable(),
  lastEvaluationOutcome: z.enum(MARKET_REALITY_RADAR_EVALUATION_OUTCOMES_V1).nullable(),
});

function refineRadarWatchV1(
  row: {
    approvedSources: string[];
    lastEvaluatedAt: string | null;
    lastComparableAt: string | null;
    lastEvaluationOutcome: MarketRealityRadarEvaluationOutcomeV1 | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (new Set(row.approvedSources).size !== row.approvedSources.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvedSources'],
      message: 'approved sources must be unique',
    });
  }
  if ((row.lastEvaluatedAt === null) !== (row.lastEvaluationOutcome === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastEvaluationOutcome'],
      message: 'an evaluation outcome requires an evaluation time',
    });
  }
  if (row.lastComparableAt !== null && row.lastEvaluatedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastComparableAt'],
      message: 'a comparable point is an evaluation',
    });
  }
}

export const MarketRealityRadarWatchV1Schema =
  MarketRealityRadarWatchObjectV1Schema.superRefine(refineRadarWatchV1);
export type MarketRealityRadarWatchV1 = z.infer<typeof MarketRealityRadarWatchV1Schema>;

export const MarketRealityRadarPublicWatchV1Schema =
  MarketRealityRadarWatchObjectV1Schema.omit({ userId: true }).superRefine(refineRadarWatchV1);

const RadarRatioV1Schema = z
  .object({
    ratioKind: z.enum(['b20_multiplier', 'dinari_balance_per_share', 'backed_evm_multiplier']),
    application: z.enum(['apply_to_raw_balance', 'already_applied_by_token']),
    rawValue: Digits,
    scale: Digits,
    evidenceHash: Hash,
  })
  .strict();

const RadarReferenceV1Schema = z
  .object({
    status: z.enum(['fresh', 'stale', 'paused', 'unavailable', 'unknown']),
    marketSession: z.enum(['regular_hours', 'after_hours', 'weekend', 'unknown']),
    publicationMode: z.enum([
      'live_reference',
      'holding_last_close',
      'corporate_action_hold',
      'stale',
      'unknown',
    ]),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    reasonCode: z.string().min(1).max(120),
  })
  .strict();

/** Compact cursor facts. The immutable source snapshot remains in the cash
 * exit run and both of its hashes stay attached here. */
export const MarketRealityRadarPointV1Schema = z
  .object({
    snapshotHash: Hash,
    observationHash: Hash,
    tokenAddress: Address,
    direction: z.enum(['buy', 'sell']),
    requestedCashAtomic: PositiveDigits,
    destination: z.enum(['USDC', 'ETH']),
    routePolicyKey: Hash,
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    status: z.enum(['quoted', 'no_route']),
    source: z.string().min(1).max(100),
    observedAt: Timestamp,
    returnedCashAtomic: Digits.nullable(),
    effectivePriceAtomic: Digits.nullable(),
    effectivePriceDecimals: z.number().int().min(0).max(36).nullable(),
    reference: RadarReferenceV1Schema,
    ratio: RadarRatioV1Schema.nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      row.status === 'quoted' &&
      row.direction === 'sell' &&
      row.destination === 'USDC' &&
      row.returnedCashAtomic === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returnedCashAtomic'],
        message: 'a quoted SELL into USDC requires exact cash back',
      });
    }
    if (row.status === 'quoted' && row.direction === 'buy') {
      if ((row.effectivePriceAtomic === null) !== (row.effectivePriceDecimals === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effectivePriceAtomic'],
          message: 'a BUY effective price travels with its decimals',
        });
      }
    }
    if (row.status === 'no_route' && row.returnedCashAtomic !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returnedCashAtomic'],
        message: 'no-route carries no cash value',
      });
    }
  });
export type MarketRealityRadarPointV1 = z.infer<typeof MarketRealityRadarPointV1Schema>;

const RadarEventBaseV1 = z.object({
  eventId: Hash,
  watchId: Hash,
  chainId: z.literal(8453),
  tokenAddress: Address,
  previousSnapshotHash: Hash,
  snapshotHash: Hash,
  previousObservedAt: Timestamp,
  occurredAt: Timestamp,
  approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
});

export const MarketRealityRadarEventV1Schema = z.discriminatedUnion('kind', [
  RadarEventBaseV1.extend({
    kind: z.literal('sell_exit_cost_changed'),
    facts: z
      .object({
        source: z.string().min(1).max(100),
        previousCashBackAtomic: Digits,
        cashBackAtomic: Digits,
        cashBackChangeAtomic: SignedDigits,
        previousExitCostBps: SignedDigits,
        exitCostBps: SignedDigits,
        changeBps: SignedDigits,
      })
      .strict(),
  }).strict(),
  RadarEventBaseV1.extend({
    kind: z.literal('buy_effective_price_changed'),
    facts: z
      .object({
        source: z.string().min(1).max(100),
        previousEffectivePriceAtomic: Digits,
        effectivePriceAtomic: Digits,
        effectivePriceDecimals: z.number().int().min(0).max(36),
        changeBps: SignedDigits,
      })
      .strict(),
  }).strict(),
  RadarEventBaseV1.extend({
    kind: z.enum(['route_became_unavailable', 'route_became_available']),
    facts: z
      .object({
        previousStatus: z.enum(['quoted', 'no_route']),
        status: z.enum(['quoted', 'no_route']),
        source: z.string().min(1).max(100).nullable(),
      })
      .strict(),
  }).strict(),
  RadarEventBaseV1.extend({
    kind: z.literal('market_session_changed'),
    facts: z
      .object({
        previousMarketSession: z.enum(['regular_hours', 'after_hours', 'weekend']),
        marketSession: z.enum(['regular_hours', 'after_hours', 'weekend']),
        previousPublicationMode: z.enum([
          'live_reference',
          'holding_last_close',
          'corporate_action_hold',
          'stale',
        ]),
        publicationMode: z.enum([
          'live_reference',
          'holding_last_close',
          'corporate_action_hold',
          'stale',
        ]),
      })
      .strict(),
  }).strict(),
  RadarEventBaseV1.extend({
    kind: z.literal('reference_became_stale'),
    facts: z
      .object({
        previousFreshness: z.literal('fresh'),
        freshness: z.literal('stale'),
        reasonCode: z.literal('reviewed_reference_stale'),
      })
      .strict(),
  }).strict(),
  RadarEventBaseV1.extend({
    kind: z.literal('representation_ratio_changed'),
    facts: z
      .object({
        ratioKind: z.enum([
          'b20_multiplier',
          'dinari_balance_per_share',
          'backed_evm_multiplier',
        ]),
        application: z.enum(['apply_to_raw_balance', 'already_applied_by_token']),
        previousRawValue: Digits,
        previousScale: Digits,
        rawValue: Digits,
        scale: Digits,
      })
      .strict(),
  }).strict(),
]);
export type MarketRealityRadarEventV1 = z.infer<typeof MarketRealityRadarEventV1Schema>;

export const MarketRealityRadarResponseV1Schema = z
  .object({
    schemaVersion: z.literal('market-reality-radar/v1'),
    chainId: z.literal(8453),
    watches: z.array(MarketRealityRadarPublicWatchV1Schema).max(250),
    events: z.array(MarketRealityRadarEventV1Schema).max(250),
    assembledAt: Timestamp,
  })
  .strict();
export type MarketRealityRadarResponseV1 = z.infer<typeof MarketRealityRadarResponseV1Schema>;

export interface MarketRealityRadarRepositoryV1 {
  addWatch(input: {
    userId: string;
    question: MarketRealityRadarWatchInputV1;
    issuerId: MarketRealityRadarWatchV1['issuerId'];
    representationKind: MarketRealityRadarWatchV1['representationKind'];
    now: string;
  }): Promise<MarketRealityRadarWatchV1>;
  removeWatch(input: { userId: string; watchId: string }): Promise<boolean>;
  watchesForUser(input: { userId: string }): Promise<MarketRealityRadarWatchV1[]>;
  watchesForToken(input: { chainId: 8453; tokenAddress: string }): Promise<MarketRealityRadarWatchV1[]>;
  distinctWatchedAddresses(input: { chainId: 8453; limit: number }): Promise<string[]>;
  pointForWatch(input: { watchId: string }): Promise<MarketRealityRadarPointV1 | null>;
  recordEvaluation(input: {
    watch: MarketRealityRadarWatchV1;
    at: string;
    outcome: MarketRealityRadarEvaluationOutcomeV1;
    point: MarketRealityRadarPointV1 | null;
    events: readonly MarketRealityRadarEventV1[];
  }): Promise<{ recorded: string[]; alreadyRecorded: string[] }>;
  eventsForUser(input: { userId: string; limit: number }): Promise<MarketRealityRadarEventV1[]>;
}

/**
 * The part of a watch that decides whether two observations may be compared.
 *
 * `issuerId` and `representationKind` say which reviewed row a tenant watch
 * belongs to. They take no part in comparability, so a caller holding an exact
 * question whose issuer typing is still incomplete may use these functions
 * without asserting an issuer it cannot prove.
 */
export type MarketRealityComparabilityKeyV1 = Omit<
  MarketRealityRadarWatchV1,
  'issuerId' | 'representationKind'
>;

function sourceSetKeyV1(sources: readonly string[]): string {
  return [...sources].sort().join('\u0000');
}

/** Repository-boundary guard for the exact question carried by a cursor. */
export function marketRealityRadarPointBelongsToWatchV1(
  point: MarketRealityRadarPointV1,
  watch: MarketRealityRadarWatchV1,
): boolean {
  return (
    point.tokenAddress === watch.tokenAddress &&
    point.direction === watch.direction &&
    point.requestedCashAtomic === watch.requestedCashAtomic &&
    point.destination === watch.destination &&
    point.routePolicyKey === watch.routePolicyKey &&
    sourceSetKeyV1(point.approvedSources) === sourceSetKeyV1(watch.approvedSources)
  );
}

export function marketRealityRadarWatchIdV1(
  userId: string,
  question: MarketRealityRadarWatchInputV1,
): `0x${string}` {
  const parsed = MarketRealityRadarWatchInputV1Schema.parse(question);
  return stableHashV1('market-reality-radar-watch/v1', {
    userId,
    ...parsed,
    approvedSources: [...parsed.approvedSources].sort(),
  });
}

function quoteForDirectionV1(row: CashExitSourceObservationV1, direction: 'buy' | 'sell') {
  return direction === 'buy' ? row.buyQuote : row.sellQuote;
}

function compactPointV1(input: {
  row: CashExitSourceObservationV1;
  snapshot: MarketRealityEvidenceSnapshotV1;
  watch: MarketRealityComparabilityKeyV1;
}): MarketRealityRadarPointV1 {
  const quote = quoteForDirectionV1(input.row, input.watch.direction);
  return MarketRealityRadarPointV1Schema.parse({
    snapshotHash: input.snapshot.snapshotHash,
    observationHash: input.snapshot.observationHash,
    tokenAddress: input.watch.tokenAddress,
    direction: input.watch.direction,
    requestedCashAtomic: input.watch.requestedCashAtomic,
    destination: input.watch.destination,
    routePolicyKey: input.snapshot.routePolicyKey,
    approvedSources: [...input.snapshot.approvedSources].sort(),
    status: input.snapshot.marketStatus,
    source: input.snapshot.source,
    observedAt: input.snapshot.marketObservedAt,
    // Only USDC is the reviewed cash numeraire. An ETH output remains a
    // reachable route outcome but cannot be compared directly with the USD
    // cash-size anchor as exit cost.
    returnedCashAtomic:
      input.watch.direction === 'sell' && input.watch.destination === 'USDC' && quote
        ? quote.outputAtomic
        : null,
    effectivePriceAtomic: input.snapshot.effectivePriceAtomic,
    effectivePriceDecimals: input.snapshot.effectivePriceDecimals,
    reference: {
      status: input.snapshot.reference.status,
      marketSession: input.snapshot.reference.marketSession,
      publicationMode: input.snapshot.reference.publicationMode,
      freshness: input.snapshot.reference.freshness,
      reasonCode: input.snapshot.reference.reasonCode,
    },
    ratio: input.snapshot.ratio
      ? {
          ratioKind: input.snapshot.ratio.ratioKind,
          application: input.snapshot.ratio.application,
          rawValue: input.snapshot.ratio.rawValue,
          scale: input.snapshot.ratio.scale,
          evidenceHash: input.snapshot.ratio.evidenceHash,
        }
      : null,
  });
}

export type MarketRealityRadarPointResultV1 =
  | { outcome: 'comparable'; point: MarketRealityRadarPointV1 }
  | { outcome: 'measurement_failed' | 'unsized' | 'policy_changed'; point: null };

/** Select one asset-level point from the complete reviewed router matrix. */
export function marketRealityRadarPointFromRunV1(
  run: CashExitMeasurementRunV1,
  watch: MarketRealityComparabilityKeyV1,
): MarketRealityRadarPointResultV1 {
  const rows = run.observations.filter(
    (row) =>
      row.requestedCashAtomic === watch.requestedCashAtomic &&
      row.destination === watch.destination,
  );
  if (rows.length === 0) return { outcome: 'measurement_failed', point: null };

  const matrix = rows.map((row) => ({
    row,
    snapshot: marketRealitySnapshotForObservationV1(run, row.observationHash, watch.direction),
  }));
  if (matrix.some((item) => item.snapshot === null)) {
    return { outcome: 'measurement_failed', point: null };
  }
  const withSnapshots = matrix as Array<{
    row: CashExitSourceObservationV1;
    snapshot: MarketRealityEvidenceSnapshotV1;
  }>;
  const policyMatches = withSnapshots.every(
    (item) =>
      item.snapshot.routePolicyKey === watch.routePolicyKey &&
      sourceSetKeyV1(item.snapshot.approvedSources) === sourceSetKeyV1(watch.approvedSources),
  );
  if (!policyMatches) return { outcome: 'policy_changed', point: null };

  const quoted = withSnapshots.filter((item) => item.snapshot.marketStatus === 'quoted');
  if (quoted.length > 0) {
    const chosen = quoted.sort((left, right) => {
      const l = BigInt(quoteForDirectionV1(left.row, watch.direction)!.outputAtomic);
      const r = BigInt(quoteForDirectionV1(right.row, watch.direction)!.outputAtomic);
      return l === r ? left.row.source.localeCompare(right.row.source) : l > r ? -1 : 1;
    })[0]!;
    return { outcome: 'comparable', point: compactPointV1({ ...chosen, watch }) };
  }

  const measuredSources = new Set(withSnapshots.map((item) => item.row.source));
  const completeRouterSet =
    measuredSources.size === watch.approvedSources.length &&
    watch.approvedSources.every((source) => measuredSources.has(source));
  if (
    completeRouterSet &&
    withSnapshots.every((item) => item.snapshot.marketStatus === 'no_route')
  ) {
    const chosen = [...withSnapshots].sort((left, right) =>
      left.row.source.localeCompare(right.row.source),
    )[0]!;
    return { outcome: 'comparable', point: compactPointV1({ ...chosen, watch }) };
  }
  if (withSnapshots.some((item) => item.snapshot.marketStatus === 'unsized')) {
    return { outcome: 'unsized', point: null };
  }
  return { outcome: 'measurement_failed', point: null };
}

function roundedDivisionV1(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n;
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

function exitCostBpsV1(requested: string, returned: string): bigint {
  const requestedAtomic = BigInt(requested);
  return roundedDivisionV1((requestedAtomic - BigInt(returned)) * 10_000n, requestedAtomic);
}

function eventIdV1(input: {
  watchId: string;
  kind: MarketRealityRadarEventV1['kind'];
  previousSnapshotHash: string;
  snapshotHash: string;
}): `0x${string}` {
  return stableHashV1('market-reality-radar-event/v1', input);
}

/** Two exact successful points in, zero or more factual transitions out. */
export function deriveMarketRealityRadarEventsV1(input: {
  watch: MarketRealityComparabilityKeyV1;
  previous: MarketRealityRadarPointV1;
  next: MarketRealityRadarPointV1;
}): MarketRealityRadarEventV1[] {
  const { watch, previous, next } = input;
  if (
    previous.snapshotHash === next.snapshotHash ||
    Date.parse(next.observedAt) <= Date.parse(previous.observedAt) ||
    previous.tokenAddress !== next.tokenAddress ||
    previous.direction !== next.direction ||
    previous.requestedCashAtomic !== next.requestedCashAtomic ||
    previous.destination !== next.destination ||
    previous.routePolicyKey !== next.routePolicyKey ||
    next.routePolicyKey !== watch.routePolicyKey ||
    sourceSetKeyV1(previous.approvedSources) !== sourceSetKeyV1(next.approvedSources)
  ) {
    return [];
  }

  const base = {
    watchId: watch.watchId,
    chainId: 8453 as const,
    tokenAddress: watch.tokenAddress,
    previousSnapshotHash: previous.snapshotHash,
    snapshotHash: next.snapshotHash,
    previousObservedAt: previous.observedAt,
    occurredAt: next.observedAt,
    approvedSources: [...next.approvedSources].sort(),
  };
  const events: MarketRealityRadarEventV1[] = [];
  const add = (event: Omit<MarketRealityRadarEventV1, 'eventId'>) => {
    events.push(
      MarketRealityRadarEventV1Schema.parse({
        ...event,
        eventId: eventIdV1({
          watchId: watch.watchId,
          kind: event.kind,
          previousSnapshotHash: previous.snapshotHash,
          snapshotHash: next.snapshotHash,
        }),
      }),
    );
  };

  if (previous.status !== next.status) {
    const kind =
      next.status === 'no_route' ? 'route_became_unavailable' : 'route_became_available';
    add({
      ...base,
      kind,
      facts: {
        previousStatus: previous.status,
        status: next.status,
        source: next.status === 'quoted' ? next.source : null,
      },
    });
  } else if (next.status === 'quoted' && previous.source === next.source) {
    if (
      watch.direction === 'sell' &&
      watch.destination === 'USDC' &&
      previous.returnedCashAtomic !== null &&
      next.returnedCashAtomic !== null
    ) {
      const previousCost = exitCostBpsV1(watch.requestedCashAtomic, previous.returnedCashAtomic);
      const cost = exitCostBpsV1(watch.requestedCashAtomic, next.returnedCashAtomic);
      if (previousCost !== cost || previous.returnedCashAtomic !== next.returnedCashAtomic) {
        add({
          ...base,
          kind: 'sell_exit_cost_changed',
          facts: {
            source: next.source,
            previousCashBackAtomic: previous.returnedCashAtomic,
            cashBackAtomic: next.returnedCashAtomic,
            cashBackChangeAtomic: (
              BigInt(next.returnedCashAtomic) - BigInt(previous.returnedCashAtomic)
            ).toString(),
            previousExitCostBps: previousCost.toString(),
            exitCostBps: cost.toString(),
            changeBps: (cost - previousCost).toString(),
          },
        });
      }
    }
    if (
      watch.direction === 'buy' &&
      previous.effectivePriceAtomic !== null &&
      next.effectivePriceAtomic !== null &&
      previous.effectivePriceDecimals === next.effectivePriceDecimals &&
      previous.effectivePriceAtomic !== next.effectivePriceAtomic
    ) {
      const before = BigInt(previous.effectivePriceAtomic);
      add({
        ...base,
        kind: 'buy_effective_price_changed',
        facts: {
          source: next.source,
          previousEffectivePriceAtomic: previous.effectivePriceAtomic,
          effectivePriceAtomic: next.effectivePriceAtomic,
          effectivePriceDecimals: next.effectivePriceDecimals!,
          changeBps: roundedDivisionV1(
            (BigInt(next.effectivePriceAtomic) - before) * 10_000n,
            before,
          ).toString(),
        },
      });
    }
  }

  const previousSession = previous.reference.marketSession;
  const nextSession = next.reference.marketSession;
  const previousMode = previous.reference.publicationMode;
  const nextMode = next.reference.publicationMode;
  if (
    previousSession !== 'unknown' &&
    nextSession !== 'unknown' &&
    previousMode !== 'unknown' &&
    nextMode !== 'unknown' &&
    (previousSession !== nextSession || previousMode !== nextMode)
  ) {
    add({
      ...base,
      kind: 'market_session_changed',
      facts: {
        previousMarketSession: previousSession,
        marketSession: nextSession,
        previousPublicationMode: previousMode,
        publicationMode: nextMode,
      },
    });
  }
  if (
    previous.reference.freshness === 'fresh' &&
    next.reference.freshness === 'stale' &&
    next.reference.reasonCode === 'reviewed_reference_stale'
  ) {
    add({
      ...base,
      kind: 'reference_became_stale',
      facts: {
        previousFreshness: 'fresh',
        freshness: 'stale',
        reasonCode: 'reviewed_reference_stale',
      },
    });
  }
  if (
    previous.ratio &&
    next.ratio &&
    previous.ratio.ratioKind === next.ratio.ratioKind &&
    previous.ratio.application === next.ratio.application &&
    (previous.ratio.rawValue !== next.ratio.rawValue || previous.ratio.scale !== next.ratio.scale)
  ) {
    add({
      ...base,
      kind: 'representation_ratio_changed',
      facts: {
        ratioKind: next.ratio.ratioKind,
        application: next.ratio.application,
        previousRawValue: previous.ratio.rawValue,
        previousScale: previous.ratio.scale,
        rawValue: next.ratio.rawValue,
        scale: next.ratio.scale,
      },
    });
  }
  return events;
}

export async function evaluateMarketRealityRadarRunV1(input: {
  repository: MarketRealityRadarRepositoryV1;
  run: CashExitMeasurementRunV1;
  evaluatedAt: string;
}): Promise<{ evaluated: number; events: number; gaps: number }> {
  const watches = await input.repository.watchesForToken({
    chainId: 8453,
    tokenAddress: input.run.tokenAddress,
  });
  let events = 0;
  let gaps = 0;
  for (const watch of watches) {
    const selected = marketRealityRadarPointFromRunV1(input.run, watch);
    if (selected.outcome !== 'comparable') {
      gaps += 1;
      await input.repository.recordEvaluation({
        watch,
        at: input.evaluatedAt,
        outcome: selected.outcome,
        point: null,
        events: [],
      });
      continue;
    }
    // A run already on file when the user clicked Watch is history, not a new
    // observation by this watch. The scheduled worker produces later runs.
    if (Date.parse(selected.point.observedAt) <= Date.parse(watch.createdAt)) continue;
    const previous = await input.repository.pointForWatch({ watchId: watch.watchId });
    const transitions = previous
      ? deriveMarketRealityRadarEventsV1({ watch, previous, next: selected.point })
      : [];
    const stored = await input.repository.recordEvaluation({
      watch,
      at: input.evaluatedAt,
      outcome: previous ? 'compared' : 'baseline',
      point: selected.point,
      events: transitions,
    });
    events += stored.recorded.length;
  }
  return { evaluated: watches.length, events, gaps };
}
