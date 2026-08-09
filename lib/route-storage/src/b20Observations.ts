import { z } from 'zod';
import { stableHashV1 } from '@mioagent/route-domain';
import { B20_CHAIN_ID_V1 } from '@mioagent/b20-control';
import {
  B20_OBSERVATION_REJECTION_REASONS_V1,
  B20_OBSERVATION_STATES_V1,
  B20_OBSERVATION_UNMEASURED_REASONS_V1,
  B20_QUOTE_ALIGNMENT_V1,
  B20_TRANSFER_POLICY_STATES_V1,
  B20_MEASUREMENT_QUOTE_ASSETS_V1,
} from '@mioagent/opportunity-rail';

import { RouteStorageConflictError, RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// T69-B §1/§11/§13 — an observation as a stored entity.
//
// An observation is a MEASUREMENT AT A NAMED BLOCK AND TIME. It is never
// updated: when the pool moves or a control changes, that is a new observation
// and the old one stays exactly as written. The trigger in migration 0029
// enforces that, because "we corrected it later" destroys the only record of
// what was true when somebody looked.
//
// There is no `qualified` state anywhere in this file. This worker has no
// wallet, so it cannot observe a sequential entry-and-exit execution — and
// `qualified` is the one word in this product that claims one happened.
// ---------------------------------------------------------------------------

/** Bump when the meaning of a measurement changes. Stored on every row, so an
 * old observation is never silently compared against a new definition. */
export const B20_MEASUREMENT_VERSION_V1 = 'b20-observation/v1';

const HexHash = z.string().regex(/^0x[0-9a-f]{64}$/);
const HexAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const Uint = z.string().regex(/^\d+$/);
const Timestamp = z.string().datetime();

/** Every reason a non-candidate state may carry. */
export const B20_OBSERVATION_REASON_CODES_V1 = [
  ...B20_OBSERVATION_REJECTION_REASONS_V1,
  ...B20_OBSERVATION_UNMEASURED_REASONS_V1,
  'quoted_pre_entry',
] as const;

export const B20OpportunityObservationV1Schema = z
  .object({
    id: z.string().min(1),
    launchId: z.string().min(1),
    chainId: z.literal(B20_CHAIN_ID_V1),
    tokenAddress: HexAddress,

    /** The feed's measurement parameters. NOT a user qualification.
     *
     * Widened past USDC because the venue decides the pair, not the profile:
     * every B20 v4 pool sampled is quoted against native ETH, and the previous
     * literal forced those measurements to be STORED as USDC while a USDC-
     * denominated size was spent as wei — a dust trade recorded as a hundred
     * dollars. The set stays closed to the two assets B20 pools actually use;
     * an arbitrary address here would let any pair masquerade as a comparable
     * measurement.
     *
     * Execution is NOT widened. `OPPORTUNITY_QUOTE_ASSET_V1` still pins
     * clearances, entry plans and approvals to USDC, so an ETH-measured
     * observation can be shown and can never become an entry plan. */
    referenceQuoteAsset: z.enum(B20_MEASUREMENT_QUOTE_ASSETS_V1),
    referencePositionAtomic: Uint,
    maxRoundTripBps: z.number().int().min(1).max(10_000),
    maxExitSlippageBps: z.number().int().min(1).max(10_000),
    profileIdentity: z.string().min(1),

    state: z.enum(B20_OBSERVATION_STATES_V1),
    reasonCode: z.enum(B20_OBSERVATION_REASON_CODES_V1).nullable(),

    factoryConfirmed: z.boolean(),
    initialized: z.boolean(),
    entryRouteFound: z.boolean(),
    exitRouteFound: z.boolean(),
    entryRouteHash: HexHash.nullable(),
    exitRouteHash: HexHash.nullable(),
    entrySourceKey: z.string().min(1).max(200).nullable(),
    exitSourceKey: z.string().min(1).max(200).nullable(),

    /** Null when it could not be measured — never zero. "No quote" and "free"
     * are different answers. */
    entryOutputAtomic: Uint.nullable(),
    optimisticExitReturnAtomic: Uint.nullable(),
    optimisticRoundTripBps: z.number().int().min(0).nullable(),

    largestPassingSizeAtomic: Uint.nullable(),
    firstFailingSizeAtomic: Uint.nullable(),
    capacityProbeCount: z.number().int().min(0),
    capacityToleranceBps: z.number().int().min(0),
    /** False when a size passed ABOVE one that failed. */
    capacityStable: z.boolean().nullable(),
    capacitySamplesHash: HexHash.nullable(),

    routeCoverage: z.enum(['complete', 'partial']),
    viableRouteConfirmed: z.boolean(),
    bestRouteConfirmed: z.boolean(),

    controlsSnapshotHash: HexHash.nullable(),
    controlsBlockNumber: Uint.nullable(),
    transfersPaused: z.boolean().nullable(),
    transferPolicyState: z.enum(B20_TRANSFER_POLICY_STATES_V1).nullable(),
    controlsComplete: z.boolean().nullable(),

    observationBlockNumber: Uint,
    observationBlockHash: HexHash,
    quoteAlignment: z.enum(B20_QUOTE_ALIGNMENT_V1),

    measuredAt: Timestamp,
    staleAfter: Timestamp,
    measurementVersion: z.string().regex(/^[a-z0-9./-]{1,64}$/),
    evidenceHash: HexHash,
    createdAt: Timestamp,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };
    if (observation.state === 'candidate' && observation.reasonCode !== null) {
      fail('a candidate has nothing to explain yet');
    }
    if ((observation.state === 'rejected' || observation.state === 'unmeasured') && !observation.reasonCode) {
      // "Rejected" with no reason is an accusation with no evidence, published
      // about somebody's token, unattended.
      fail(`a ${observation.state} observation must name why`);
    }
    if (observation.state === 'provisional' && observation.reasonCode !== 'quoted_pre_entry') {
      // A pass is ALWAYS optimistic here: the exit was quoted before the entry
      // moved the pool. Losing that label would turn a bound into a result.
      fail('a provisional observation is always a pre-entry measurement');
    }
    if (observation.state === 'rejected' && observation.reasonCode) {
      const rejections = B20_OBSERVATION_REJECTION_REASONS_V1 as readonly string[];
      if (!rejections.includes(observation.reasonCode)) fail('a rejection must carry a rejection reason');
    }
    if (observation.state === 'unmeasured' && observation.reasonCode) {
      const unmeasured = B20_OBSERVATION_UNMEASURED_REASONS_V1 as readonly string[];
      if (!unmeasured.includes(observation.reasonCode)) fail('an unmeasured observation must carry an unmeasured reason');
    }
    if (observation.state === 'provisional') {
      if (!observation.entryRouteFound || !observation.exitRouteFound || !observation.factoryConfirmed) {
        fail('a pass presupposes a confirmed token and both legs');
      }
      if (observation.optimisticRoundTripBps === null || observation.largestPassingSizeAtomic === null) {
        fail('a pass must carry the measurements it passed on');
      }
      if (observation.controlsComplete !== true || observation.transfersPaused !== false) {
        fail('a pass requires complete controls and unpaused transfers');
      }
      if (
        observation.optimisticRoundTripBps !== null &&
        observation.optimisticRoundTripBps > observation.maxRoundTripBps
      ) {
        fail('a cost that passed cannot exceed the tolerance it was measured against');
      }
    }
    if (observation.bestRouteConfirmed && (!observation.viableRouteConfirmed || observation.routeCoverage !== 'complete')) {
      fail('a best-route claim needs a proven route and complete coverage');
    }
    if (Date.parse(observation.staleAfter) <= Date.parse(observation.measuredAt)) {
      fail('an observation must go stale after it was measured');
    }
    if (observation.id !== observationIdV1(observation)) {
      fail('the observation id must be derived from its own identity');
    }
    if (observation.evidenceHash !== observationEvidenceHashV1(observation)) {
      fail('the evidence hash must cover this observation’s own measurements');
    }
  });

export type B20OpportunityObservationV1 = z.infer<typeof B20OpportunityObservationV1Schema>;

export interface B20ObservationIdentityV1 {
  launchId: string;
  observationBlockNumber: string;
  measurementVersion: string;
  profileIdentity: string;
}

/**
 * §13 — the identity of one observation.
 *
 * Launch, block, measurement version and profile. A retry that measured the
 * same token at the same block under the same rules computes the same id and
 * finds the row that is already there.
 */
export function observationIdV1(identity: B20ObservationIdentityV1): string {
  return stableHashV1('b20-observation-identity/v1', {
    launchId: identity.launchId,
    observationBlockNumber: identity.observationBlockNumber,
    measurementVersion: identity.measurementVersion,
    profileIdentity: identity.profileIdentity,
  });
}

/**
 * A hash over what was MEASURED — deliberately not over when.
 *
 * `measuredAt`, `staleAfter`, `createdAt` and the id are excluded: a retry
 * measuring identical facts a second later must hash identically, or
 * idempotency would depend on the wall clock. Two rows whose evidence hashes
 * differ under one identity is a genuine integrity conflict.
 */
export function observationEvidenceHashV1(
  observation: Omit<B20OpportunityObservationV1, 'evidenceHash' | 'id' | 'createdAt'> & Record<string, unknown>,
): string {
  return stableHashV1('b20-observation-evidence/v1', {
    launchId: observation.launchId,
    chainId: observation.chainId,
    tokenAddress: observation.tokenAddress,
    profileIdentity: observation.profileIdentity,
    state: observation.state,
    reasonCode: observation.reasonCode,
    factoryConfirmed: observation.factoryConfirmed,
    initialized: observation.initialized,
    entryRouteFound: observation.entryRouteFound,
    exitRouteFound: observation.exitRouteFound,
    entryRouteHash: observation.entryRouteHash,
    exitRouteHash: observation.exitRouteHash,
    entrySourceKey: observation.entrySourceKey,
    exitSourceKey: observation.exitSourceKey,
    entryOutputAtomic: observation.entryOutputAtomic,
    optimisticExitReturnAtomic: observation.optimisticExitReturnAtomic,
    optimisticRoundTripBps: observation.optimisticRoundTripBps,
    largestPassingSizeAtomic: observation.largestPassingSizeAtomic,
    firstFailingSizeAtomic: observation.firstFailingSizeAtomic,
    capacityProbeCount: observation.capacityProbeCount,
    capacityToleranceBps: observation.capacityToleranceBps,
    capacityStable: observation.capacityStable,
    capacitySamplesHash: observation.capacitySamplesHash,
    routeCoverage: observation.routeCoverage,
    viableRouteConfirmed: observation.viableRouteConfirmed,
    bestRouteConfirmed: observation.bestRouteConfirmed,
    controlsSnapshotHash: observation.controlsSnapshotHash,
    controlsBlockNumber: observation.controlsBlockNumber,
    transfersPaused: observation.transfersPaused,
    transferPolicyState: observation.transferPolicyState,
    controlsComplete: observation.controlsComplete,
    observationBlockNumber: observation.observationBlockNumber,
    observationBlockHash: observation.observationBlockHash,
    quoteAlignment: observation.quoteAlignment,
    measurementVersion: observation.measurementVersion,
  });
}

/** A deterministic hash over the ladder, so the probes are checkable without a
 * row per sample. */
export function capacitySamplesHashV1(
  samples: readonly { sizeAtomic: string; slippageBps: number | null }[],
): string {
  return stableHashV1('b20-capacity-samples/v1', {
    samples: [...samples]
      .sort((left, right) => (BigInt(left.sizeAtomic) < BigInt(right.sizeAtomic) ? -1 : 1))
      .map((sample) => ({ sizeAtomic: sample.sizeAtomic, slippageBps: sample.slippageBps })),
  });
}

export function assertObservationV1(
  value: unknown,
  direction: 'read' | 'write' = 'read',
): B20OpportunityObservationV1 {
  const parsed = B20OpportunityObservationV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new RouteStorageIntegrityError(`B20 opportunity observation failed validation on ${direction}: ${detail}`);
}

export function observationConflictV1(message: string): RouteStorageConflictError {
  return new RouteStorageConflictError(message);
}

/** A launch the measurement worker may look at, with just enough of its own
 * record to re-check that the chain still agrees (§12). */
export interface B20MeasurableLaunchV1 {
  launchId: string;
  tokenAddress: string;
  blockNumber: string;
  blockHash: string;
  detectedAt: string;
  /** When this launch was last observed at all, so a caller can honour the
   * minimum re-measurement interval. Null when never. */
  lastMeasuredAt: string | null;
}

export interface B20ObservationInsertResultV1 {
  observation: B20OpportunityObservationV1;
  /** False when an identical observation already existed. A retry is free. */
  inserted: boolean;
}

/**
 * §2 — one canonical launch with its LATEST observation, if it has one.
 *
 * The join is done in the database, once, for the whole page. A feed that read
 * observations per launch would be N+1 queries against a list that grows with
 * every launch on Base.
 */
export interface B20FeedRowV1 {
  launch: {
    id: string;
    tokenAddress: string;
    name: string;
    symbol: string;
    variant: 'asset' | 'stablecoin';
    decimals: number | null;
    blockNumber: string;
    transactionHash: string;
    logIndex: number;
    detectedAt: string;
    /** T69-C.1 §1 — the block's own timestamp. Null for rows written before
     * migration 0030 and for endpoints that do not report one. */
    blockTimestamp: string | null;
    canonical: boolean;
  };
  /** Null when this launch has never been measured. A real state, and not the
   * same as a measurement that found nothing. */
  observation: B20OpportunityObservationV1 | null;
}

/**
 * T73 §3 — one launch, its latest observation, and the one closest to a target
 * age before it.
 *
 * A separate shape from the feed row because a mover needs TWO observations and
 * the feed deliberately returns one. Both are read in a single query: a
 * baseline fetched per launch would be N+1 against a list that grows with every
 * B20 launch, which is the reason `listFeed` is shaped the way it is.
 */
export interface B20MoverPairRowV1 {
  launch: {
    id: string;
    tokenAddress: string;
    name: string;
    symbol: string;
    variant: 'asset' | 'stablecoin';
    decimals: number | null;
    blockNumber: string;
    canonical: boolean;
  };
  latest: B20OpportunityObservationV1;
  /** Null when nothing compatible sits near the target age. A real answer:
   * Miorail has not been measuring this token long enough. */
  baseline: B20OpportunityObservationV1 | null;
}

export interface B20FeedPageV1 {
  rows: B20FeedRowV1[];
  /** Opaque. Encodes the deterministic ordering key of the last row, so a page
   * boundary cannot shift when newer launches arrive above it. */
  nextCursor: string | null;
}

/** §1 — the counts the pipeline status is computed from. */
export interface B20PipelineCountsV1 {
  canonicalLaunchCount: number;
  launchesAwaitingMeasurement: number;
  observationCount: number;
  ingestionCursorBlock: string | null;
  ingestionOperatorState: string | null;
  lastIngestionRunAt: string | null;
  lastIngestionResult: string | null;
  lastIngestionConfirmedHead: string | null;
  lastIngestionBudgetExhausted: boolean;
  lastMeasurementRunAt: string | null;
  /**
   * T73-LIVE §8 — observations written by the most recent measurement burst.
   *
   * Derived rather than recorded: an observation carries no run id, so this
   * counts rows whose `measured_at` falls inside `B20_MEASURE_RUN_WINDOW_MS_V1`
   * of the newest one. A pass is bounded by its own runtime limit and writes
   * its rows seconds apart, so that window is one pass in practice — but it is
   * a window, not a run, and calling it an exact count would be a small lie in
   * a field an operator uses to decide whether the worker is alive.
   */
  observationsLastRun: number;
}

/** How close together two observations must be to count as one measurement
 * burst. Comfortably wider than a pass's own runtime ceiling. */
export const B20_MEASURE_RUN_WINDOW_MS_V1 = 10 * 60 * 1000;

export interface B20MeasureLeaseV1 {
  id: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastRunId: string | null;
  updatedAt: string;
}

/** The one measurement lane this build runs. */
export const B20_MEASURE_LANE_V1 = 'b20-opportunity-measure/v1';

/**
 * §3 — the opaque page cursor.
 *
 * It encodes the full ordering key, not an offset. A feed that grows at the top
 * would make offset pagination repeat or skip rows as launches arrive; a
 * key-based cursor asks for "everything strictly after this exact row" and is
 * therefore stable whatever appears above it.
 *
 * Opaque on purpose: it is a position in an ordering this build defines, not a
 * public identifier, and a client that parsed it would be depending on an
 * ordering that is free to change.
 */
export function encodeFeedCursorV1(input: {
  launchBlockNumber: string;
  measuredAt: string | null;
  launchId: string;
}): string {
  const payload = [input.launchBlockNumber, input.measuredAt ?? '', input.launchId].join(' ');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeFeedCursorV1(
  cursor: string,
): { launchBlockNumber: string; measuredAt: string | null; launchId: string } | null {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(' ');
    if (parts.length !== 3) return null;
    const [launchBlockNumber, measuredAt, launchId] = parts as [string, string, string];
    if (!/^\d+$/.test(launchBlockNumber) || launchId.length === 0) return null;
    if (measuredAt !== '' && Number.isNaN(Date.parse(measuredAt))) return null;
    return { launchBlockNumber, measuredAt: measuredAt === '' ? null : measuredAt, launchId };
  } catch {
    // A malformed cursor is refused rather than treated as "start from the
    // top": silently restarting a paginated feed looks like duplicated results.
    return null;
  }
}

/**
 * §9 — the contract both repositories implement.
 *
 * The in-memory one is NOT allowed to be kinder than Postgres, for the same
 * reason as every other pair in this package: three production bugs came from a
 * fake that accepted what the database refuses.
 */
export interface B20ObservationRepositoryV1 {
  /**
   * Canonical launches worth measuring, oldest first.
   *
   * NON-CANONICAL LAUNCHES ARE NEVER RETURNED. A launch the chain took back is
   * not a token anybody should be shown a measurement of.
   */
  selectMeasurableLaunches(input: {
    limit: number;
    /** Launches older than this are past the active-measurement window. */
    maxLaunchAgeMs: number;
    /** A launch observed more recently than this is left alone. */
    minReMeasureIntervalMs: number;
    now: string;
  }): Promise<B20MeasurableLaunchV1[]>;

  /**
   * Idempotent on identity. Identical evidence returns the stored row;
   * DIFFERENT evidence under the same identity is a conflict, never a silent
   * overwrite — two disagreeing measurements of one block are two facts and
   * neither wins by arriving second.
   */
  insertObservation(observation: B20OpportunityObservationV1): Promise<B20ObservationInsertResultV1>;

  getObservation(id: string): Promise<B20OpportunityObservationV1 | null>;

  /** Newest first. Historical rows are kept even when their launch was later
   * reorged out — the evidence of what was measured survives. */
  listObservationsForLaunch(input: { launchId: string; limit: number }): Promise<B20OpportunityObservationV1[]>;

  listRecentObservations(input: { limit: number }): Promise<B20OpportunityObservationV1[]>;

  acquireMeasureLease(input: { owner: string; now: string; ttlMs: number }): Promise<B20MeasureLeaseV1 | null>;
  releaseMeasureLease(input: { owner: string; now: string }): Promise<void>;

  /**
   * §2/§3 — one page of the feed, newest launch first.
   *
   * ONLY CANONICAL LAUNCHES. A launch the chain took back is not something a
   * user should be offered, whatever was measured about it before.
   *
   * Ordering is (launch block DESC, measuredAt DESC, launch id DESC) — the last
   * key is a stable tie-break so a page boundary is a total order rather than
   * "whatever the planner returned". `cursor` is that key, opaque to the
   * client: offset pagination over a feed that grows at the top would silently
   * repeat or skip rows as launches arrive.
   */
  listFeed(input: {
    limit: number;
    cursor?: string | null;
    states?: readonly B20OpportunityObservationV1['state'][];
    /** Only launches detected within this window. */
    maxLaunchAgeMs?: number | null;
    now: string;
    /** Supported measurement versions. An observation written by a version this
     * build does not understand is not shown as a current measurement. */
    measurementVersions?: readonly string[];
  }): Promise<B20FeedPageV1>;

  /** §4 — one launch, its latest observation and a bounded history. Null when
   * no canonical launch exists for the address. */
  getFeedRowForToken(input: {
    tokenAddress: string;
    historyLimit: number;
    measurementVersions?: readonly string[];
  }): Promise<{ row: B20FeedRowV1; history: B20OpportunityObservationV1[] } | null>;

  /** §1 — the counts behind the pipeline status, in one round trip. */
  /**
   * §3 — latest and ~24h-old observation pairs, for the movers rail.
   *
   * Only canonical launches, only the requested measurement version, and the
   * baseline is chosen as the observation NEAREST the target age rather than
   * the newest one older than it: "closest to 24 hours" is the comparison the
   * label promises, and picking the newest older row silently shortens the
   * interval whenever measurement is dense.
   */
  listMoverPairs(input: {
    limit: number;
    now: string;
    /** How far back the baseline should sit. */
    baselineAgeMs: number;
    /** How far from that a baseline may be and still be used. */
    baselineToleranceMs: number;
    maxLaunchAgeMs: number;
    measurementVersions?: readonly string[];
  }): Promise<B20MoverPairRowV1[]>;

  pipelineCounts(input: { now: string; maxLaunchAgeMs: number }): Promise<B20PipelineCountsV1>;
}
