import {
  AERODROME_USDC_V1,
  candidateRoutesV1,
  readAmountsOutManyV1,
  type AerodromeReaderV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import {
  exitCapacityV1,
  exitLadderIsInformativeV1,
  exitProbeLadderV1,
  opportunityVerdictV1,
  priceImpactLadderV1,
  roundTripV1,
  type ExitCapacityV1,
  type ExitControlsV1,
  type OpportunityProfileV1,
  type OpportunityVerdictV1,
  type RoundTripV1,
} from '@mioagent/opportunity-rail';

// ---------------------------------------------------------------------------
// T68C — the exit check.
//
// Answers one question about a token somebody is holding or about to hold:
// CAN I GET BACK OUT, and what does it cost. It is the whole reason the B20 tab
// is not a price screen — a token's controls tell you whether a sale is
// permitted, and the router tells you whether one is possible.
//
// Everything here is a READ. There is no signer, no calldata, no approval and
// no route handed to an execution path: `getAmountsOut` is a view function, and
// this file's entire output is numbers and a verdict. That matters because the
// token being quoted is arbitrary — the swap allowlist exists to stop Miorail
// ROUTING into anything, and quoting is not routing.
//
// Three things it refuses to do:
//
//   * Interpolate. Exit capacity is the largest size that was actually probed
//     and came in under tolerance. There is no curve fit between two probes.
//   * Present a pre-entry exit quote as a result. The exit is quoted against
//     the pool as it stands BEFORE the entry moves it, which flatters the round
//     trip — worst on exactly the thin pools where it matters most. The
//     measurement is labelled `quoted_pre_entry` all the way to the screen.
//   * Read a failed quote as a bad price. "No pool at this size" and "terrible
//     price at this size" are different answers.
// ---------------------------------------------------------------------------

/** How many sizes the ladder probes. Each is one metered call, and public Base
 * serves roughly two and a half a second. */
export const EXIT_PROBE_RUNGS_V1 = 5;

export interface ExitAnalysisInputV1 {
  reader: AerodromeReaderV1;
  /** The B20 token being checked. */
  tokenAddress: `0x${string}`;
  /** What the user spends and gets back. USDC unless a caller says otherwise;
   * a round trip has to start and end in the same asset to mean anything. */
  quoteAsset?: `0x${string}`;
  profile: OpportunityProfileV1;
  controls: ExitControlsV1;
}

/**
 * What the check concluded.
 *
 * `unmeasured` exists because of a false alarm this code produced against live
 * Aerodrome on 2026-08-02: AERO's exit route search was throttled, no route came
 * back, and the answer read "no route out of this token exists — a position
 * could be bought and not sold." AERO has one of the deepest pools on Base. The
 * rejection was about the endpoint and wore the token's name.
 *
 * So: once a route search has been degraded, NO economic conclusion is sound.
 * Not just the missing-route ones — a round trip priced from the candidates
 * that happened to answer may be beaten by one that did not, so a cost
 * rejection is unsound too. Control rejections survive, because they are
 * decided before a single quote is spent.
 */
export type ExitOutcomeV1 =
  | OpportunityVerdictV1
  | { status: 'unmeasured'; reason: 'endpoint_degraded' };

export interface ExitAnalysisV1 {
  verdict: ExitOutcomeV1;
  roundTrip: RoundTripV1 | null;
  exitCapacity: ExitCapacityV1;
  /** True when the ladder measured a curve rather than a single point. A pass
   * on one probe is not a depth finding, and the surface must not show it as
   * one. */
  capacityInformative: boolean;
  /** The size every impact figure is relative to. Impact is measured against
   * the smallest probe that priced, not against a mid price, so every figure
   * UNDERSTATES the true cost by whatever the reference itself paid. */
  referenceSizeAtomic: string | null;
  entryRouteFound: boolean;
  exitRouteFound: boolean;
  /** How many router calls this cost. Surfaced so an operator can see what a
   * page spends before it spends it again. */
  quotesUsed: number;
  /** True when a read failed for a reason that is not "no such pool". An
   * all-empty result from a failing endpoint must never render as "no
   * liquidity". */
  endpointDegraded: boolean;
}

interface BestRouteV1 {
  route: AerodromeRouteLegV1[];
  outputAtomic: bigint;
}

/**
 * The best route for one pair at one size, chosen by asking rather than
 * deciding.
 *
 * Every allowed candidate is quoted in one batch and the largest output wins.
 * `no_route` is the expected answer for most permutations — most pairs do not
 * have all four stable/volatile combinations — so only a non-route failure
 * counts as the endpoint being in trouble.
 */
async function bestRouteV1(
  reader: AerodromeReaderV1,
  input: { from: `0x${string}`; to: `0x${string}`; factory: `0x${string}`; amountIn: bigint },
): Promise<{ best: BestRouteV1 | null; degraded: boolean; calls: number }> {
  const routes = candidateRoutesV1({ from: input.from, to: input.to, factory: input.factory });
  if (routes.length === 0) return { best: null, degraded: false, calls: 0 };

  const results = await readAmountsOutManyV1(
    reader,
    routes.map((route) => ({ amountIn: input.amountIn, route })),
  );
  let best: BestRouteV1 | null = null;
  let degraded = false;
  results.forEach((result, index) => {
    if (!result.ok) {
      if (result.reason !== 'no_route' && result.reason !== 'invalid_response') degraded = true;
      return;
    }
    const output = result.value[result.value.length - 1] ?? 0n;
    // Strictly greater, so the FIRST route wins a tie — and candidateRoutesV1
    // lists direct pools first. Fewer pools at equal output is the better
    // trade: less gas, less to go wrong.
    if (output > (best?.outputAtomic ?? 0n)) best = { route: routes[index]!, outputAtomic: output };
  });
  return { best, degraded, calls: routes.length };
}

/**
 * Can this position be exited, and at what cost.
 *
 * The order of the reads is the design. The EXIT route is searched first,
 * because a token with no way out fails the check whatever the entry costs, and
 * spending a route search on the entry before knowing that would be paying to
 * learn something irrelevant.
 */
export async function analyseExitV1(input: ExitAnalysisInputV1): Promise<ExitAnalysisV1> {
  const quoteAsset = input.quoteAsset ?? AERODROME_USDC_V1;
  const position = BigInt(input.profile.positionAtomic);
  let calls = 0;
  let degraded = false;

  /**
   * The verdict, unless the endpoint made it meaningless.
   *
   * A control rejection is kept whatever happened afterwards: it was decided
   * before any quote was spent, so no amount of throttling can have caused it.
   */
  const soundV1 = (verdict: OpportunityVerdictV1): ExitOutcomeV1 => {
    if (!degraded) return verdict;
    if (
      verdict.status === 'rejected' &&
      (verdict.reason === 'not_b20' ||
        verdict.reason === 'controls_unreadable' ||
        verdict.reason === 'transfers_paused' ||
        verdict.reason === 'transfer_policy_may_block')
    ) {
      return verdict;
    }
    return { status: 'unmeasured', reason: 'endpoint_degraded' };
  };

  const empty = (overrides: Partial<Omit<ExitAnalysisV1, 'verdict'>> = {}): ExitAnalysisV1 => {
    const exitCapacity: ExitCapacityV1 = {
      capacityAtomic: null,
      firstFailingAtomic: null,
      toleranceBps: input.profile.maxSlippageBps,
      probeCount: 0,
    };
    const base = {
      roundTrip: null,
      exitCapacity,
      capacityInformative: false,
      referenceSizeAtomic: null,
      entryRouteFound: false,
      exitRouteFound: false,
      quotesUsed: calls,
      endpointDegraded: degraded,
      ...overrides,
    };
    return {
      ...base,
      endpointDegraded: degraded,
      verdict: soundV1(
        opportunityVerdictV1({
          profile: input.profile,
          controls: input.controls,
          roundTrip: base.roundTrip,
          entryRouteFound: base.entryRouteFound,
          exitRouteFound: base.exitRouteFound,
          exitCapacity: base.exitCapacity,
        }),
      ),
    };
  };

  // Controls are prior to price. A paused token has no round-trip cost worth
  // computing, and spending a dozen metered calls to compute one anyway would
  // put a number where a refusal belongs.
  const controlsVerdict = opportunityVerdictV1({
    profile: input.profile,
    controls: input.controls,
    roundTrip: null,
    entryRouteFound: true,
    exitRouteFound: true,
    exitCapacity: { capacityAtomic: null, firstFailingAtomic: null, toleranceBps: 0, probeCount: 0 },
  });
  if (
    controlsVerdict.status === 'rejected' &&
    (controlsVerdict.reason === 'not_b20' ||
      controlsVerdict.reason === 'controls_unreadable' ||
      controlsVerdict.reason === 'transfers_paused' ||
      controlsVerdict.reason === 'transfer_policy_may_block')
  ) {
    return { ...empty(), verdict: controlsVerdict };
  }

  const factory = await input.reader.readDefaultFactory();
  calls += 1;
  if (!factory.ok) {
    degraded = true;
    return empty();
  }

  // 1. The entry, which is what tells us HOW MANY tokens the position is.
  const entry = await bestRouteV1(input.reader, {
    from: quoteAsset,
    to: input.tokenAddress,
    factory: factory.value,
    amountIn: position,
  });
  calls += entry.calls;
  degraded ||= entry.degraded;
  if (!entry.best) return empty();
  const acquired = entry.best.outputAtomic;

  // 2. The exit route, searched at the size actually acquired.
  const exit = await bestRouteV1(input.reader, {
    from: input.tokenAddress,
    to: quoteAsset,
    factory: factory.value,
    amountIn: acquired,
  });
  calls += exit.calls;
  degraded ||= exit.degraded;
  if (!exit.best) return empty({ entryRouteFound: true });

  const roundTrip = roundTripV1({
    entry: {
      provider: 'aerodrome',
      inputAtomic: position.toString(),
      outputAtomic: acquired.toString(),
    },
    exit: {
      provider: 'aerodrome',
      inputAtomic: acquired.toString(),
      outputAtomic: exit.best.outputAtomic.toString(),
    },
    // The exit was quoted against the pool BEFORE the entry moved it. An
    // optimistic bound, never a result — and worst on exactly the thin pools
    // where the answer matters most.
    measurement: 'quoted_pre_entry',
  });

  // 3. The depth ladder, on the exit route already found. Re-searching routes
  // per rung would multiply the cost by six to answer the same question.
  const ladderSizes = exitProbeLadderV1(acquired.toString(), EXIT_PROBE_RUNGS_V1);
  const ladderResults = await readAmountsOutManyV1(
    input.reader,
    ladderSizes.map((size) => ({ amountIn: BigInt(size), route: exit.best!.route })),
  );
  calls += ladderSizes.length;
  const quoted = ladderSizes.map((size, index) => {
    const result = ladderResults[index];
    if (!result?.ok) {
      if (result && result.reason !== 'no_route' && result.reason !== 'invalid_response') degraded = true;
      return { sizeAtomic: size, outputAtomic: null };
    }
    return { sizeAtomic: size, outputAtomic: (result.value[result.value.length - 1] ?? 0n).toString() };
  });

  const ladder = priceImpactLadderV1(quoted);
  const capacity = exitCapacityV1(ladder.probes, input.profile.maxSlippageBps);
  const capacityInformative = exitLadderIsInformativeV1({
    referenceSizeAtomic: ladder.referenceSizeAtomic,
    positionAtomic: acquired.toString(),
    pricedProbeCount: ladder.probes.filter((probe) => probe.slippageBps !== null).length,
  });

  return {
    verdict: soundV1(
      opportunityVerdictV1({
      profile: {
        ...input.profile,
        // Capacity is measured in the TOKEN being sold, so the position it is
        // compared against has to be in the same units — the amount the entry
        // acquires, not the amount of USDC that bought it.
        positionAtomic: acquired.toString(),
      },
      controls: input.controls,
      roundTrip,
      entryRouteFound: true,
      exitRouteFound: true,
      exitCapacity: capacity,
      }),
    ),
    roundTrip,
    exitCapacity: capacity,
    capacityInformative,
    referenceSizeAtomic: ladder.referenceSizeAtomic,
    entryRouteFound: true,
    exitRouteFound: true,
    quotesUsed: calls,
    endpointDegraded: degraded,
  };
}
