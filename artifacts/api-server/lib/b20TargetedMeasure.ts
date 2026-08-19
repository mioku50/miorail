import type { B20ObservationRepositoryV1 } from '@mioagent/route-storage';

import {
  measureB20LaunchOnceV1,
  type B20MeasureOneInputV1,
  type B20MeasureTargetV1,
} from '../../../scripts/b20MeasureRun.js';

// ---------------------------------------------------------------------------
// Measurement taken because a reader asked, not because a queue arrived.
//
// Discover's worker measures the newest launches, bounded by a 48-hour age
// window. That bound is right for a FEED — a background pass that walked the
// whole chain would spend a metered endpoint on 33,000 launches nobody is
// looking at — and it is wrong for a person who has just pasted an address.
// The result was a console that answered "No stored measurement" for a token
// it had never once tried to measure, which is technically true and reads as a
// finding about the token.
//
// So Investigate takes the reading itself. Three properties make that safe,
// and none of them is new:
//
//   IT IS THE SAME PASS. `measureB20LaunchOnceV1` is the function the worker
//   calls, with the same reference profile and the same refusals. There is no
//   second definition of what an observation is, and no path that could anchor
//   a factory read and a control read at different blocks.
//
//   IT IS READ-ONLY. No signer, no key, no wallet, no allowance, no state
//   override, no broadcast. The only write is the immutable observation row the
//   worker would have written.
//
//   IT IS BOUNDED, AND THE BOUND IS ITS OWN. A wall-clock budget per request,
//   a cap on how many tokens one request may measure, and an in-process map so
//   two readers asking about the same token share one measurement instead of
//   paying twice. It takes no measure lease: the lease exists so two WORKERS do
//   not walk the same queue, and this walks no queue — holding it would stop
//   the feed for as long as one reader waited.
//
// What it must never do is report Miorail's own limit as a fact about a token.
// That is why the outcome below is an enum and not a boolean: "the endpoint did
// not answer", "the reading did not complete", and "there is no launch to
// measure" are three different sentences, and only the middle one is even
// partly about the token.
// ---------------------------------------------------------------------------

export const B20_TARGETED_MEASURE_OUTCOMES_V1 = [
  /** An observation was written, or an identical one already existed at this
   * block. The card is now current. */
  'measured',
  /** The pass ran and stored an `unmeasured` row. `reason` names the gap. */
  'measurement_incomplete',
  /** No anchor, so NOTHING was stored. Not a statement about the token. */
  'provider_unavailable',
  /** Miorail holds no canonical launch row, so there is nothing to measure
   * here. Identity is a separate question and is answered separately. */
  'not_indexed',
  /** The budget ran out while this token was still being read. The reading
   * continues in the background and the row appears when it lands. */
  'timed_out',
  /** The reading threw. Counted, named, and never turned into a verdict. */
  'failed',
  /** An earlier token in the same request spent the budget. */
  'not_attempted',
  /** Not enabled on this server, or no endpoint configured. */
  'unavailable_here',
] as const;
export type B20TargetedMeasureOutcomeV1 = (typeof B20_TARGETED_MEASURE_OUTCOMES_V1)[number];

export interface B20TargetedMeasureResultV1 {
  tokenAddress: string;
  outcome: B20TargetedMeasureOutcomeV1;
  /**
   * The stored reason behind an incomplete reading, in the measurement's own
   * vocabulary — `route_search_degraded`, `no_entry_route`, and so on.
   *
   * Null for every other outcome. Deliberately not a sentence: the answer
   * builder owns the words, and a reason code that arrived pre-phrased would
   * be a second place where a gap gets described.
   */
  reason: string | null;
  /** How long the attempt took, so an operator can see what a reader waited. */
  elapsedMs: number;
}

/**
 * How long ONE request may spend taking readings.
 *
 * A single measurement is a route search plus roughly fifteen paced control
 * calls; measured against the public endpoint that is tens of seconds, and
 * against a paid one it is a few. The budget is wall-clock rather than a call
 * count because what a reader is spending is their own attention.
 *
 * When it runs out the reading is NOT cancelled — the promise keeps going and
 * writes its row when it lands, so the next question about that token finds it.
 * The reader is told that, rather than being told the token has no measurement.
 */
export function b20TargetedMeasureBudgetMsV1(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.MIORAIL_B20_TARGETED_MEASURE_BUDGET_MS ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

/**
 * How many tokens one request may cause a reading of.
 *
 * Investigate compares up to five. Five readings is five times the spend and
 * five times the wait, and the budget above would stop it anyway — this makes
 * the bound explicit rather than emergent, so the tokens past it are reported
 * as `not_attempted` instead of silently sharing a deadline.
 */
export const B20_TARGETED_MEASURE_MAX_PER_REQUEST_V1 = 2;

/**
 * Readings currently running, keyed by token address.
 *
 * In-process and deliberately so: it is not a distributed lock and does not
 * pretend to be one. Two API processes measuring the same token at the same
 * block both find the identical observation already stored and write nothing —
 * the immutable identity handles correctness. This handles COST, which is the
 * common case: a reader who reloads, or two readers looking at the same card.
 */
const inFlightV1 = new Map<string, Promise<B20TargetedMeasureResultV1>>();

/** Visible for tests, and for a server that wants to start clean. */
export function b20TargetedMeasureInFlightCountV1(): number {
  return inFlightV1.size;
}

export interface B20TargetedMeasureInputV1 {
  launch: B20MeasureTargetV1;
  pass: B20MeasureOneInputV1;
  /** Wall clock, injected so a test can make a reading run long without also
   * moving the timestamps on the observation it writes. */
  monotonicMs?: () => number;
  budgetMs: number;
}

/**
 * Measures one named token, or says exactly why it did not.
 *
 * Never throws: every failure becomes an outcome, because a reading that could
 * not be taken must not take down an answer whose other half is fine.
 */
export async function measureB20TokenOnDemandV1(
  input: B20TargetedMeasureInputV1,
): Promise<B20TargetedMeasureResultV1> {
  const monotonic = input.monotonicMs ?? (() => Date.now());
  const tokenAddress = input.launch.tokenAddress.toLowerCase();
  const startedAt = monotonic();

  // Join a reading already in flight rather than starting a second. The first
  // caller's budget governs how long IT waits; this caller still gets its own
  // deadline below.
  let reading = inFlightV1.get(tokenAddress);
  if (!reading) {
    reading = (async (): Promise<B20TargetedMeasureResultV1> => {
      try {
        const measured = await measureB20LaunchOnceV1({ launch: input.launch, input: input.pass });
        if (!measured.candidate) {
          // The anchor did not read, so nothing was stored. The pass is
          // explicit that an observation with no block is a measurement of no
          // particular moment — and this is the branch that must never become
          // a sentence about the token.
          return { tokenAddress, outcome: 'provider_unavailable', reason: null, elapsedMs: monotonic() - startedAt };
        }
        return {
          tokenAddress,
          outcome: measured.candidate.state === 'unmeasured' ? 'measurement_incomplete' : 'measured',
          reason: measured.candidate.state === 'unmeasured' ? measured.candidate.reasonCode : null,
          elapsedMs: monotonic() - startedAt,
        };
      } catch {
        // The reason is NOT carried out of here. `measureFailureReasonV1`
        // scrubs a message for an operator log; this value reaches a reader,
        // and a scrubbed provider error is still a provider error's shape.
        return { tokenAddress, outcome: 'failed', reason: null, elapsedMs: monotonic() - startedAt };
      } finally {
        inFlightV1.delete(tokenAddress);
      }
    })();
    inFlightV1.set(tokenAddress, reading);
  }

  const timeout = new Promise<B20TargetedMeasureResultV1>((resolve) => {
    const timer = setTimeout(
      () => resolve({ tokenAddress, outcome: 'timed_out', reason: null, elapsedMs: monotonic() - startedAt }),
      input.budgetMs,
    );
    // A pending timer must not hold the process open after the answer has been
    // sent — this runs inside a request, not inside a worker loop.
    timer.unref?.();
  });
  return Promise.race([reading, timeout]);
}

/**
 * Whether a stored observation is current enough to answer with.
 *
 * `staleAfter` is the measurement's own statement about itself, written when
 * it was taken, so this reads the row rather than re-deciding the policy. A
 * row with no observation is not stale — it is absent, and the two produce
 * different sentences.
 */
export function b20ObservationNeedsRefreshV1(input: {
  observation: { staleAfter: string } | null;
  now: Date;
}): boolean {
  if (!input.observation) return true;
  const staleAfter = Date.parse(input.observation.staleAfter);
  return !Number.isFinite(staleAfter) || staleAfter <= input.now.getTime();
}

export type { B20ObservationRepositoryV1 };
