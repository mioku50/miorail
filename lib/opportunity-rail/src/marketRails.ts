// ---------------------------------------------------------------------------
// T73 — the two market rails, and the wallet's own coverage.
//
// Everything here is a projection of observations the measurement worker
// already wrote. No new measurement, no new score, and no dimension Miorail
// did not measure: there is no volume, no unique buyers, no market cap, no
// holder concentration and no predicted return anywhere in this file, and a
// test asserts the words do not appear (§6).
//
// The arithmetic is the part worth reading twice. A "24h change" computed from
// two quotes taken 24 hours apart is a change in WHAT MIORAIL MEASURED, not a
// market price move: the quotes come from the venues Miorail routes through,
// at the sizes Miorail probes, against one fixed reference position. Calling
// that "performance" would be claiming a market-wide fact from a handful of
// pool reads. It is labelled accordingly and the label is not optional.
// ---------------------------------------------------------------------------

/**
 * Mirrored from `observation.ts` rather than imported.
 *
 * That module type-imports `exitFirst.ts`, which uses bigint literals — a
 * compile error at the ES2017 target the miniapp builds lib/ui with. Importing
 * it here would make this module unusable by the surface that has to render it.
 * `marketRails.test.ts` reads observation.ts from disk and fails if the two
 * lists ever diverge, so these are copies that cannot rot silently.
 */
type B20ObservationStateV1 = 'candidate' | 'provisional' | 'rejected' | 'unmeasured';
type B20TransferPolicyStateV1 = 'open' | 'restricted' | 'unavailable' | 'unsupported_by_variant';

/** Re-exported under rail-local names so a consumer importing only this module
 * still has the vocabulary, without colliding with the barrel's own exports. */
export type MarketObservationStateV1 = B20ObservationStateV1;
export type MarketTransferPolicyStateV1 = B20TransferPolicyStateV1;

/** Basis-point denominator. Integer arithmetic throughout — a float turns an
 * 18-decimal token amount into scientific notation and a 1.18% into 1.1799999. */
const BPS_V1 = BigInt(10_000);

/** Structural mirror of the stored observation, narrowed to what these rails
 * read. Mirrored rather than imported so this module stays a pure projection
 * with no dependency on the storage package. */
export interface MarketObservationV1 {
  tokenAddress: string;
  state: B20ObservationStateV1;
  reasonCode: string | null;
  referenceQuoteAsset: string;
  referencePositionAtomic: string;
  profileIdentity: string;
  measurementVersion: string;
  entryOutputAtomic: string | null;
  optimisticRoundTripBps: number | null;
  largestPassingSizeAtomic: string | null;
  firstFailingSizeAtomic: string | null;
  capacityToleranceBps: number;
  capacityStable: boolean | null;
  exitRouteFound: boolean;
  transfersPaused: boolean | null;
  transferPolicyState: B20TransferPolicyStateV1 | null;
  controlsComplete: boolean | null;
  controlsBlockNumber: string | null;
  observationBlockNumber: string;
  measuredAt: string;
  staleAfter: string;
}

export interface MarketLaunchV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
  /** Null when the event did not carry readable decimals. A mover cannot be
   * computed without them — §3 requires known decimals. */
  decimals: number | null;
  canonical: boolean;
}

export interface MarketRowV1 {
  launch: MarketLaunchV1;
  observation: MarketObservationV1;
}

// ---------------------------------------------------------------------------
// §2 — Exit Capacity Leaders
// ---------------------------------------------------------------------------

/** Why a token is not on the leaders list. Named so a surface can say it. */
export const CAPACITY_EXCLUSION_REASONS_V1 = [
  'stale',
  'not_canonical',
  'no_measured_capacity',
  'unstable_ladder',
  'transfers_paused',
  'no_exit_route',
  'controls_incomplete',
  'different_tolerance',
] as const;
export type CapacityExclusionV1 = (typeof CAPACITY_EXCLUSION_REASONS_V1)[number];

export interface ExitCapacityLeaderV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number | null;
  /** The largest probe that PASSED. Never a figure between two rungs. */
  largestPassingSizeAtomic: string;
  /** The smallest probe that failed, when one did. The pair is the bound. */
  firstFailingSizeAtomic: string | null;
  toleranceBps: number;
  /** Carried so a rejected token on this list reads as rejected. */
  state: B20ObservationStateV1;
  reasonCode: string | null;
  measuredAt: string;
  observationBlockNumber: string;
  freshness: 'fresh';
}

export interface ExitCapacityLeadersInputV1 {
  rows: readonly MarketRowV1[];
  /** ONE tolerance. A ladder probed against a different one is not comparable
   * and is excluded rather than silently ranked beside these. */
  toleranceBps: number;
  now: Date;
  limit: number;
}

export function exitCapacityExclusionV1(
  row: MarketRowV1,
  input: { toleranceBps: number; now: Date },
): CapacityExclusionV1 | null {
  const { launch, observation } = row;
  if (!launch.canonical) return 'not_canonical';
  if (Date.parse(observation.staleAfter) <= input.now.getTime()) return 'stale';
  if (observation.capacityToleranceBps !== input.toleranceBps) return 'different_tolerance';
  if (!observation.exitRouteFound) return 'no_exit_route';
  if (observation.transfersPaused === true) return 'transfers_paused';
  if (observation.controlsComplete !== true) return 'controls_incomplete';
  // An unstable ladder means a larger size passed above one that failed. The
  // "largest passing" figure is then not a bound on anything.
  if (observation.capacityStable !== true) return 'unstable_ladder';
  if (observation.largestPassingSizeAtomic === null) return 'no_measured_capacity';
  return null;
}

/**
 * Ranked by the largest size that actually passed a probe.
 *
 * Deterministic: ties break on token address, so two runs over the same data
 * produce the same order. Without that a rail reorders itself on every refresh
 * and a user reads movement into noise.
 */
export function exitCapacityLeadersV1(input: ExitCapacityLeadersInputV1): {
  leaders: ExitCapacityLeaderV1[];
  excluded: { tokenAddress: string; reason: CapacityExclusionV1 }[];
} {
  const excluded: { tokenAddress: string; reason: CapacityExclusionV1 }[] = [];
  const eligible: ExitCapacityLeaderV1[] = [];

  for (const row of input.rows) {
    const reason = exitCapacityExclusionV1(row, input);
    if (reason) {
      excluded.push({ tokenAddress: row.launch.tokenAddress, reason });
      continue;
    }
    eligible.push({
      tokenAddress: row.launch.tokenAddress,
      symbol: row.launch.symbol,
      name: row.launch.name,
      decimals: row.launch.decimals,
      largestPassingSizeAtomic: row.observation.largestPassingSizeAtomic!,
      firstFailingSizeAtomic: row.observation.firstFailingSizeAtomic,
      toleranceBps: row.observation.capacityToleranceBps,
      state: row.observation.state,
      reasonCode: row.observation.reasonCode,
      measuredAt: row.observation.measuredAt,
      observationBlockNumber: row.observation.observationBlockNumber,
      freshness: 'fresh',
    });
  }

  eligible.sort((left, right) => {
    const a = BigInt(left.largestPassingSizeAtomic);
    const b = BigInt(right.largestPassingSizeAtomic);
    if (a !== b) return a > b ? -1 : 1;
    return left.tokenAddress.localeCompare(right.tokenAddress);
  });

  return { leaders: eligible.slice(0, Math.max(0, input.limit)), excluded };
}

// ---------------------------------------------------------------------------
// §3 — 24h Measured Movers
// ---------------------------------------------------------------------------

/** The exact words. Not "performance", not "gainers", not "market". */
export const MEASURED_MOVE_LABEL_V1 = '24h change from Miorail measured quotes';

export const MEASURED_MOVE_NOTE_V1 =
  'Computed from two Miorail quotes about 24 hours apart, at one fixed reference size, on the venues Miorail routes through. It is not a market-wide price change and not a return anybody realised.';

export const MOVER_EXCLUSION_REASONS_V1 = [
  'no_baseline',
  'baseline_outside_window',
  'incompatible_profile',
  'incompatible_version',
  'unknown_decimals',
  'below_minimum_capacity',
  'not_measured',
  'unstable_ladder',
  'stale',
] as const;
export type MoverExclusionV1 = (typeof MOVER_EXCLUSION_REASONS_V1)[number];

export interface MoverPairV1 {
  launch: MarketLaunchV1;
  latest: MarketObservationV1;
  /** The observation closest to `baselineAgeMs` before `latest`, or null. */
  baseline: MarketObservationV1 | null;
}

export interface MeasuredMoverV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  /**
   * Change in the implied price of one token, in basis points, between the two
   * measurements. Positive means the same reference position bought FEWER
   * tokens in the later quote.
   */
  changeBps: number;
  label: typeof MEASURED_MOVE_LABEL_V1;
  entryOutputThenAtomic: string;
  entryOutputNowAtomic: string;
  referencePositionAtomic: string;
  /** Actual gap between the two measurements, so "24h" is never a rounded lie. */
  intervalSeconds: number;
  baselineMeasuredAt: string;
  measuredAt: string;
  largestPassingSizeAtomic: string;
  state: B20ObservationStateV1;
}

export interface MeasuredMoversInputV1 {
  pairs: readonly MoverPairV1[];
  now: Date;
  /** How far apart the two measurements should be. */
  baselineAgeMs: number;
  /** How far from that a baseline may sit and still count. */
  baselineToleranceMs: number;
  /**
   * §3 — thin pools are excluded. A token whose measured exit capacity is a
   * rounding error produces enormous percentage swings from quotes nobody
   * could act on.
   */
  minExitCapacityAtomic: string;
  limit: number;
}

/** Both observations must describe the same measurement, or the difference
 * between them is a difference in method rather than in the market. */
export function moverCompatibilityV1(pair: MoverPairV1, input: MeasuredMoversInputV1): MoverExclusionV1 | null {
  const { latest, baseline, launch } = pair;
  if (latest.state !== 'provisional') return 'not_measured';
  if (Date.parse(latest.staleAfter) <= input.now.getTime()) return 'stale';
  if (latest.capacityStable !== true) return 'unstable_ladder';
  if (launch.decimals === null) return 'unknown_decimals';
  if (latest.largestPassingSizeAtomic === null) return 'below_minimum_capacity';
  if (BigInt(latest.largestPassingSizeAtomic) < BigInt(input.minExitCapacityAtomic)) {
    return 'below_minimum_capacity';
  }
  if (!baseline) return 'no_baseline';
  if (baseline.state !== 'provisional') return 'not_measured';
  if (baseline.capacityStable !== true) return 'unstable_ladder';

  if (
    baseline.profileIdentity !== latest.profileIdentity ||
    baseline.referenceQuoteAsset !== latest.referenceQuoteAsset ||
    baseline.referencePositionAtomic !== latest.referencePositionAtomic
  ) {
    return 'incompatible_profile';
  }
  if (baseline.measurementVersion !== latest.measurementVersion) return 'incompatible_version';
  if (latest.entryOutputAtomic === null || baseline.entryOutputAtomic === null) return 'not_measured';
  // A zero entry output would be a division by zero AND a nonsense quote.
  if (BigInt(baseline.entryOutputAtomic) === BigInt(0) || BigInt(latest.entryOutputAtomic) === BigInt(0)) {
    return 'not_measured';
  }

  const gap = Date.parse(latest.measuredAt) - Date.parse(baseline.measuredAt);
  if (Math.abs(gap - input.baselineAgeMs) > input.baselineToleranceMs) return 'baseline_outside_window';
  return null;
}

/**
 * The change, in basis points, computed with integers only.
 *
 * The reference position is a fixed amount of the quote asset, so the tokens it
 * buys move inversely with price: price_now / price_then === output_then /
 * output_now. That identity is why this needs no price feed and no oracle — it
 * is two quotes Miorail took itself, divided.
 */
export function measuredChangeBpsV1(input: { entryOutputThenAtomic: string; entryOutputNowAtomic: string }): number {
  const then = BigInt(input.entryOutputThenAtomic);
  const now = BigInt(input.entryOutputNowAtomic);
  if (now === BigInt(0)) throw new Error('a zero entry output has no implied price');
  // Rounded toward zero by BigInt division, so a change is never rounded UP
  // into looking larger than it was measured to be.
  return Number((then * BPS_V1) / now - BPS_V1);
}

export function measuredMoversV1(input: MeasuredMoversInputV1): {
  movers: MeasuredMoverV1[];
  excluded: { tokenAddress: string; reason: MoverExclusionV1 }[];
} {
  const excluded: { tokenAddress: string; reason: MoverExclusionV1 }[] = [];
  const movers: MeasuredMoverV1[] = [];

  for (const pair of input.pairs) {
    const reason = moverCompatibilityV1(pair, input);
    if (reason) {
      excluded.push({ tokenAddress: pair.launch.tokenAddress, reason });
      continue;
    }
    const { latest, baseline, launch } = pair;
    movers.push({
      tokenAddress: launch.tokenAddress,
      symbol: launch.symbol,
      name: launch.name,
      decimals: launch.decimals!,
      changeBps: measuredChangeBpsV1({
        entryOutputThenAtomic: baseline!.entryOutputAtomic!,
        entryOutputNowAtomic: latest.entryOutputAtomic!,
      }),
      label: MEASURED_MOVE_LABEL_V1,
      entryOutputThenAtomic: baseline!.entryOutputAtomic!,
      entryOutputNowAtomic: latest.entryOutputAtomic!,
      referencePositionAtomic: latest.referencePositionAtomic,
      intervalSeconds: Math.round(
        (Date.parse(latest.measuredAt) - Date.parse(baseline!.measuredAt)) / 1000,
      ),
      baselineMeasuredAt: baseline!.measuredAt,
      measuredAt: latest.measuredAt,
      largestPassingSizeAtomic: latest.largestPassingSizeAtomic!,
      state: latest.state,
    });
  }

  // Largest absolute move first — a fall matters as much as a rise, and
  // sorting only by gain would make this a gainers board. Deterministic ties.
  movers.sort((left, right) => {
    const a = Math.abs(left.changeBps);
    const b = Math.abs(right.changeBps);
    if (a !== b) return b - a;
    return left.tokenAddress.localeCompare(right.tokenAddress);
  });

  return { movers: movers.slice(0, Math.max(0, input.limit)), excluded };
}

/** §5 — what the rail says before there is 24 hours of history to compare. */
export const COLLECTING_HISTORY_COPY_V1 = 'Collecting 24h history';
export const COLLECTING_HISTORY_NOTE_V1 =
  'Miorail needs two measurements about 24 hours apart to state a change. It has not been measuring this set for long enough yet.';

export function moversCollectingHistoryV1(result: {
  movers: readonly MeasuredMoverV1[];
  excluded: readonly { reason: MoverExclusionV1 }[];
}): boolean {
  // Only when the ONLY thing standing in the way is time. If tokens were
  // excluded for being thin or unmeasured, "collecting history" would be the
  // wrong explanation and a user would keep waiting for a list that is not
  // coming.
  if (result.movers.length > 0) return false;
  if (result.excluded.length === 0) return false;
  return result.excluded.every(
    (entry) => entry.reason === 'no_baseline' || entry.reason === 'baseline_outside_window',
  );
}

// ---------------------------------------------------------------------------
// §4 — Your Exit Coverage
// ---------------------------------------------------------------------------

export interface ExitCoverageInputV1 {
  tokenAddress: string;
  symbol: string;
  decimals: number | null;
  /** What this wallet holds, in atomic units of the token. */
  positionAtomic: string;
  observation: MarketObservationV1 | null;
  now: Date;
}

export interface ExitCoverageV1 {
  tokenAddress: string;
  symbol: string;
  positionAtomic: string;
  /** Null when no capacity was measured — never zero, which reads as "cannot
   * exit at all" rather than "not measured". */
  measuredCapacityAtomic: string | null;
  /**
   * Measured capacity as a proportion of the position, in basis points.
   * Capped at 10000: "your whole position fits" is the strongest true
   * statement, and 340% coverage is not more reassuring, it is just noise.
   */
  coverageBps: number | null;
  /** The plain-language version of the ratio. */
  verdict: 'covered' | 'partial' | 'uncovered' | 'unmeasured';
  toleranceBps: number | null;
  measuredAt: string | null;
  freshness: 'fresh' | 'stale' | 'unmeasured';
  /** §4 — the latest control change worth knowing about, or null. */
  controlNote: string | null;
  note: string;
}

export const EXIT_COVERAGE_NOTE_V1 = {
  unmeasured:
    'Miorail has not measured an exit for this token, so it cannot say how much of your position could be sold within tolerance.',
  covered:
    'The largest size Miorail probed successfully is at least your whole position. That is a measured bound, not a guarantee: the pool moves.',
  partial:
    'Miorail measured a passing exit smaller than your position. The rest was not probed, so it is unknown rather than impossible.',
  uncovered:
    'The largest passing probe is a small fraction of what you hold. Selling the whole position within the measured tolerance was not demonstrated.',
} as const;

export function exitCoverageV1(input: ExitCoverageInputV1): ExitCoverageV1 {
  const observation = input.observation;
  const base = {
    tokenAddress: input.tokenAddress,
    symbol: input.symbol,
    positionAtomic: input.positionAtomic,
  };

  if (!observation || observation.largestPassingSizeAtomic === null) {
    return {
      ...base,
      measuredCapacityAtomic: null,
      coverageBps: null,
      verdict: 'unmeasured',
      toleranceBps: observation?.capacityToleranceBps ?? null,
      measuredAt: observation?.measuredAt ?? null,
      freshness: 'unmeasured',
      controlNote: controlNoteV1(observation),
      note: EXIT_COVERAGE_NOTE_V1.unmeasured,
    };
  }

  const position = BigInt(input.positionAtomic);
  const capacity = BigInt(observation.largestPassingSizeAtomic);
  // A zero position has no ratio. Reported as unmeasured rather than as
  // infinite coverage, which would be true and useless.
  const coverageBps =
    position === BigInt(0) ? null : Number((capacity * BPS_V1) / position > BPS_V1 ? BPS_V1 : (capacity * BPS_V1) / position);

  const verdict: ExitCoverageV1['verdict'] =
    coverageBps === null ? 'unmeasured' : coverageBps >= 10_000 ? 'covered' : coverageBps >= 2_500 ? 'partial' : 'uncovered';

  return {
    ...base,
    measuredCapacityAtomic: observation.largestPassingSizeAtomic,
    coverageBps,
    verdict,
    toleranceBps: observation.capacityToleranceBps,
    measuredAt: observation.measuredAt,
    freshness: Date.parse(observation.staleAfter) > input.now.getTime() ? 'fresh' : 'stale',
    controlNote: controlNoteV1(observation),
    note: EXIT_COVERAGE_NOTE_V1[verdict],
  };
}

/** The one control fact that changes what a holder can do. */
function controlNoteV1(observation: MarketObservationV1 | null): string | null {
  if (!observation) return null;
  if (observation.transfersPaused === true) {
    return `Transfers were paused at block ${observation.controlsBlockNumber ?? observation.observationBlockNumber}. A position cannot be sold while they are.`;
  }
  if (observation.transferPolicyState === 'restricted') {
    return 'A transfer policy is active. Whether it admits your wallet is not something Miorail can enumerate.';
  }
  if (observation.controlsComplete === false) {
    return 'A mandatory control read did not answer, so the control picture is incomplete.';
  }
  return null;
}
