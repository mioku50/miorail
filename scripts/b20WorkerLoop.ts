// ---------------------------------------------------------------------------
// T73-LIVE §1/§2 — the loop that turns a bounded pass into a service.
//
// Both CLIs already do the right thing once: take a lease, advance a bounded
// amount, commit, exit. What was missing was anything to call them, and the gap
// showed — production sat 290,000 blocks behind confirmed head because a human
// had to remember.
//
// This is the smallest thing that fixes that, and it is deliberately NOT a
// scheduler. It has no cron expression, no queue and no state of its own: the
// cursor lives in Postgres, the lease lives in Postgres, and this decides one
// question between passes — how long to wait. Restarting the process loses
// nothing, because there is nothing here to lose.
//
// The cadence is the interesting part. A fixed interval is wrong in both
// directions: 290,000 blocks behind, a one-minute timer needs six hours to
// catch up; caught up, the same timer burns RPC budget re-reading a chain that
// has produced two blocks. So the delay comes from what the pass just reported.
//
// Every effect is injected — the pass, the clock, the sleep, the log. The
// policy below is a pure function of one outcome, which is why the whole
// catch-up behaviour can be asserted without a chain, a database or a wait.
// ---------------------------------------------------------------------------

/** What a pass tells the loop. Deliberately tiny: anything richer would tempt
 * this module into re-deciding things the pass already decided. */
export interface WorkerPassSignalV1 {
  /** The pass's own result vocabulary. */
  result: string;
  /** True when the pass stopped because it hit its own budget, not because it
   * ran out of work — the single strongest "there is more to do" signal. */
  budgetExhausted?: boolean;
  /** Discovery only. */
  blocksBehind?: number | null;
  /** Whether the pass did any work at all. */
  didWork?: boolean;
}

export interface WorkerCadenceV1 {
  /** Between back-to-back passes while catching up. Small, not zero: a tight
   * loop against a metered endpoint is how a key gets rate-limited. */
  catchUpMs: number;
  /** The resting cadence once current. */
  idleMs: number;
  /** After a refusal that another pass will not fix on its own. */
  backoffMs: number;
  /** The ceiling for repeated refusals. */
  maxBackoffMs: number;
}

export const B20_DISCOVER_CADENCE_V1: WorkerCadenceV1 = {
  // Not as small as it could be, and that is the point. One pass at the default
  // range is ~80 `eth_getLogs` calls; issuing those bursts 1.5s apart tripped
  // Alchemy's compute-unit limit in production, and a rate-limited pass wastes
  // ALL eighty calls and advances the cursor by nothing. Five seconds of rest
  // between bursts moves the chain faster than fifteen hundred milliseconds of
  // impatience — measured, not assumed.
  catchUpMs: 5_000,
  // Base produces a block every two seconds, so a minute of rest is thirty
  // blocks — well inside one pass, and it keeps `blocksBehind` visibly near
  // zero on the status surface rather than sawtoothing.
  idleMs: 60_000,
  backoffMs: 30_000,
  maxBackoffMs: 10 * 60_000,
};

export const B20_MEASURE_CADENCE_V1: WorkerCadenceV1 = {
  // Measurement is far more expensive per candidate than discovery — several
  // paced control reads and a router quote ladder each — so even the catch-up
  // pace is deliberate.
  catchUpMs: 15_000,
  idleMs: 5 * 60_000,
  backoffMs: 60_000,
  maxBackoffMs: 15 * 60_000,
};

/**
 * Results that mean "do not simply try again in a moment".
 *
 * `run_already_active` is NOT one of them: a lease held by another worker is
 * the lock doing its job, and the right response is to come back shortly rather
 * than to sulk for ten minutes.
 */
export const WORKER_BACKOFF_RESULTS_V1 = [
  'endpoint_unavailable',
  'storage_unavailable',
  'decoder_mismatch',
  'configuration_required',
] as const;

/** Refusals no amount of waiting will fix. The loop stops rather than spinning
 * a broken configuration forever — systemd's restart policy and an operator are
 * the correct escalation, not another pass. */
export const WORKER_FATAL_RESULTS_V1 = ['decoder_mismatch', 'configuration_required'] as const;

export interface WorkerDelayInputV1 {
  signal: WorkerPassSignalV1;
  cadence: WorkerCadenceV1;
  /** How many consecutive backoff-worthy results have happened, including this
   * one. 0 when the last pass was fine. */
  consecutiveFailures: number;
  /** Discovery only: more than this behind means keep going without resting. */
  catchUpThresholdBlocks: number;
}

/** The whole cadence policy, as one pure function. */
export function nextWorkerDelayMsV1(input: WorkerDelayInputV1): number {
  const { signal, cadence } = input;

  if ((WORKER_BACKOFF_RESULTS_V1 as readonly string[]).includes(signal.result)) {
    // Exponential, capped. A provider that is down stays down for minutes, and
    // hammering it makes the recovery slower for everybody.
    const exponent = Math.max(0, input.consecutiveFailures - 1);
    return Math.min(cadence.maxBackoffMs, cadence.backoffMs * 2 ** Math.min(exponent, 10));
  }

  // Another worker holds the lease. Not a failure and not work: come back soon
  // enough to take over promptly if that worker dies mid-pass.
  if (signal.result === 'run_already_active') return cadence.catchUpMs * 4;

  // The pass stopped at its own ceiling, so there is definitely more.
  if (signal.budgetExhausted === true) return cadence.catchUpMs;

  // Still a long way from head: keep going rather than resting between passes.
  if (typeof signal.blocksBehind === 'number' && signal.blocksBehind > input.catchUpThresholdBlocks) {
    return cadence.catchUpMs;
  }

  // Work was done and there may be more of it queued behind.
  if (signal.didWork === true) return cadence.catchUpMs;

  return cadence.idleMs;
}

export interface WorkerLoopInputV1 {
  /** One bounded pass. Never called concurrently with itself. */
  pass: () => Promise<WorkerPassSignalV1>;
  cadence: WorkerCadenceV1;
  catchUpThresholdBlocks: number;
  wait: (ms: number) => Promise<void>;
  /** Checked before every pass and again before every sleep, so a stop signal
   * never has to wait out an idle period. */
  shouldContinue: () => boolean;
  /** Safe, structured. Never an endpoint and never a credential. */
  log: (entry: { event: string; result: string; delayMs: number; consecutiveFailures: number }) => void;
  /** Bounds a test. Undefined in production, which is the point of a service. */
  maxPasses?: number;
}

export interface WorkerLoopSummaryV1 {
  passes: number;
  stoppedBecause: 'signal' | 'fatal' | 'max_passes';
  lastResult: string | null;
}

export async function runWorkerLoopV1(input: WorkerLoopInputV1): Promise<WorkerLoopSummaryV1> {
  let passes = 0;
  let consecutiveFailures = 0;
  let lastResult: string | null = null;

  while (input.shouldContinue()) {
    if (input.maxPasses !== undefined && passes >= input.maxPasses) {
      return { passes, stoppedBecause: 'max_passes', lastResult };
    }

    const signal = await input.pass();
    passes += 1;
    lastResult = signal.result;

    const backoffWorthy = (WORKER_BACKOFF_RESULTS_V1 as readonly string[]).includes(signal.result);
    consecutiveFailures = backoffWorthy ? consecutiveFailures + 1 : 0;

    const delayMs = nextWorkerDelayMsV1({
      signal,
      cadence: input.cadence,
      consecutiveFailures,
      catchUpThresholdBlocks: input.catchUpThresholdBlocks,
    });
    input.log({ event: 'b20_worker_pass', result: signal.result, delayMs, consecutiveFailures });

    if ((WORKER_FATAL_RESULTS_V1 as readonly string[]).includes(signal.result)) {
      // Nothing this loop can do next will be different. Exiting hands the
      // decision to whoever configured it, which is where it belongs.
      return { passes, stoppedBecause: 'fatal', lastResult };
    }

    if (!input.shouldContinue()) break;
    await input.wait(delayMs);
  }

  return { passes, stoppedBecause: 'signal', lastResult };
}

/** SIGTERM and SIGINT stop the loop after the pass in flight, so systemd's stop
 * is clean and never interrupts a commit. */
export function installStopSignalsV1(onStop: () => void): () => void {
  const handler = (): void => onStop();
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}

export const sleepV1 = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
