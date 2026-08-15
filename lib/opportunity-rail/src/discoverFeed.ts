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
import { b20HookAssessmentV1, type B20HookAssessmentV1 } from './poolHook.js';
import { b20ExitStandingV1, type B20ExitStandingV1 } from './exitStanding.js';

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
  /**
   * T73-LIVE §8 — nobody has advanced the cursor recently.
   *
   * Distinct from every other state because it is the one that used to be
   * invisible: a worker that stops leaves the last run rows exactly as they
   * were, so a dead pipeline reported `healthy` and an empty feed read as a
   * quiet chain. Ranked above `ingestion_catching_up`, because a cursor that is
   * behind AND not moving is not catching up.
   */
  'worker_stale',
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
  /** Observations written by the most recent measurement pass. Zero is a real
   * answer — nothing was due — and null means no pass has ever reported. */
  observationsLastRun: number | null;
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
 * How long without a finished ingestion run before the pipeline is stale.
 *
 * The worker's own idle cadence is a minute or two, so fifteen is many missed
 * passes rather than one slow one — long enough that a deploy or a restart does
 * not raise a false alarm, short enough that a dead worker is noticed within
 * one sitting.
 */
export const B20_WORKER_STALE_AFTER_MS_V1 = 15 * 60 * 1000;

/**
 * §1 — what an empty feed means.
 *
 * Ordered by what an operator would have to fix first: configuration before
 * ingestion, ingestion before measurement, and a stopped decoder before any of
 * it — because none of the later states are meaningful while an earlier one is
 * broken.
 */
export function b20PipelineStatusV1(
  input: B20PipelineFactsV1 & {
    storageAvailable: boolean;
    /** ISO. Required, because staleness is the whole point of the check and a
     * defaulted clock is one nobody notices is wrong. */
    now: string;
    staleAfterMs?: number;
  },
): B20PipelineStatusV1 {
  const facts: B20PipelineFactsV1 = {
    ingestionCursorBlock: input.ingestionCursorBlock,
    confirmedHead: input.confirmedHead,
    lastIngestionRunAt: input.lastIngestionRunAt,
    lastIngestionResult: input.lastIngestionResult,
    lastMeasurementRunAt: input.lastMeasurementRunAt,
    canonicalLaunchCount: input.canonicalLaunchCount,
    launchesAwaitingMeasurement: input.launchesAwaitingMeasurement,
    observationCount: input.observationCount,
    observationsLastRun: input.observationsLastRun,
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
  // Before "catching up", deliberately. A cursor that is behind and not moving
  // describes a stopped worker, and calling that progress is the failure this
  // state exists to end.
  if (workerStaleV1(facts.lastIngestionRunAt, input.now, input.staleAfterMs ?? B20_WORKER_STALE_AFTER_MS_V1)) {
    return status('worker_stale');
  }
  if (blocksBehind !== null && blocksBehind > B20_CATCHING_UP_BLOCKS_V1) {
    return status('ingestion_catching_up');
  }
  if (facts.launchesAwaitingMeasurement > 0) return status('measurement_pending');
  return status('healthy');
}

/** A run that finished longer ago than the threshold, or a cursor that exists
 * with no finished run at all. */
export function workerStaleV1(lastRunAt: string | null, now: string, staleAfterMs: number): boolean {
  if (lastRunAt === null) return true;
  const finished = Date.parse(lastRunAt);
  if (!Number.isFinite(finished)) return true;
  return Date.parse(now) - finished > staleAfterMs;
}

/**
 * T73-LIVE §9 — one word for the operational state.
 *
 * Deliberately NOT derived from whether the feed has rows. An empty list with a
 * healthy pipeline means nothing measured up; an empty list with a stale worker
 * means nobody looked. Those are the two readings a user was previously unable
 * to tell apart, and the fix is to stop making them guess from the list.
 */
export type B20OperationalLabelV1 =
  | 'Caught up'
  | 'Measuring'
  | 'Catching up'
  | 'Worker stale'
  | 'Unavailable';

export function b20OperationalLabelV1(status: B20PipelineStatusV1): B20OperationalLabelV1 {
  switch (status.state) {
    case 'storage_unavailable':
    case 'configuration_required':
    case 'decoder_mismatch':
      return 'Unavailable';
    case 'worker_stale':
    case 'ingestion_not_started':
      return 'Worker stale';
    case 'ingestion_catching_up':
      return 'Catching up';
    case 'degraded':
      // The worker IS running and the cursor IS moving; some reads came back
      // incomplete. That is a data-quality statement, not an outage.
      return 'Catching up';
    // Its own word. `measurement_pending` used to share 'Caught up' with
    // `healthy`, so the panel read "Caught up" directly above "440 launches
    // have been found and are waiting for Exit-First measurement" — two true
    // statements about two different stages, printed as a contradiction.
    // Ingestion being current says nothing about whether anything was measured.
    case 'measurement_pending':
      return 'Measuring';
    case 'healthy':
      return 'Caught up';
  }
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
    case 'worker_stale':
      return facts.lastIngestionRunAt
        ? `Discover has not advanced since ${facts.lastIngestionRunAt}. The list below is what was measured before that, not what is on chain now.`
        : 'Discover has a cursor but no completed run, so nothing below reflects the current chain.';
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
  /** When MIORAIL first stored it. Never presented as a launch time. */
  detectedAt: string;
  /**
   * T69-C.1 §1 — when the token was actually created, from the block that
   * carried the event. Null when the endpoint did not report a block
   * timestamp, in which case a surface says "discovered" and names the block
   * rather than implying a launch time it does not have.
   */
  launchedAt: string | null;
  launchTimeSource: 'onchain_block' | 'discovered';
  /**
   * Seconds since the LAUNCH, not since detection. Null whenever `launchedAt`
   * is — the ingestion worker can be hours or days behind the head, so
   * detection time is a fact about Miorail's backlog and says nothing about
   * how old a token is. Presenting one as the other made every stored launch
   * look minutes old.
   */
  ageSeconds: number | null;
  canonical: boolean;
}

/** Display-safe measurement. Every numeric field is nullable and NEVER
 * defaulted to zero — "not measured" and "zero" are different answers, and a
 * card showing 0.00% cost for an unmeasured token is a lie with a decimal
 * point in it. */
export interface B20CardObservationV1 {
  /** Stable identity of the exact append-only observation this card projects. */
  observationId: string;
  /** Hash of the measured facts, used to reject a stale Ask-this-card context. */
  evidenceHash: string;
  state: B20ObservationStateV1;
  reasonCode: string | null;
  /**
   * The human verdict, and the machine-readable kind behind it.
   *
   * `state` and `reasonCode` stay exactly as measured — they are the evidence
   * vocabulary and the x402 seller binds to them. `standing` is the reading
   * layer on top, and it is what separates "nobody has bought this yet" from
   * "people bought it and Miorail could not price a sale" from "Miorail never
   * found the pool", all three of which used to say one sentence.
   */
  standing: B20ExitStandingV1;
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
  /** What the pool's Uniswap v4 hook is ALLOWED to do, decoded from the low 14
   * bits of its own address. Null when the venue has no hooks or none was
   * recorded — "not read" and "no hook" are different, and `standing` carries
   * that difference rather than this field being overloaded.
   *
   * Permissions, never behaviour: a hook allowed to take a fee may take none.
   * The measured round trip stays the only evidence of what exiting costs. */
  poolHook: B20HookAssessmentV1 | null;
  /** Buying in the launch's own window. Null when nobody has measured that
   * window — which a launch whose window is still open never has. NOT the same
   * as nobody buying: that is a measured row with a zero count. */
  launchBuyers: {
    buyerCount: number;
    topBuyerShareBps: number | null;
    topThreeShareBps: number | null;
  } | null;
  /** Whether the fixed launch-buying window is still collecting, measured, or
   * closed without a complete aggregate. */
  launchBuyerWindow: B20LaunchBuyerWindowViewV1 | null;
  optimisticReturnAtomic: string | null;
  optimisticRoundTripBps: number | null;
  routeCoverage: 'complete' | 'partial';
  /** Which venue families the reading actually asked. Null means the row does
   * not record it — every observation written before the field existed, of
   * which 1,662 predate Uniswap v4 entering the search at all. */
  venuesConsulted: readonly string[] | null;
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
  /**
   * T69-C.1 §2 — the ONE action this card may offer, chosen from the rejection
   * reason rather than from freshness alone. `canCheckProfile` remains what it
   * was: a freshness gate. This is the narrower question of whether a wallet
   * check is even the right thing to offer.
   */
  action: B20CardActionModelV1;
  /** §10 — named, so a surface renders the words rather than a zero. */
  notMeasured: readonly string[];
}

/** §10 — dimensions Miorail deliberately does not measure. Listed rather than
 * omitted, because a missing row reads as "nothing to report" and a named one
 * reads as "nobody measured this". */
export const B20_NOT_MEASURED_DIMENSIONS_V1 = [
  // Narrowed, not removed. Buyers INSIDE the launch window are measured now
  // and shown on the card; buyers after it are not, and the unqualified phrase
  // would now be false.
  'unique buyers beyond the launch window',
  'trading volume',
  // Stays. What is measured is GROSS BUYING in a window — a wallet counted
  // there may have sold everything since, so nothing here says who holds the
  // supply. Dropping this line because a concentration number appeared would
  // be the exact overclaim the number was written to avoid.
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

export interface B20LaunchBuyerWindowViewV1 {
  status: 'collecting' | 'measured' | 'closed_unmeasured' | 'unknown';
  closesAtBlock: string;
}

/**
 * Explains a missing launch-buyer aggregate without ever turning an unfinished
 * window into a partial count. `observedHead` is the confirmed ingestion head,
 * not a client clock or a guessed block cadence.
 */
export function b20LaunchBuyerWindowV1(input: {
  launchBlock: string;
  observedHead: string | null;
  windowBlocks: number;
  measured: boolean;
  /** The exact stored window wins over today's configured width. */
  measuredToBlock?: string | null;
}): B20LaunchBuyerWindowViewV1 {
  const closesAtBlock = input.measured && input.measuredToBlock
    ? input.measuredToBlock
    : (BigInt(input.launchBlock) + BigInt(input.windowBlocks)).toString();
  if (input.measured) return { status: 'measured', closesAtBlock };
  if (input.observedHead === null) return { status: 'unknown', closesAtBlock };
  return {
    status: BigInt(input.observedHead) < BigInt(closesAtBlock) ? 'collecting' : 'closed_unmeasured',
    closesAtBlock,
  };
}

export interface B20CardInputV1 {
  /** Launch-window buying, when it has been measured. Optional and separate
   * from `observation` because it is context about a launch rather than part
   * of a measurement of it — it has its own window and its own freshness. */
  launchBuyers?: {
    buyerCount: number;
    topBuyerShareBps: number | null;
    topThreeShareBps: number | null;
  } | null;
  /** Why launchBuyers is null. The buyer count is final only after its whole
   * launch window closes, so surfaces need this state instead of guessing
   * that null means zero or hiding the dimension entirely. */
  launchBuyerWindow?: B20LaunchBuyerWindowViewV1 | null;
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
    /** The block's own timestamp, when the endpoint reported one. */
    blockTimestamp?: string | null;
    canonical: boolean;
  };
  observation: {
    id: string;
    evidenceHash: string;
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
    poolHookAddress?: string | null;
    optimisticExitReturnAtomic: string | null;
    optimisticRoundTripBps: number | null;
    routeCoverage: 'complete' | 'partial';
    venuesConsulted?: readonly string[] | null;
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
// ---------------------------------------------------------------------------
// T69-C.1 §2/§3 — which action a card may offer.
//
// The defect this replaces: any fresh, canonical card offered "Check against
// my wallet", including one rejected because no exit route exists at all. That
// reads as "your wallet might be different" — and for a missing route, a paused
// transfer, or an unrecognised token, it is not. The evidence does not depend
// on who is asking, so offering a wallet check invites a user to spend a
// simulation disproving something already proven.
//
// A STALE rejection is a different matter: the chain has moved on, and
// re-measuring may genuinely change the answer. So freshness decides whether a
// wallet-independent rejection is final or merely old.
// ---------------------------------------------------------------------------

export const B20_CARD_ACTIONS_V1 = ['check_wallet', 'try_profile', 'refresh_measurement', 'none'] as const;
export type B20CardActionV1 = (typeof B20_CARD_ACTIONS_V1)[number];

/**
 * Rejections that hold for every wallet.
 *
 * None of these is about the asker. A token the factory does not recognise is
 * not recognised for anyone; a paused transfer is paused for everyone; a route
 * Miorail cannot find is missing regardless of who looks.
 */
export const B20_WALLET_INDEPENDENT_REJECTIONS_V1 = [
  'not_b20',
  'uninitialized',
  'transfers_paused',
  'no_entry_route',
  'no_exit_route',
] as const;

/** Rejections that are about the reference PROFILE, not about the token. A
 * smaller position or a wider tolerance can legitimately pass. */
export const B20_PROFILE_REJECTIONS_V1 = [
  'round_trip_above_tolerance',
  'exit_capacity_below_position',
] as const;

export interface B20CardActionModelV1 {
  action: B20CardActionV1;
  /** The button's words, or null when there is no button. */
  label: string | null;
  /** Always present: why this action and not another. */
  reason: string;
}

export const B20_ACTION_COPY_V1 = {
  superseded: 'A chain reorganisation replaced this launch, so it is no longer current.',
  unmeasured: 'Nothing has been measured for this token yet, so there is nothing to check.',
  // §3 — the sentence that has to exist. It says the evidence is about the
  // token and closes the door on "maybe my wallet is special".
  walletIndependent:
    'This is a fact about the token at the measured block, not about any particular wallet — checking it against yours would not change it.',
  stale: 'This measurement is past its freshness window. Re-measure before drawing anything from it.',
  profile:
    'The token was measured against the feed’s reference position and tolerance. A smaller position or a wider tolerance may pass.',
  policy:
    'A transfer policy is active on this token. Whether it admits YOUR wallet is the one thing a wallet-specific check can answer.',
  provisional: 'Measured before any entry moved the pool. Your own check runs the entry and exit in sequence.',
  queued: 'This launch is stored and waiting for its first measurement.',
} as const;

export function b20CardActionV1(input: {
  canonical: boolean;
  hasObservation: boolean;
  state: B20ObservationStateV1 | null;
  reasonCode: string | null;
  freshness: B20FreshnessV1 | null;
  transferPolicyState: B20TransferPolicyStateV1 | null;
}): B20CardActionModelV1 {
  if (!input.canonical) {
    return { action: 'none', label: null, reason: B20_ACTION_COPY_V1.superseded };
  }
  if (!input.hasObservation || input.state === null) {
    return { action: 'none', label: null, reason: B20_ACTION_COPY_V1.unmeasured };
  }

  const walletIndependent =
    input.state === 'rejected' &&
    input.reasonCode !== null &&
    (B20_WALLET_INDEPENDENT_REJECTIONS_V1 as readonly string[]).includes(input.reasonCode);

  // §3. Checked BEFORE staleness so a fresh, sound rejection is final rather
  // than merely refreshable.
  if (walletIndependent && input.freshness === 'fresh') {
    return { action: 'none', label: null, reason: B20_ACTION_COPY_V1.walletIndependent };
  }

  // Everything below rests on numbers, and stale numbers support nothing —
  // including a wallet-independent rejection, which the chain may have since
  // overturned by adding a route or unpausing transfers.
  if (input.freshness === 'stale') {
    return { action: 'refresh_measurement', label: 'Refresh measurement', reason: B20_ACTION_COPY_V1.stale };
  }

  if (
    input.state === 'rejected' &&
    input.reasonCode !== null &&
    (B20_PROFILE_REJECTIONS_V1 as readonly string[]).includes(input.reasonCode)
  ) {
    return { action: 'try_profile', label: 'Try another profile', reason: B20_ACTION_COPY_V1.profile };
  }

  if (input.state === 'unmeasured' || input.state === 'candidate') {
    return {
      action: 'refresh_measurement',
      label: 'Refresh measurement',
      reason: input.state === 'candidate' ? B20_ACTION_COPY_V1.queued : B20_ACTION_COPY_V1.unmeasured,
    };
  }

  if (input.state === 'provisional') {
    return {
      action: 'check_wallet',
      label: 'Check against my wallet',
      // A restricted policy is THE wallet-dependent case, so it earns its own
      // sentence rather than the generic one.
      reason:
        input.transferPolicyState === 'restricted'
          ? B20_ACTION_COPY_V1.policy
          : B20_ACTION_COPY_V1.provisional,
    };
  }

  // A rejection with a reason this build does not know. Fail closed: no
  // action, rather than guessing that a wallet could overturn it.
  return { action: 'none', label: null, reason: B20_ACTION_COPY_V1.walletIndependent };
}

export function b20OpportunityCardV1(input: B20CardInputV1): B20OpportunityCardV1 {
  const { blockTimestamp, ...launchFields } = input.launch;
  // §1 — the age comes from the CHAIN or it does not exist. `detectedAt` is
  // when the ingestion worker got here, which with a cursor behind the head is
  // a fact about the backlog.
  const launchedMs = blockTimestamp ? Date.parse(blockTimestamp) : Number.NaN;
  const launchedAt = Number.isFinite(launchedMs) ? new Date(launchedMs).toISOString() : null;
  const launch: B20CardLaunchV1 = {
    ...launchFields,
    launchedAt,
    launchTimeSource: launchedAt === null ? 'discovered' : 'onchain_block',
    ageSeconds: launchedAt === null ? null : Math.max(0, Math.floor((input.now.getTime() - launchedMs) / 1000)),
  };

  if (!input.observation) {
    return {
      schemaVersion: 'b20-opportunity-card/v1',
      launch,
      observation: null,
      // Nothing has been measured, so there is nothing to check a profile
      // against yet. The feed says so rather than offering an action that
      // would run on no evidence.
      canCheckProfile: false,
      action: b20CardActionV1({
        canonical: input.launch.canonical,
        hasObservation: false,
        state: null,
        reasonCode: null,
        freshness: null,
        transferPolicyState: null,
      }),
      notMeasured: B20_NOT_MEASURED_DIMENSIONS_V1,
    };
  }

  const source = input.observation;
  const freshness: B20FreshnessV1 = Date.parse(source.staleAfter) > input.now.getTime() ? 'fresh' : 'stale';
  const policyActive = source.transferPolicyState === 'restricted';

  // The buyer aggregate is what separates "no market yet" from "a market that
  // will not let you out", so an incomplete window must reach this as null
  // rather than as zero — a window still collecting has not counted anybody.
  const buyerCount =
    input.launchBuyerWindow && input.launchBuyerWindow.status !== 'measured'
      ? null
      : input.launchBuyers?.buyerCount ?? null;
  const standing = b20ExitStandingV1({
    observation: {
      state: source.state,
      reasonCode: source.reasonCode,
      entryRouteFound: source.entryRouteFound,
      exitRouteFound: source.exitRouteFound,
      // Null on every observation written before the field existed. The
      // standing then says the search cannot support a claim about where the
      // token trades, rather than reporting a venue gap as a finding.
      venuesConsulted: source.venuesConsulted ?? null,
    },
    buyerCount,
  });

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
      observationId: source.id,
      evidenceHash: source.evidenceHash,
      state: source.state,
      reasonCode: source.reasonCode,
      standing,
      // The standing headline replaces the state copy. `detail` keeps the
      // measured specifics below it — the conclusion first, its evidence
      // underneath, rather than the evidence standing in for a conclusion.
      headline: standing.headline,
      detail,
      referencePositionAtomic: source.referencePositionAtomic,
      referenceQuoteAsset: source.referenceQuoteAsset,
      maxRoundTripBps: source.maxRoundTripBps,
      maxExitSlippageBps: source.maxExitSlippageBps,
      entryRouteFound: source.entryRouteFound,
      exitRouteFound: source.exitRouteFound,
      entrySourceKey: source.entrySourceKey,
      exitSourceKey: source.exitSourceKey,
      // Decoded here rather than stored: the address is the whole truth, and
      // keeping the interpretation in one tested function means a card cannot
      // drift from what the bits actually say.
      poolHook: source.poolHookAddress ? b20HookAssessmentV1(source.poolHookAddress) : null,
      launchBuyers: input.launchBuyers ?? null,
      launchBuyerWindow: input.launchBuyerWindow ?? null,
      optimisticReturnAtomic: source.optimisticExitReturnAtomic,
      optimisticRoundTripBps: source.optimisticRoundTripBps,
      routeCoverage: source.routeCoverage,
      // What `routeCoverage` cannot say: WHICH venues the search covered.
      venuesConsulted: source.venuesConsulted ?? null,
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
    action: b20CardActionV1({
      canonical: input.launch.canonical,
      hasObservation: true,
      state: source.state,
      reasonCode: source.reasonCode,
      freshness,
      transferPolicyState: source.transferPolicyState,
    }),
    notMeasured: B20_NOT_MEASURED_DIMENSIONS_V1,
  };
}

/** The transfer-policy sentence for a given state, so a surface never writes
 * its own. */
export function b20TransferPolicyCopyV1(state: B20TransferPolicyStateV1): string {
  return B20_TRANSFER_POLICY_COPY_V1[state];
}
