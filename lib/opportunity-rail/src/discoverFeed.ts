import {
  B20_OBSERVATION_REJECTION_COPY_V1,
  B20_OBSERVATION_STATE_COPY_V1,
  B20_OBSERVATION_UNMEASURED_COPY_V1,
  B20_PRE_ENTRY_NOTICE_V1,
  B20_TRANSFER_POLICY_COPY_V1,
  type B20ObservationStateV1,
  type B20QuoteAlignmentV1,
  type B20TransferPolicyStateV1,
} from './observation.js';

// ---------------------------------------------------------------------------
// T69-C §1/§5/§6/§18 — what the Discover feed is allowed to show, and what an
// EMPTY feed is allowed to mean.
//
// The second half is the harder one. An empty array has at least seven causes:
// nothing launched, ingestion never started, no start block was configured, the
// cursor is still catching up, launches exist but nothing measured them yet,
// the endpoint is degraded, or everything measured was filtered out. Rendering
// all seven as "No opportunities" tells a user the chain is quiet when in fact
// the product is not running — and they have no way to tell the difference.
//
// So the feed carries a typed PIPELINE STATUS beside its items, and the status
// is computed from counts the server actually has rather than inferred from the
// length of an array.
// ---------------------------------------------------------------------------

export const B20_PIPELINE_STATES_V1 = [
  /** No start block configured. Ingestion cannot begin. */
  'configuration_required',
  /** Configured, but no ingestion run has ever succeeded. */
  'ingestion_not_started',
  /** The cursor is behind the confirmed head by more than one pass. */
  'ingestion_catching_up',
  /** Launches are stored and waiting for Exit-First measurement. */
  'measurement_pending',
  /** Both workers are current. */
  'healthy',
  /** A worker's last run failed, or measurements are coming back degraded. */
  'degraded',
  /** The event shape changed. The launch feed is stopped until somebody looks. */
  'decoder_mismatch',
  'storage_unavailable',
] as const;

export type B20PipelineStateV1 = (typeof B20_PIPELINE_STATES_V1)[number];

/** Public-safe facts about the pipeline. No URL, no credential, no raw worker
 * error — every field here is a number, a block or a named category. */
export interface B20PipelineFactsV1 {
  ingestionCursorBlock: string | null;
  confirmedHead: string | null;
  lastIngestionRunAt: string | null;
  lastIngestionResult: string | null;
  lastMeasurementRunAt: string | null;
  canonicalLaunchCount: number;
  launchesAwaitingMeasurement: number;
  observationCount: number;
  budgetExhausted: boolean;
  /** A CATEGORY, never a message. */
  operatorState: string | null;
}

export interface B20PipelineStatusV1 {
  state: B20PipelineStateV1;
  facts: B20PipelineFactsV1;
  /** How far the cursor is from the confirmed head, when both are known. */
  blocksBehind: number | null;
}

/** More than this behind the confirmed head is "catching up" rather than
 * "current". One default pass is 800 blocks, so a few passes of lag is normal
 * and anything beyond it is worth saying out loud. */
export const B20_CATCHING_UP_BLOCKS_V1 = 2_400;

/**
 * §1 — what an empty feed means.
 *
 * Ordered by what an operator would have to fix first: configuration before
 * ingestion, ingestion before measurement, and a stopped decoder before any of
 * it — because none of the later states are meaningful while an earlier one is
 * broken.
 */
export function b20PipelineStatusV1(input: B20PipelineFactsV1 & { storageAvailable: boolean }): B20PipelineStatusV1 {
  const facts: B20PipelineFactsV1 = {
    ingestionCursorBlock: input.ingestionCursorBlock,
    confirmedHead: input.confirmedHead,
    lastIngestionRunAt: input.lastIngestionRunAt,
    lastIngestionResult: input.lastIngestionResult,
    lastMeasurementRunAt: input.lastMeasurementRunAt,
    canonicalLaunchCount: input.canonicalLaunchCount,
    launchesAwaitingMeasurement: input.launchesAwaitingMeasurement,
    observationCount: input.observationCount,
    budgetExhausted: input.budgetExhausted,
    operatorState: input.operatorState,
  };
  const blocksBehind =
    facts.ingestionCursorBlock !== null && facts.confirmedHead !== null
      ? Math.max(0, Number(BigInt(facts.confirmedHead) - BigInt(facts.ingestionCursorBlock)))
      : null;

  const status = (state: B20PipelineStateV1): B20PipelineStatusV1 => ({ state, facts, blocksBehind });

  if (!input.storageAvailable) return status('storage_unavailable');
  // A stopped decoder outranks everything: no later state is meaningful while
  // the launch feed is refusing to read.
  if (facts.operatorState === 'decoder_mismatch') return status('decoder_mismatch');
  if (facts.ingestionCursorBlock === null) {
    // No cursor at all. Either nobody configured a start block, or the worker
    // has never run — and those are different things to go and do.
    return facts.lastIngestionResult === 'configuration_required'
      ? status('configuration_required')
      : status('ingestion_not_started');
  }
  if (facts.operatorState !== null) return status('degraded');
  if (blocksBehind !== null && blocksBehind > B20_CATCHING_UP_BLOCKS_V1) {
    return status('ingestion_catching_up');
  }
  if (facts.launchesAwaitingMeasurement > 0) return status('measurement_pending');
  return status('healthy');
}

/**
 * §18 — the sentence a surface shows instead of "No opportunities".
 *
 * Every one of these names what is happening and, where there is one, what to
 * do about it. None of them implies the chain is quiet.
 */
export function b20PipelineCopyV1(status: B20PipelineStatusV1): string {
  const { facts } = status;
  switch (status.state) {
    case 'configuration_required':
      return 'Discover needs an explicit historical start block before it can read launches.';
    case 'ingestion_not_started':
      return 'Discover has not read any launch history yet.';
    case 'ingestion_catching_up':
      return facts.ingestionCursorBlock && facts.confirmedHead
        ? `Miorail is reading B20 launch history: block ${formatBlockV1(facts.ingestionCursorBlock)} of ${formatBlockV1(facts.confirmedHead)}. Opportunities will appear as launches are measured.`
        : 'Miorail is reading B20 launch history. Opportunities will appear as launches are measured.';
    case 'measurement_pending':
      return `${facts.launchesAwaitingMeasurement} launch${facts.launchesAwaitingMeasurement === 1 ? ' has' : 'es have'} been found and ${facts.launchesAwaitingMeasurement === 1 ? 'is' : 'are'} waiting for Exit-First measurement.`;
    case 'degraded':
      return 'Some market measurements could not be completed. Missing data is not treated as a token failure.';
    case 'decoder_mismatch':
      return 'The B20 launch event no longer matches what Miorail can read, so ingestion has stopped rather than record guesses.';
    case 'storage_unavailable':
      return 'Discover storage is unavailable, so no measurement can be shown.';
    case 'healthy':
      return 'No measured B20 opportunities are available in the selected filters.';
  }
}

function formatBlockV1(value: string): string {
  return Number(value).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// §5 — the public card projection.
// ---------------------------------------------------------------------------

export type B20FreshnessV1 = 'fresh' | 'stale';

/** Display-safe launch evidence. */
export interface B20CardLaunchV1 {
  tokenAddress: string;
  name: string;
  symbol: string;
  variant: 'asset' | 'stablecoin';
  decimals: number | null;
  blockNumber: string;
  transactionHash: string;
  logIndex: number;
  detectedAt: string;
  /** Seconds since the launch was detected, so a surface need not carry a clock
   * convention of its own. */
  ageSeconds: number;
  canonical: boolean;
}

/** Display-safe measurement. Every numeric field is nullable and NEVER
 * defaulted to zero — "not measured" and "zero" are different answers, and a
 * card showing 0.00% cost for an unmeasured token is a lie with a decimal
 * point in it. */
export interface B20CardObservationV1 {
  state: B20ObservationStateV1;
  reasonCode: string | null;
  headline: string;
  detail: string;
  referencePositionAtomic: string;
  referenceQuoteAsset: string;
  maxRoundTripBps: number;
  maxExitSlippageBps: number;
  entryRouteFound: boolean;
  exitRouteFound: boolean;
  entrySourceKey: string | null;
  exitSourceKey: string | null;
  optimisticReturnAtomic: string | null;
  optimisticRoundTripBps: number | null;
  routeCoverage: 'complete' | 'partial';
  viableRouteConfirmed: boolean;
  bestRouteConfirmed: boolean;
  largestPassingSizeAtomic: string | null;
  firstFailingSizeAtomic: string | null;
  capacityToleranceBps: number;
  capacityProbeCount: number;
  capacityStable: boolean | null;
  transfersPaused: boolean | null;
  transferPolicyState: B20TransferPolicyStateV1 | null;
  /** The wallet-check warning, present exactly when a policy is active. */
  transferPolicyNotice: string | null;
  controlsComplete: boolean | null;
  controlsBlockNumber: string | null;
  observationBlockNumber: string;
  quoteAlignment: B20QuoteAlignmentV1;
  /** §7 — shown on the card, never only in a tooltip. */
  quoteAlignmentNotice: string | null;
  /** §6 — present on every provisional card. */
  preEntryNotice: string | null;
  measuredAt: string;
  staleAfter: string;
  freshness: B20FreshnessV1;
}

export interface B20OpportunityCardV1 {
  schemaVersion: 'b20-opportunity-card/v1';
  launch: B20CardLaunchV1;
  /** Null when the launch has never been measured — a real state, and not the
   * same as a measurement that found nothing. */
  observation: B20CardObservationV1 | null;
  /** §13 — a stale observation may never directly enable an entry plan. */
  canCheckProfile: boolean;
  /** §10 — named, so a surface renders the words rather than a zero. */
  notMeasured: readonly string[];
}

/** §10 — dimensions Miorail deliberately does not measure. Listed rather than
 * omitted, because a missing row reads as "nothing to report" and a named one
 * reads as "nobody measured this". */
export const B20_NOT_MEASURED_DIMENSIONS_V1 = [
  'unique buyers',
  'trading volume',
  'holder concentration',
  'related-wallet clusters',
  'organic buy pressure',
  'future price',
  'profit probability',
] as const;

export const B20_NOT_MEASURED_NOTICE_V1 = 'Not measured — no approved indexed source.';

/** §7 — the sentence a card must carry whenever its quotes are not anchored. */
export const B20_QUOTE_ALIGNMENT_NOTICE_V1 =
  'Controls are block-anchored. Market quotes were read at latest.';

export const B20_TRANSFER_POLICY_NOTICE_V1 =
  'A transfer policy is active. Whether your wallet can exit requires a wallet-specific check.';

export const B20_STALE_NOTICE_V1 = 'Market observation expired.';

/** §8 — when the ladder disagreed with itself. */
export const B20_UNSTABLE_CAPACITY_NOTICE_V1 = 'Capacity was not monotonic across tested sizes.';

export interface B20CardInputV1 {
  launch: {
    tokenAddress: string;
    name: string;
    symbol: string;
    variant: 'asset' | 'stablecoin';
    decimals: number | null;
    blockNumber: string;
    transactionHash: string;
    logIndex: number;
    detectedAt: string;
    canonical: boolean;
  };
  observation: {
    state: B20ObservationStateV1;
    reasonCode: string | null;
    referencePositionAtomic: string;
    referenceQuoteAsset: string;
    maxRoundTripBps: number;
    maxExitSlippageBps: number;
    entryRouteFound: boolean;
    exitRouteFound: boolean;
    entrySourceKey: string | null;
    exitSourceKey: string | null;
    optimisticExitReturnAtomic: string | null;
    optimisticRoundTripBps: number | null;
    routeCoverage: 'complete' | 'partial';
    viableRouteConfirmed: boolean;
    bestRouteConfirmed: boolean;
    largestPassingSizeAtomic: string | null;
    firstFailingSizeAtomic: string | null;
    capacityToleranceBps: number;
    capacityProbeCount: number;
    capacityStable: boolean | null;
    transfersPaused: boolean | null;
    transferPolicyState: B20TransferPolicyStateV1 | null;
    controlsComplete: boolean | null;
    controlsBlockNumber: string | null;
    observationBlockNumber: string;
    quoteAlignment: B20QuoteAlignmentV1;
    measuredAt: string;
    staleAfter: string;
  } | null;
  now: Date;
}

/**
 * One card, from one launch and its latest observation.
 *
 * Pure. Every sentence it produces comes from the shared copy tables, so the
 * API, the web console and any later surface cannot each invent their own
 * wording for a state that decides whether somebody spends money.
 */
export function b20OpportunityCardV1(input: B20CardInputV1): B20OpportunityCardV1 {
  const ageSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - Date.parse(input.launch.detectedAt)) / 1000),
  );
  const launch: B20CardLaunchV1 = { ...input.launch, ageSeconds };

  if (!input.observation) {
    return {
      schemaVersion: 'b20-opportunity-card/v1',
      launch,
      observation: null,
      // Nothing has been measured, so there is nothing to check a profile
      // against yet. The feed says so rather than offering an action that
      // would run on no evidence.
      canCheckProfile: false,
      notMeasured: B20_NOT_MEASURED_DIMENSIONS_V1,
    };
  }

  const source = input.observation;
  const freshness: B20FreshnessV1 = Date.parse(source.staleAfter) > input.now.getTime() ? 'fresh' : 'stale';
  const policyActive = source.transferPolicyState === 'restricted';

  const detail =
    source.state === 'rejected' && source.reasonCode && source.reasonCode in B20_OBSERVATION_REJECTION_COPY_V1
      ? B20_OBSERVATION_REJECTION_COPY_V1[
          source.reasonCode as keyof typeof B20_OBSERVATION_REJECTION_COPY_V1
        ]
      : source.state === 'unmeasured' && source.reasonCode && source.reasonCode in B20_OBSERVATION_UNMEASURED_COPY_V1
        ? B20_OBSERVATION_UNMEASURED_COPY_V1[
            source.reasonCode as keyof typeof B20_OBSERVATION_UNMEASURED_COPY_V1
          ]
        : B20_OBSERVATION_STATE_COPY_V1[source.state];

  return {
    schemaVersion: 'b20-opportunity-card/v1',
    launch,
    observation: {
      state: source.state,
      reasonCode: source.reasonCode,
      headline: B20_OBSERVATION_STATE_COPY_V1[source.state],
      detail,
      referencePositionAtomic: source.referencePositionAtomic,
      referenceQuoteAsset: source.referenceQuoteAsset,
      maxRoundTripBps: source.maxRoundTripBps,
      maxExitSlippageBps: source.maxExitSlippageBps,
      entryRouteFound: source.entryRouteFound,
      exitRouteFound: source.exitRouteFound,
      entrySourceKey: source.entrySourceKey,
      exitSourceKey: source.exitSourceKey,
      optimisticReturnAtomic: source.optimisticExitReturnAtomic,
      optimisticRoundTripBps: source.optimisticRoundTripBps,
      routeCoverage: source.routeCoverage,
      viableRouteConfirmed: source.viableRouteConfirmed,
      bestRouteConfirmed: source.bestRouteConfirmed,
      largestPassingSizeAtomic: source.largestPassingSizeAtomic,
      firstFailingSizeAtomic: source.firstFailingSizeAtomic,
      capacityToleranceBps: source.capacityToleranceBps,
      capacityProbeCount: source.capacityProbeCount,
      capacityStable: source.capacityStable,
      transfersPaused: source.transfersPaused,
      transferPolicyState: source.transferPolicyState,
      // Present exactly when a policy is active — and it is a WARNING, not a
      // rejection: there is no wallet here to resolve it against.
      transferPolicyNotice: policyActive ? B20_TRANSFER_POLICY_NOTICE_V1 : null,
      controlsComplete: source.controlsComplete,
      controlsBlockNumber: source.controlsBlockNumber,
      observationBlockNumber: source.observationBlockNumber,
      quoteAlignment: source.quoteAlignment,
      quoteAlignmentNotice:
        source.quoteAlignment === 'latest_not_anchored' ? B20_QUOTE_ALIGNMENT_NOTICE_V1 : null,
      // On every provisional card, because the number beside it is a bound.
      preEntryNotice: source.state === 'provisional' ? B20_PRE_ENTRY_NOTICE_V1 : null,
      measuredAt: source.measuredAt,
      staleAfter: source.staleAfter,
      freshness,
    },
    // §13/§14 — a STALE observation may not offer the action that leads to an
    // entry plan. The refresh path exists for that, and it re-reads first.
    canCheckProfile: freshness === 'fresh' && input.launch.canonical,
    notMeasured: B20_NOT_MEASURED_DIMENSIONS_V1,
  };
}

/** The transfer-policy sentence for a given state, so a surface never writes
 * its own. */
export function b20TransferPolicyCopyV1(state: B20TransferPolicyStateV1): string {
  return B20_TRANSFER_POLICY_COPY_V1[state];
}
