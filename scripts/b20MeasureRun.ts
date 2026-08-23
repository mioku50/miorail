import {
  B20_MEASUREMENT_VERSION_V1,
  assertObservationV1,
  capacitySamplesHashV1,
  observationEvidenceHashV1,
  observationIdV1,
  type B20MeasurableLaunchV1,
  type B20ObservationRepositoryV1,
  type B20OpportunityObservationV1,
} from '@mioagent/route-storage';
import {
  b20ObservationVerdictV1,
  coverageV1,
  exitCapacityV1,
  exitLadderStableV1,
  profileIdentityV1,
  roundTripV1,
  type B20CheapFilterResultV1,
  type B20MeasurementQuoteAssetV1,
  type B20ObservationControlsV1,
  type B20QuoteAlignmentV1,
  type B20TransferPolicyStateV1,
  type OpportunityProfileV2,
  MEASURED_MOVE_BASELINE_AGE_MS_V1,
  MEASURED_MOVE_BASELINE_TOLERANCE_MS_V1,
} from '@mioagent/opportunity-rail';

// ---------------------------------------------------------------------------
// T69-B §3/§4/§5/§12/§14 — one bounded measurement pass.
//
// Every dependency is injected: the repository, the four measurement steps and
// the clock. Nothing here opens a socket or reads an environment variable, so
// the whole state machine is testable without a network or a database — which
// matters more than usual, because the thing being tested is what this worker
// is allowed to CONCLUDE about tokens nobody asked it to look at.
//
// THE ORDER OF THE FOUR STEPS IS THE DESIGN:
//
//   1. anchor    — one block, so every anchored fact describes one moment
//   2. factory   — nothing else applies to an address the factory disowns, and
//                  it costs two calls to find out
//   3. routes    — the cheap economic filter, before any deep control read
//   4. controls  — ~15 paced calls, spent only on tokens that got this far
//
// Reversing 3 and 4 would spend the expensive read on every token that turns
// out to have no pool. Reversing 2 and 3 would spend router calls on addresses
// that are not B20 tokens at all.
//
// AND THE RULE THAT OUTRANKS ALL OF THEM: a provider that did not answer is
// never a verdict about a token. Every degraded path below lands on
// `unmeasured`, never on `rejected`.
// ---------------------------------------------------------------------------

export const B20_MEASURE_RESULTS_V1 = [
  'success',
  'nothing_eligible',
  'budget_exhausted',
  'endpoint_unavailable',
  'storage_unavailable',
  'run_already_active',
] as const;
export type B20MeasureResultV1 = (typeof B20_MEASURE_RESULTS_V1)[number];

export interface MeasurePassConfigV1 {
  /** §3 — every one of these bounds something a timer would otherwise spend
   * without asking. */
  maxLaunches: number;
  maxDeepCandidates: number;
  maxRouterCalls: number;
  maxControlCalls: number;
  maxRuntimeMs: number;
  maxRetries: number;
  maxConcurrentCandidates: number;
  /** §11 — freshness policy. */
  observationStaleMs: number;
  minReMeasureIntervalMs: number;
  maxLaunchAgeMs: number;
  /**
   * Deep candidates reserved for the pair-forming queue. Optional while a
   * caller rolls forward; absent behaves as zero, which is exactly the old
   * single-queue pass.
   */
  pairRemeasureCandidates?: number;
  leaseTtlMs: number;
  /** The feed's reference measurement parameters. NOT a user qualification. */
  profile: OpportunityProfileV2;
}

/** One block, named, that every anchored fact in an observation refers to. */
export interface ObservationAnchorV1 {
  blockNumber: string;
  blockHash: string;
  /** The tag every pinned read uses. Carried rather than re-derived per call,
   * so the factory read and the control read cannot end up on different
   * blocks through two different conversions. */
  blockTag: string;
}

export interface FactoryStatusV1 {
  /** Null when the read did not answer — never false. "The factory said no" and
   * "nobody answered" are different facts and only one is about the token. */
  isB20: boolean | null;
  initialized: boolean | null;
}

export interface RouteMeasurementV1 {
  entryRouteFound: boolean;
  exitRouteFound: boolean;
  /** A read failed for a reason that is not "no such pool". */
  degraded: boolean;
  candidatesTotal: number;
  candidatesAnswered: number;
  entryOutputAtomic: string | null;
  exitReturnAtomic: string | null;
  entryRouteHash: string | null;
  exitRouteHash: string | null;
  entrySourceKey: string | null;
  exitSourceKey: string | null;
  /** The Uniswap v4 hook on the pool this was measured in, or null when the
   * venue has none. Its permissions are readable from the address alone, and
   * with `fee = 0` on every B20 pool sampled, the hook is the only thing that
   * can set what an exit costs. */
  poolHookAddress: string | null;
  /** The exit-capacity ladder, already priced. Sizes are in the TOKEN. */
  probes: { sizeAtomic: string; slippageBps: number | null }[];
  /**
   * Which venue families this reading actually asked, in order.
   *
   * `routeCoverage` says whether the candidates a search generated all
   * answered. It cannot say which venues the search covered — and for 1,662
   * stored launches the answer is "not the one where B20 tokens trade", while
   * the row claims complete coverage. This records the set so a card can state
   * it instead of implying it.
   */
  venuesConsulted: string[];
  routerCalls: number;
  /** What was ACTUALLY spent, and in what.
   *
   * The profile names one quote asset, but a venue does not have to offer it:
   * B20's v4 pools are quoted against native ETH, and spending a USDC-
   * denominated position there buys the same NUMBER of wei — a dust trade
   * filed as a hundred-dollar measurement. Every observation now records the
   * pair it was measured in, so a card can only ever state what happened. */
  quoteAssetUsed: B20MeasurementQuoteAssetV1;
  positionAtomicUsed: string;
  /** Whether the quotes behind these numbers were read at the observation
   * block, decided by what actually happened rather than declared up front.
   *
   * It used to be a constant on the deps, set to `latest_not_anchored` because
   * Aerodrome's reader takes no block tag — and it stayed a constant after the
   * measurement moved to Uniswap v4, whose Quoter is an ordinary `eth_call`
   * that anchors fine. Every observation therefore carried a caveat about
   * mixed-block data that was no longer true, on data that no longer needed
   * it. Per measurement, because one pass can anchor and the next can fall
   * back. */
  quoteAlignment: B20QuoteAlignmentV1;
}

export interface ControlMeasurementV1 {
  controls: B20ObservationControlsV1;
  snapshotHash: string | null;
  blockNumber: string | null;
  controlCalls: number;
}

export interface MeasurementDepsV1 {
  /** §4. Null when the anchor could not be read — and then NOTHING is stored. */
  readAnchor(): Promise<ObservationAnchorV1 | null>;
  /** Who bought out of the pool in the launch's own window, measured once and
   * cached. Optional: a worker without it still measures routes exactly as
   * before. Its return value is unused here — the row is the point. */
  measureLaunchBuyers?(input: {
    tokenAddress: string;
    launchBlock: number;
    observedHead: number;
  }): Promise<unknown>;
  readFactoryStatus(input: {
    tokenAddress: string;
    anchor: ObservationAnchorV1;
  }): Promise<FactoryStatusV1>;
  analyseRoutes(input: {
    tokenAddress: string;
    /** The block the launch was detected in. B20 pools are initialised in the
     * same ten-block window, which is the only affordable way to find one on
     * an endpoint that caps `eth_getLogs` at ten blocks. */
    launchBlock: number;
    profile: OpportunityProfileV2;
    /** The observation's block. Quotes are pinned to it where the venue
     * allows, which is what lets an observation describe one moment instead
     * of two. */
    anchor: ObservationAnchorV1;
  }): Promise<RouteMeasurementV1>;
  /** Null when the deep read could not run at all. */
  readControls(input: {
    tokenAddress: string;
    anchor: ObservationAnchorV1;
  }): Promise<ControlMeasurementV1 | null>;
  /** The alignment to record when NO quote was taken — the factory settled
   * the token before any router call. `RouteMeasurementV1.quoteAlignment` is
   * the real answer whenever quotes actually happened. */
  quoteAlignment: B20QuoteAlignmentV1;
}

export interface MeasuredCandidateV1 {
  launchId: string;
  tokenAddress: string;
  state: B20OpportunityObservationV1['state'];
  reasonCode: string | null;
  stored: boolean;
}

export interface MeasurePassOutcomeV1 {
  result: B20MeasureResultV1;
  eligible: number;
  attempted: number;
  observationsWritten: number;
  /** Already observed at this exact block, version and profile. A retry is
   * free, and this counts how often that happened. */
  idempotentRepeats: number;
  /** §3/§14 — selected but never attempted. NOT `unmeasured`: nothing was
   * measured, so nothing may be recorded. */
  notChecked: number;
  /** Candidates whose measurement threw. One broken token must not starve the
   * rest, so these are counted and skipped. */
  failed: number;
  /** The distinct reasons behind `failed`, de-duplicated. Bounded and scrubbed
   * of addresses, hex and URLs by `measureFailureReasonV1`: this is written to
   * a log on every pass, and an endpoint or a token address does not belong
   * there. */
  failureReasons: string[];
  routerCalls: number;
  controlCalls: number;
  budgetExhausted: boolean;
  byState: Record<string, number>;
  candidates: MeasuredCandidateV1[];
  /** How many of `eligible` came from the pair-forming queue. Logged on every
   * pass, because "the movers rail is filling" is otherwise unobservable until
   * a day later. */
  pairRemeasures: number;
}

/**
 * Everything one measurement needs, and nothing a PASS needs.
 *
 * Split out from `MeasurePassInputV1` so a single launch can be measured
 * without a queue, a lease or a budget spread across candidates — which is
 * what a reader pasting an address into Investigate is asking for. The lease
 * belongs to the pass: it exists so two WORKERS do not walk the same queue,
 * and a targeted read walks no queue at all.
 */
export interface B20MeasureOneInputV1 {
  observations: B20ObservationRepositoryV1;
  deps: MeasurementDepsV1;
  config: MeasurePassConfigV1;
  now: () => Date;
}

export interface MeasurePassInputV1 extends B20MeasureOneInputV1 {
  owner: string;
}

/**
 * A failure reason fit to be logged on every pass.
 *
 * Scrubbed and bounded: hex runs (addresses, hashes, calldata), URLs and
 * anything long are removed, because this string is written to a service log
 * and an RPC endpoint or a token address does not belong there. What survives
 * is the part that identifies the BUG — "new row violates check constraint
 * b20_observations_quote_asset_check" — which is the whole point.
 */
export function measureFailureReasonV1(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
  return raw
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/0x[0-9a-fA-F]{8,}/g, '[hex]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The transfer-policy rows a snapshot may carry. */
const TRANSFER_POLICY_KEYS_V1 = [
  'transfer_sender_policy',
  'transfer_receiver_policy',
  'transfer_executor_policy',
] as const;

/**
 * §9 — the transfer-policy state, read from the control snapshot.
 *
 * Three distinctions this function exists to keep:
 *
 *   * ALWAYS_ALLOW IS THE OPEN VALUE, not a restriction. Treating it as a gate
 *     would flag nearly every token on the chain.
 *   * `unavailable` (a read that FAILED) is not `unsupported_by_variant` (a
 *     method this variant does not have). One means something went wrong, the
 *     other is permanent and expected, and fusing them would make a fully-read
 *     stablecoin indistinguishable from a throttled one.
 *   * A restricted policy is REPORTED, never resolved. B20 cannot enumerate
 *     who a policy admits, and there is no wallet here to check against it.
 *
 * Lives here rather than in the entry script so it can be imported — and
 * tested — without running a worker.
 */
export function transferPolicyStateV1(snapshot: {
  fields: readonly { key: string; status: string; value: string | null }[];
}): B20TransferPolicyStateV1 {
  const rows = snapshot.fields.filter((field) =>
    (TRANSFER_POLICY_KEYS_V1 as readonly string[]).includes(field.key),
  );
  if (rows.length === 0) return 'unsupported_by_variant';
  if (rows.some((field) => field.status === 'unavailable')) return 'unavailable';
  const readable = rows.filter((field) => field.status === 'exact_chain_read');
  if (readable.length === 0) return 'unsupported_by_variant';
  const restricted = readable.some((field) => field.value !== null && !field.value.startsWith('ALWAYS_ALLOW'));
  return restricted ? 'restricted' : 'open';
}

/**
 * §5 — the cheap filter, from the factory and route reads.
 *
 * The order of these branches is what keeps an outage from becoming a verdict:
 * a null factory read is `route_search_degraded` (unmeasured), never `not_b20`.
 */
export function cheapFilterResultV1(input: {
  factory: FactoryStatusV1;
  routes: RouteMeasurementV1 | null;
}): B20CheapFilterResultV1 {
  // A read that did not answer says nothing about the token.
  if (input.factory.isB20 === null) return 'route_search_degraded';
  if (input.factory.isB20 === false) return 'not_b20';
  if (input.factory.initialized === null) return 'route_search_degraded';
  if (input.factory.initialized === false) return 'uninitialized';
  if (!input.routes) return 'route_search_degraded';
  // Degradation is checked BEFORE the missing-route branches: a throttled
  // search that found nothing must never render as "no route exists".
  if (input.routes.degraded) return 'route_search_degraded';
  if (!input.routes.entryRouteFound) return 'no_entry_route';
  if (!input.routes.exitRouteFound) return 'no_exit_route';
  if (input.routes.entryOutputAtomic === null || input.routes.exitReturnAtomic === null) {
    return 'quote_unavailable';
  }
  return 'candidate';
}

/** One bounded pass over the launches that are due. */
export async function runB20MeasurePassV1(input: MeasurePassInputV1): Promise<MeasurePassOutcomeV1> {
  const startedAt = input.now();
  const deadline = startedAt.getTime() + input.config.maxRuntimeMs;
  const outcome: MeasurePassOutcomeV1 = {
    result: 'success',
    eligible: 0,
    attempted: 0,
    observationsWritten: 0,
    idempotentRepeats: 0,
    notChecked: 0,
    failed: 0,
    failureReasons: [],
    routerCalls: 0,
    controlCalls: 0,
    budgetExhausted: false,
    byState: {},
    candidates: [],
    pairRemeasures: 0,
  };

  // §13 — a lease of its own. The ingestion worker must keep reading launches
  // while this one is gathering quotes, so the two never share a lock.
  const lease = await input.observations.acquireMeasureLease({
    owner: input.owner,
    now: startedAt.toISOString(),
    ttlMs: input.config.leaseTtlMs,
  });
  if (!lease) return { ...outcome, result: 'run_already_active' };

  try {
    // ── Two queues, and the order between them is the whole fix ─────────────
    //
    // The primary queue is newest-first and stays that way. What it cannot do
    // is come back: with launches arriving faster than the pass can measure
    // them, its head was never older than forty minutes, so a token measured
    // once was never measured again and no pair 24 hours apart could form.
    //
    // The reserved queue holds launches that are ONE measurement away from such
    // a pair, oldest measurement first. It goes FIRST in `eligible` because the
    // budget is spent from the front — a reservation that sits behind 25 newer
    // candidates is not a reservation. It is short by construction, so this
    // costs the primary queue nothing on a pass where nothing is due.
    const pairBudget = Math.max(
      0,
      Math.min(input.config.pairRemeasureCandidates ?? 0, input.config.maxDeepCandidates),
    );
    const pairQueue =
      pairBudget === 0
        ? []
        : await input.observations.selectRemeasurableLaunches({
            limit: pairBudget,
            maxLaunchAgeMs: input.config.maxLaunchAgeMs,
            pairAgeMs: MEASURED_MOVE_BASELINE_AGE_MS_V1,
            pairToleranceMs: MEASURED_MOVE_BASELINE_TOLERANCE_MS_V1,
            now: startedAt.toISOString(),
          });
    const primary = await input.observations.selectMeasurableLaunches({
      limit: input.config.maxLaunches,
      maxLaunchAgeMs: input.config.maxLaunchAgeMs,
      minReMeasureIntervalMs: input.config.minReMeasureIntervalMs,
      now: startedAt.toISOString(),
    });
    // De-duplicated on launch id: both queries read the same table, and a
    // launch that is due on both counts must not be measured twice in one pass.
    const seen = new Set(pairQueue.map((launch) => launch.launchId));
    const eligible = [...pairQueue, ...primary.filter((launch) => !seen.has(launch.launchId))];
    outcome.eligible = eligible.length;
    outcome.pairRemeasures = pairQueue.length;
    if (eligible.length === 0) return { ...outcome, result: 'nothing_eligible' };

    const chunk = Math.max(1, Math.min(8, input.config.maxConcurrentCandidates));
    let index = 0;
    while (index < eligible.length) {
      // Budgets are checked BETWEEN chunks. Within one chunk the router-call
      // count can overshoot by at most `chunk - 1` candidates' worth. That
      // overshoot was why the default concurrency was 1: on a METERED endpoint
      // the exact count is the thing being bounded. This worker reads a free
      // public endpoint now, so an overshoot of a few calls costs nothing and
      // `maxRouterCalls` still stops the pass. See the measurement recorded on
      // `maxConcurrentCandidates` in b20MeasureCli.ts for the endpoint's real
      // ceiling.
      if (
        input.now().getTime() > deadline ||
        outcome.routerCalls >= input.config.maxRouterCalls ||
        outcome.controlCalls >= input.config.maxControlCalls ||
        outcome.attempted >= input.config.maxDeepCandidates
      ) {
        outcome.budgetExhausted = true;
        break;
      }

      const slice = eligible.slice(index, index + chunk);
      index += slice.length;
      const measured = await Promise.all(
        slice.map(async (launch) => {
          try {
            return await measureOneV1({ launch, input });
          } catch (error) {
            // §16.29 — one broken token must not starve the rest. The failure
            // is counted and the pass moves on; nothing is written, because
            // nothing was measured.
            //
            // The REASON travels with it. A pass reporting `failed: 10` and
            // nothing else is indistinguishable from ten different bugs, and a
            // schema change that every token trips looks exactly like ten
            // unlucky tokens — which is how a constraint violation ran for
            // minutes before anyone could name it.
            return { failed: true as const, launch, reason: measureFailureReasonV1(error) };
          }
        }),
      );

      for (const result of measured) {
        outcome.attempted += 1;
        if ('failed' in result) {
          outcome.failed += 1;
          if (!outcome.failureReasons.includes(result.reason)) outcome.failureReasons.push(result.reason);
          continue;
        }
        outcome.routerCalls += result.routerCalls;
        outcome.controlCalls += result.controlCalls;
        if (!result.candidate) continue;
        outcome.candidates.push(result.candidate);
        outcome.byState[result.candidate.state] = (outcome.byState[result.candidate.state] ?? 0) + 1;
        if (result.candidate.stored) outcome.observationsWritten += 1;
        else outcome.idempotentRepeats += 1;
      }
    }

    // §3/§14 — selected but never reached. `not_checked`, and deliberately not
    // an observation: nothing was measured, so there is nothing to record.
    outcome.notChecked = Math.max(0, eligible.length - outcome.attempted);
    if (outcome.notChecked > 0) outcome.budgetExhausted = true;
    return { ...outcome, result: outcome.budgetExhausted ? 'budget_exhausted' : 'success' };
  } finally {
    // Always. A crashed worker holding the lease would stop measurement until
    // the TTL expired, and the TTL is a backstop rather than the mechanism.
    await input.observations.releaseMeasureLease({
      owner: input.owner,
      now: input.now().toISOString(),
    });
  }
}

export interface MeasuredOneV1 {
  candidate: MeasuredCandidateV1 | null;
  routerCalls: number;
  controlCalls: number;
}

/**
 * The three fields a measurement reads off a launch.
 *
 * Narrower than `B20MeasurableLaunchV1` on purpose: the rest of that record —
 * ingestion source, last measurement, detection time — is how the QUEUE picks
 * what to look at next, and a caller who already knows which token they want
 * should not have to fabricate any of it.
 */
export type B20MeasureTargetV1 = Pick<
  B20MeasurableLaunchV1,
  'launchId' | 'tokenAddress' | 'blockNumber'
>;

/**
 * One launch, measured once, through the pipeline that measures every other.
 *
 * Exported so the console can measure a token a reader named. That is the
 * whole point of exporting it: the alternative — a second measurement path
 * next to this one — would be a second definition of what an observation IS,
 * and the first thing to drift would be which block the factory read and the
 * control read were anchored at.
 *
 * Everything this function refuses still holds when it is called from a
 * request: nothing is stored without an anchor, a provider that did not answer
 * is never a verdict, and an identical observation at the same block is read
 * rather than re-measured.
 */
export async function measureB20LaunchOnceV1(context: {
  launch: B20MeasureTargetV1;
  input: B20MeasureOneInputV1;
}): Promise<MeasuredOneV1> {
  return measureOneV1(context);
}

async function measureOneV1(context: {
  launch: B20MeasureTargetV1;
  input: B20MeasureOneInputV1;
}): Promise<MeasuredOneV1> {
  const { launch, input } = context;
  const { config, deps } = input;

  // --- §4 — one block anchor, first. ---------------------------------------
  const anchor = await deps.readAnchor();
  if (!anchor) {
    // NOTHING is stored. An observation with no block is a measurement of no
    // particular moment, which is not a measurement.
    return { candidate: null, routerCalls: 0, controlCalls: 0 };
  }

  const profileIdentity = profileIdentityV1(config.profile);
  const identity = {
    launchId: launch.launchId,
    observationBlockNumber: anchor.blockNumber,
    measurementVersion: B20_MEASUREMENT_VERSION_V1,
    profileIdentity,
  };
  // §2/§13 — already measured at this exact block under these exact rules.
  // Re-measuring would spend ~20 metered calls to learn what is already stored.
  const existing = await input.observations.getObservation(observationIdV1(identity));
  if (existing) {
    return {
      candidate: {
        launchId: launch.launchId,
        tokenAddress: launch.tokenAddress,
        state: existing.state,
        reasonCode: existing.reasonCode,
        stored: false,
      },
      routerCalls: 0,
      controlCalls: 0,
    };
  }

  // --- §5 step 1/2 — the factory, before any router call. ------------------
  const factory = await deps.readFactoryStatus({ tokenAddress: launch.tokenAddress, anchor });

  // --- §5 steps 3–5 — the cheap route search, before the deep control read.
  // Skipped entirely when the factory already settled it: spending router
  // calls on an address the factory disowns buys nothing.
  const factorySettled = factory.isB20 === false || factory.initialized === false;
  const routes = factorySettled
    ? null
    : await deps.analyseRoutes({
        tokenAddress: launch.tokenAddress,
        launchBlock: Number(launch.blockNumber),
        profile: config.profile,
        anchor,
      });
  const cheapFilter = cheapFilterResultV1({ factory, routes });

  // §— launch-window buying, measured once per token and then cached forever.
  //
  // Deliberately AFTER the route search and never blocking it: this is context
  // about a launch, not a measurement of it, and a failure here must not cost
  // an observation. It costs one `eth_getLogs` on the first pass that finds
  // the window closed, and nothing on every pass after.
  if (deps.measureLaunchBuyers && !factorySettled) {
    try {
      await deps.measureLaunchBuyers({
        tokenAddress: launch.tokenAddress,
        launchBlock: Number(launch.blockNumber),
        observedHead: Number(anchor.blockNumber),
      });
    } catch {
      // Swallowed on purpose. The observation below is the product; this is a
      // note in its margin.
    }
  }

  // --- §9 — the deep control read, ONLY after the economics survived. ------
  const controlMeasurement =
    cheapFilter === 'candidate' ? await deps.readControls({ tokenAddress: launch.tokenAddress, anchor }) : null;

  const routerCalls = routes?.routerCalls ?? 0;
  const controlCalls = controlMeasurement?.controlCalls ?? 0;

  const roundTrip =
    routes && routes.entryOutputAtomic !== null && routes.exitReturnAtomic !== null
      ? roundTripV1({
          entry: {
            provider: 'aerodrome',
            // What was SPENT, not what the profile asked for. The two differ
            // on any venue that does not quote the profile's asset, and using
            // the profile's number here compares a return in wei against an
            // input in USDC atoms: the return dwarfs it, the loss reads as a
            // gain, and the cost is clamped to a flattering 0 bps. Measured on
            // mainnet, that turned a 449 bps round trip into "costs nothing".
            inputAtomic: routes.positionAtomicUsed,
            outputAtomic: routes.entryOutputAtomic,
          },
          exit: {
            provider: 'aerodrome',
            inputAtomic: routes.entryOutputAtomic,
            outputAtomic: routes.exitReturnAtomic,
          },
          // Always. The exit was quoted against the pool BEFORE the entry moved
          // it, and that label is what stops a bound being read as a result.
          measurement: 'quoted_pre_entry',
        })
      : null;

  // The probes arrive already priced — `priceImpactLadderV1` runs in the
  // adapter that quoted them, next to the router results it needs. Capacity
  // here is computed from those typed samples by the one shared implementation.
  const probes = routes?.probes ?? [];
  const capacity = probes.length > 0 ? exitCapacityV1(probes, config.profile.maxExitSlippageBps) : null;
  const capacityStable = probes.length > 0 ? exitLadderStableV1(probes, config.profile.maxExitSlippageBps) : null;

  const coverage = coverageV1({
    candidatesTotal: routes?.candidatesTotal ?? 0,
    candidatesAnswered: routes?.candidatesAnswered ?? 0,
    // A route this search actually priced end to end. Not a simulation — this
    // worker has no wallet — which is exactly why the verdict below can never
    // be better than provisional.
    simulationProvedRoute: Boolean(routes?.entryRouteFound && routes?.exitRouteFound && roundTrip),
  });

  const controls = controlMeasurement?.controls ?? null;
  const verdict = b20ObservationVerdictV1({
    profile: config.profile,
    cheapFilter,
    controls,
    coverage,
    roundTrip,
    exitCapacity: capacity,
    acquiredAtomic: routes?.entryOutputAtomic ?? null,
  });

  const measuredAt = input.now().toISOString();
  const draft = {
    launchId: launch.launchId,
    chainId: 8453 as const,
    tokenAddress: launch.tokenAddress,
    // The pair actually measured, not the one the profile asked for. They
    // differ wherever the venue does not quote the profile's asset, and the
    // stored row has to describe the trade that was priced.
    referenceQuoteAsset: routes?.quoteAssetUsed ?? config.profile.quoteAsset,
    referencePositionAtomic: routes?.positionAtomicUsed ?? config.profile.positionAtomic,
    maxRoundTripBps: config.profile.maxRoundTripBps,
    maxExitSlippageBps: config.profile.maxExitSlippageBps,
    profileIdentity,
    state: verdict.state,
    reasonCode: 'reason' in verdict ? verdict.reason : null,
    factoryConfirmed: factory.isB20 === true,
    initialized: factory.initialized === true,
    entryRouteFound: routes?.entryRouteFound ?? false,
    exitRouteFound: routes?.exitRouteFound ?? false,
    entryRouteHash: routes?.entryRouteHash ?? null,
    exitRouteHash: routes?.exitRouteHash ?? null,
    entrySourceKey: routes?.entrySourceKey ?? null,
    exitSourceKey: routes?.exitSourceKey ?? null,
    poolHookAddress: routes?.poolHookAddress ?? null,
    entryOutputAtomic: routes?.entryOutputAtomic ?? null,
    optimisticExitReturnAtomic: routes?.exitReturnAtomic ?? null,
    optimisticRoundTripBps: roundTrip?.costBps ?? null,
    largestPassingSizeAtomic: capacity?.capacityAtomic ?? null,
    firstFailingSizeAtomic: capacity?.firstFailingAtomic ?? null,
    capacityProbeCount: capacity?.probeCount ?? 0,
    capacityToleranceBps: config.profile.maxExitSlippageBps,
    capacityStable,
    capacitySamplesHash: probes.length > 0 ? capacitySamplesHashV1(probes) : null,
    routeCoverage: coverage.coverage,
    // Empty stays empty ONLY when no route work happened at all; the storage
    // layer normalises that to null, which reads as "not recorded".
    venuesConsulted: routes?.venuesConsulted?.length ? routes.venuesConsulted : null,
    viableRouteConfirmed: coverage.viableRouteConfirmed,
    bestRouteConfirmed: coverage.bestRouteConfirmed,
    controlsSnapshotHash: controlMeasurement?.snapshotHash ?? null,
    controlsBlockNumber: controlMeasurement?.blockNumber ?? null,
    transfersPaused: controls ? controls.transfersPaused : null,
    transferPolicyState: controls ? controls.transferPolicyState : null,
    controlsComplete: controls ? controls.controlsComplete : null,
    observationBlockNumber: anchor.blockNumber,
    observationBlockHash: anchor.blockHash,
    // What the measurement did, not what the wiring expects it to do. The
    // deps value covers only the case where the factory settled the token and
    // no quote was ever taken.
    quoteAlignment: routes?.quoteAlignment ?? deps.quoteAlignment,
    measuredAt,
    staleAfter: new Date(Date.parse(measuredAt) + config.observationStaleMs).toISOString(),
    measurementVersion: B20_MEASUREMENT_VERSION_V1,
  };

  const observation = assertObservationV1(
    {
      ...draft,
      id: observationIdV1(identity),
      evidenceHash: observationEvidenceHashV1(draft),
      createdAt: measuredAt,
    },
    'write',
  );

  // A conflict here — two disagreeing measurements claiming one identity — is
  // deliberately NOT caught. It propagates to the per-candidate handler, which
  // counts it as a failure and moves on rather than overwriting evidence.
  const stored = await input.observations.insertObservation(observation);
  return {
    candidate: {
      launchId: launch.launchId,
      tokenAddress: launch.tokenAddress,
      state: stored.observation.state,
      reasonCode: stored.observation.reasonCode,
      stored: stored.inserted,
    },
    routerCalls,
    controlCalls,
  };
}
