import { OPPORTUNITY_QUOTE_ASSET_V1, type OpportunityProfileV2 } from '@mioagent/opportunity-rail';

import type { B20MeasureResultV1, MeasurePassConfigV1, MeasurePassOutcomeV1 } from './b20MeasureRun.js';

// Argument parsing, exit codes and the printed summary for
// `pnpm b20:measure-opportunities`. Separate from the pass so all three can be
// tested without a database, an endpoint or a clock.
//
// The reference profile below is a FEED MEASUREMENT PARAMETER, not a user
// qualification. Nobody asked for 100 USDC at 3%; it is the yardstick the
// public feed measures every token against, and every stored observation
// carries it so a future card can say what question was answered.

export interface B20MeasureArgsV1 extends MeasurePassConfigV1 {
  dryRun: boolean;
  help: boolean;
}

export class B20MeasureArgError extends Error {}

/** §5 — the default public reference profile. */
export const B20_MEASURE_REFERENCE_PROFILE_V1: OpportunityProfileV2 = {
  quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
  /** 100 USDC. */
  positionAtomic: '100000000',
  /** 3%. */
  maxRoundTripBps: 300,
  /** 3%. */
  maxExitSlippageBps: 300,
};

export const B20_MEASURE_DEFAULTS_V1 = {
  /** Launches selected per pass. */
  maxLaunches: 25,
  /** Deep candidates per pass. Each costs a route search plus ~15 paced
   * control calls, and the public endpoint serves about 2.5 calls a second. */
  maxDeepCandidates: 10,
  maxRouterCalls: 400,
  maxControlCalls: 200,
  maxRuntimeMs: 15 * 60 * 1000,
  maxRetries: 2,
  /**
   * One. Not a leftover — measured, twice, the second time correctly.
   *
   * The first probe raised this to 4 on evidence from `eth_getBlockByNumber`:
   * 48/48 concurrent at unchanged latency, rate-limited only at 16. That was
   * the wrong method. This worker's traffic is `eth_call`, and base.org meters
   * the two nothing alike. Measured from a clean IP, 20 calls per level:
   *
   *     1 call / 2000ms  (0.5/s)   20/20   100%
   *     1 call / 1000ms  (1.0/s)   14/20    70%
   *     1 call /  500ms  (2.0/s)   11/20    55%
   *     1 call /  200ms  (5.0/s)   10/20    50%
   *
   * `eth_call` sustains about half a call per second and degrades steeply
   * above it. Batching does not lift it — the meter counts calls, not HTTP
   * requests (batch of 5: 40% ok; batch of 10: 20%; batch of 20 is refused,
   * `-32014 maximum 10 calls in 1 batch`).
   *
   * The arithmetic closes: production writes ~168 observations/hour with a
   * steady 19% `route_search_degraded`, which is exactly where the 1/s row
   * above sits. The worker is already running at the endpoint's ceiling, so
   * candidate concurrency multiplies the call rate into the 50% band and buys
   * fewer measurements, not more.
   *
   * Raising this is not a throughput fix. Fewer calls per candidate, a
   * narrower universe, or an endpoint with a bigger eth_call budget are.
   */
  maxConcurrentCandidates: 1,
  /** §11 — an observation older than this is history, not a current reading. */
  observationStaleMs: 30 * 60 * 1000,
  /** Leave a token alone for this long after measuring it. */
  minReMeasureIntervalMs: 20 * 60 * 1000,
  /**
   * Deep candidates per pass reserved for the pair-forming queue.
   *
   * The primary queue is newest-first, and it has to be: Discover lists the
   * newest launches and the worker exists to serve them. What that ordering
   * cannot do is come back. In production the head of that queue was never
   * older than forty minutes, so a token measured once was never measured
   * again, and the movers rail asked for two comparable observations 24 hours
   * apart that nothing in the system could produce.
   *
   * Two slots, and only for launches that are ONE measurement away from a
   * pair — so the queue is short by construction and the reservation is
   * usually unspent. It never exceeds the pass's own candidate budget.
   */
  pairRemeasureCandidates: 2,
  /** Launches older than this are past the active-measurement window. */
  maxLaunchAgeMs: 48 * 60 * 60 * 1000,
  leaseTtlMs: 20 * 60 * 1000,
} as const;

/**
 * Exit codes, so a timer can tell "nothing to do" from "somebody must look".
 *
 * Note what is NOT here: no code means "a token was rejected". A rejection is a
 * measurement, not an operator problem.
 */
export const B20_MEASURE_EXIT_CODES_V1: Record<B20MeasureResultV1, number> = {
  success: 0,
  nothing_eligible: 0,
  budget_exhausted: 0,
  endpoint_unavailable: 1,
  storage_unavailable: 1,
  run_already_active: 3,
};

export function parseB20MeasureArgsV1(argv: readonly string[]): B20MeasureArgsV1 {
  const args: B20MeasureArgsV1 = {
    ...B20_MEASURE_DEFAULTS_V1,
    profile: { ...B20_MEASURE_REFERENCE_PROFILE_V1 },
    dryRun: false,
    help: false,
  };

  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw new B20MeasureArgError(`unrecognised argument: ${argument}`);
    const [, name, value] = match as unknown as [string, string, string];
    switch (name) {
      case 'max-launches':
        args.maxLaunches = positiveIntV1('--max-launches', value);
        break;
      case 'max-candidates':
        args.maxDeepCandidates = positiveIntV1('--max-candidates', value);
        break;
      case 'max-router-calls':
        args.maxRouterCalls = positiveIntV1('--max-router-calls', value);
        break;
      case 'max-control-calls':
        args.maxControlCalls = positiveIntV1('--max-control-calls', value);
        break;
      case 'max-runtime':
        args.maxRuntimeMs = parseDurationMsV1('--max-runtime', value);
        break;
      case 'max-retries':
        args.maxRetries = nonNegativeIntV1('--max-retries', value);
        break;
      case 'max-concurrent':
        args.maxConcurrentCandidates = positiveIntV1('--max-concurrent', value);
        break;
      case 'stale-after':
        args.observationStaleMs = parseDurationMsV1('--stale-after', value);
        break;
      case 'min-interval':
        args.minReMeasureIntervalMs = parseDurationMsV1('--min-interval', value);
        break;
      case 'max-launch-age':
        args.maxLaunchAgeMs = parseDurationMsV1('--max-launch-age', value);
        break;
      case 'pair-remeasures':
        // Zero is allowed and meaningful: it turns the reservation off and
        // restores the old single-queue behaviour exactly.
        args.pairRemeasureCandidates = nonNegativeIntV1('--pair-remeasures', value);
        break;
      case 'lease-ttl':
        args.leaseTtlMs = parseDurationMsV1('--lease-ttl', value);
        break;
      case 'position':
        args.profile = { ...args.profile, positionAtomic: atomicV1('--position', value) };
        break;
      case 'max-round-trip-bps':
        args.profile = { ...args.profile, maxRoundTripBps: bpsV1('--max-round-trip-bps', value) };
        break;
      case 'max-slippage-bps':
        args.profile = { ...args.profile, maxExitSlippageBps: bpsV1('--max-slippage-bps', value) };
        break;
      default:
        throw new B20MeasureArgError(`unrecognised argument: --${name}`);
    }
  }
  return args;
}

function positiveIntV1(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new B20MeasureArgError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeIntV1(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new B20MeasureArgError(`${name} must be a non-negative integer`);
  return value;
}

function bpsV1(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new B20MeasureArgError(`${name} must be between 1 and 10000 basis points`);
  }
  return value;
}

function atomicV1(name: string, raw: string): string {
  if (!/^[1-9][0-9]{0,17}$/.test(raw.trim())) {
    throw new B20MeasureArgError(`${name} must be a positive atomic amount`);
  }
  return raw.trim();
}

export function parseDurationMsV1(name: string, raw: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new B20MeasureArgError(`${name} must be a duration like 30s, 10m, 2h or 1d`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) throw new B20MeasureArgError(`${name} must be greater than zero`);
  const unit = match[2] ?? 'ms';
  return value * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
}

/**
 * §13 — what one run prints.
 *
 * States are reported as counts, never ranked, and there is no "top" anything.
 * The line that must never disappear is `not_checked`: a launch the budget did
 * not reach is not a launch with nothing interesting in it.
 */
export function formatB20MeasureSummaryV1(outcome: MeasurePassOutcomeV1): string {
  if (outcome.result === 'run_already_active') {
    return ['B20 opportunity measurement stopped', 'State: run_already_active', 'Another pass holds the measurement lease. Nothing was measured.'].join('\n');
  }
  const lines = [
    'B20 opportunity measurement',
    `Eligible launches: ${outcome.eligible}`,
    `Attempted: ${outcome.attempted}`,
    `Observations written: ${outcome.observationsWritten}`,
    `Already observed at this block: ${outcome.idempotentRepeats}`,
    `Not checked (budget): ${outcome.notChecked}`,
    `Failed candidates: ${outcome.failed}`,
    `Router calls: ${outcome.routerCalls}`,
    `Control calls: ${outcome.controlCalls}`,
    `Budget exhausted: ${outcome.budgetExhausted ? 'yes — the rest is not_checked' : 'no'}`,
  ];
  const states = Object.entries(outcome.byState).sort(([left], [right]) => left.localeCompare(right));
  if (states.length > 0) {
    lines.push('States:');
    for (const [state, count] of states) lines.push(`  ${state}: ${count}`);
  }
  // The one thing every provisional number needs beside it.
  if ((outcome.byState.provisional ?? 0) > 0) {
    lines.push('Provisional means the exit was quoted before the entry moved the pool. Nothing was simulated.');
  }
  return lines.join('\n');
}

export function printB20MeasureUsageV1(): void {
  console.log(`
Usage: pnpm b20:measure-opportunities [-- <options>]

Measures stored B20 launches against the feed's public reference profile and
stores an immutable observation for each one attempted.

Read-only against Base: there is no signer in this process, no allowance is
touched, no state is overridden and nothing it does can move an asset. It has
no wallet at all, which is why it can never produce a qualified result — only
candidate, provisional, rejected or unmeasured.

Options:
  --max-launches=<n>        Launches selected per pass (default ${B20_MEASURE_DEFAULTS_V1.maxLaunches})
  --max-candidates=<n>      Deep candidates per pass (default ${B20_MEASURE_DEFAULTS_V1.maxDeepCandidates}).
                            Soft by up to --max-concurrent minus one: the budget is
                            checked between chunks, so a chunk already running
                            finishes. --max-router-calls stays a hard ceiling.
  --max-router-calls=<n>    Router call ceiling (default ${B20_MEASURE_DEFAULTS_V1.maxRouterCalls})
  --max-control-calls=<n>   B20 control call ceiling (default ${B20_MEASURE_DEFAULTS_V1.maxControlCalls})
  --max-runtime=<dur>       Wall clock for one pass (default 15m)
  --max-retries=<n>         Retries per failing read (default ${B20_MEASURE_DEFAULTS_V1.maxRetries})
  --max-concurrent=<n>      Candidates measured at once (default ${B20_MEASURE_DEFAULTS_V1.maxConcurrentCandidates})
  --stale-after=<dur>       How long an observation stays current (default 30m)
  --min-interval=<dur>      Leave a token alone this long after measuring (default 20m)
  --max-launch-age=<dur>    Stop measuring launches older than this (default 48h)
  --pair-remeasures=<n>     Candidates per pass reserved for launches one
                            measurement away from a 24h comparison; 0 turns the
                            reservation off (default ${B20_MEASURE_DEFAULTS_V1.pairRemeasureCandidates})
  --lease-ttl=<dur>         How long a crashed worker holds the lease (default 20m)
  --position=<atomic>       Reference position, atomic USDC (default 100000000)
  --max-round-trip-bps=<n>  Reference round-trip tolerance (default 300)
  --max-slippage-bps=<n>    Reference exit-slippage tolerance (default 300)
  --dry-run                 List what would be measured. The chain is not read.
  --help                    This message.

Requires BASE_MAINNET_RPC_URL.

Exit codes: 0 ok · 1 endpoint or storage unavailable · 3 another run holds the
measurement lease. A rejected token is a measurement, not an error.
`);
}
