import { logger } from '@mioagent/utils';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  SimulationProviderResponseV1Schema,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';
import {
  candidateRoutesV1,
  readAmountsOutManyV1,
  type AerodromeReaderV1,
  type AerodromeRouteLegV1,
} from '@mioagent/swap-adapters';
import type { OpportunityProfileV2 } from '@mioagent/opportunity-rail';

import { opportunityBlueprintCallsV1 } from './opportunitySimulation.js';
import {
  certifyOpportunityV1,
  entryProbeOutputV1,
  type CertifiedOpportunityV1,
  type SimulationOutcomeLikeV1,
} from './opportunityClearance.js';

// ---------------------------------------------------------------------------
// T68D — the two-pass run.
//
// Pass one simulates approve + entry and READS what the entry produced. Pass
// two simulates all four calls with the exit selling exactly that amount.
//
// Two passes rather than one because the exit's calldata has to name an exact
// quantity, and that quantity is only knowable once the entry has actually run.
// Building it from the quote instead would leave a residue when the entry
// over-delivers — which silently understates the round trip — or revert when it
// under-delivers.
// ---------------------------------------------------------------------------

/** Seconds a simulated swap's deadline is set ahead. Nothing is broadcast, so
 * this only has to outlive the simulated block. */
const SIMULATION_DEADLINE_WINDOW_SECONDS_V1 = 900n;

export interface OpportunityRunDepsV1 {
  reader: AerodromeReaderV1;
  provider?: SimulationProvider | null;
  now: () => Date;
}

export interface OpportunityRunInputV1 {
  wallet: `0x${string}`;
  tokenAddress: `0x${string}`;
  profile: OpportunityProfileV2;
}

export interface OpportunityRunV1 {
  certified: CertifiedOpportunityV1;
  entryRoute: readonly AerodromeRouteLegV1[] | null;
  exitRoute: readonly AerodromeRouteLegV1[] | null;
  calls: ReturnType<typeof opportunityBlueprintCallsV1> | null;
  simulationEvidenceHash: string | null;
}

interface BestRouteV1 {
  route: AerodromeRouteLegV1[];
  outputAtomic: bigint;
}

async function bestRouteV1(
  reader: AerodromeReaderV1,
  input: { from: `0x${string}`; to: `0x${string}`; factory: `0x${string}`; amountIn: bigint },
): Promise<{ best: BestRouteV1 | null; total: number; answered: number }> {
  const routes = candidateRoutesV1({ from: input.from, to: input.to, factory: input.factory });
  const results = await readAmountsOutManyV1(
    reader,
    routes.map((route) => ({ amountIn: input.amountIn, route })),
  );
  let best: BestRouteV1 | null = null;
  let answered = 0;
  results.forEach((result, index) => {
    // `no_route` IS an answer — most pairs do not have all four stable/volatile
    // permutations. Only a transport failure leaves a candidate unheard.
    if (!result.ok) {
      if (result.reason === 'no_route') answered += 1;
      return;
    }
    answered += 1;
    const output = result.value[result.value.length - 1] ?? 0n;
    if (output > (best?.outputAtomic ?? 0n)) best = { route: routes[index]!, outputAtomic: output };
  });
  return { best, total: routes.length, answered };
}

/** One simulation, normalised to the shape the certifier reads. */
async function simulateV1(
  provider: SimulationProvider,
  input: { wallet: string; calls: ReturnType<typeof opportunityBlueprintCallsV1> },
): Promise<SimulationOutcomeLikeV1 & { evidenceHash: string | null }> {
  const callsHash = stableHashV1('b20-opportunity-calls/v1', {
    calls: input.calls.map((call) => ({ to: call.to, data: call.data, value: call.valueWei })),
  });
  const transport = await provider.simulate({
    chainId: 8453,
    walletAddress: input.wallet,
    blueprintHash: callsHash,
    callsHash,
    calls: input.calls,
  });
  if (!transport.ok) {
    // The provider's own words, already redacted by the adapter. Without this
    // an operator sees a code on the screen and nothing at all in the log.
    logger.warn('B20 opportunity simulation did not answer', {
      errorCode: transport.errorCode,
      detail: transport.detail,
      providerMessage: transport.providerMessage,
    });
    return { ok: false, errorCode: transport.errorCode, evidenceHash: null };
  }
  const parsed = SimulationProviderResponseV1Schema.safeParse(transport.body);
  if (!parsed.success) {
    return { ok: false, errorCode: 'provider_invalid_schema', evidenceHash: null };
  }
  const response = parsed.data;
  return {
    ok: true,
    blockNumber: response.blockNumber,
    calls: (response.callResults ?? []).map((call) => ({ index: call.index, status: call.status })),
    assetChangesAvailable: response.assetChanges?.status === 'available',
    assetChanges: (response.assetChanges?.changes ?? []).map((change) => ({
      token: change.token,
      direction: change.direction,
      amountAtomic: change.amountAtomic,
      callIndex: change.callIndex,
    })),
    evidenceHash: stableHashV1('b20-opportunity-evidence/v1', response),
  };
}

/**
 * Quote, probe, simulate, certify.
 *
 * Every failure below is classified as evidence rather than as a verdict about
 * the token. The only outcomes that blame the token are a revert and a measured
 * round trip over the user's own limit.
 */
export async function runOpportunityV1(
  deps: OpportunityRunDepsV1,
  input: OpportunityRunInputV1,
): Promise<OpportunityRunV1> {
  const empty = (certified: CertifiedOpportunityV1): OpportunityRunV1 => ({
    certified,
    entryRoute: null,
    exitRoute: null,
    calls: null,
    simulationEvidenceHash: null,
  });
  const unmeasured = (
    reason:
      | 'endpoint_degraded'
      | 'simulation_unavailable'
      | 'insufficient_probe_balance'
      | 'simulation_undecodable'
      | 'controls_unread',
  ): OpportunityRunV1 =>
    empty({
      outcome: { viability: 'unmeasured', reason },
      coverage: { coverage: 'partial', viableRouteConfirmed: false, bestRouteConfirmed: false },
      simulatedRoundTripBps: null,
      simulatedReturnedAtomic: null,
      simulatedAcquiredAtomic: null,
      simulationBlockNumber: null,
    });

  const provider =
    deps.provider === undefined
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  if (!provider) return unmeasured('simulation_unavailable');

  const factory = await deps.reader.readDefaultFactory();
  if (!factory.ok) return unmeasured('endpoint_degraded');

  const position = BigInt(input.profile.positionAtomic);
  const entry = await bestRouteV1(deps.reader, {
    from: input.profile.quoteAsset as `0x${string}`,
    to: input.tokenAddress,
    factory: factory.value,
    amountIn: position,
  });
  if (!entry.best) {
    // No route found. Whether that is a fact about the token depends entirely
    // on whether the search was heard out.
    const heard = entry.answered >= entry.total;
    return empty({
      outcome: heard
        ? { viability: 'rejected', reason: 'no_entry_route' }
        : { viability: 'unmeasured', reason: 'endpoint_degraded' },
      coverage: {
        coverage: heard ? 'complete' : 'partial',
        viableRouteConfirmed: false,
        bestRouteConfirmed: false,
      },
      simulatedRoundTripBps: null,
      simulatedReturnedAtomic: null,
      simulatedAcquiredAtomic: null,
      simulationBlockNumber: null,
    });
  }

  const deadline =
    BigInt(Math.floor(deps.now().getTime() / 1000)) + SIMULATION_DEADLINE_WINDOW_SECONDS_V1;
  const entryLeg = {
    route: entry.best.route,
    amountInAtomic: position.toString(),
    quotedOutAtomic: entry.best.outputAtomic.toString(),
  };

  // Pass one: what does the entry ACTUALLY produce.
  const probeCalls = opportunityBlueprintCallsV1({
    wallet: input.wallet,
    tokenAddress: input.tokenAddress,
    profile: input.profile,
    entry: entryLeg,
    deadlineSeconds: deadline,
  });
  const probe = await simulateV1(provider, { wallet: input.wallet, calls: probeCalls });
  const acquired = entryProbeOutputV1(input.tokenAddress, probe);
  if (acquired.status !== 'measured') {
    return empty({
      outcome:
        acquired.status === 'rejected'
          ? { viability: 'rejected', reason: 'simulation_reverted' }
          : { viability: 'unmeasured', reason: acquired.reason },
      coverage: { coverage: 'partial', viableRouteConfirmed: false, bestRouteConfirmed: false },
      simulatedRoundTripBps: null,
      simulatedReturnedAtomic: null,
      simulatedAcquiredAtomic: null,
      simulationBlockNumber: null,
    });
  }

  // The exit route is searched at the size the entry actually produced.
  const exit = await bestRouteV1(deps.reader, {
    from: input.tokenAddress,
    to: input.profile.quoteAsset as `0x${string}`,
    factory: factory.value,
    amountIn: BigInt(acquired.acquiredAtomic),
  });
  if (!exit.best) {
    const heard = exit.answered >= exit.total;
    return empty({
      outcome: heard
        ? { viability: 'rejected', reason: 'no_exit_route' }
        : { viability: 'unmeasured', reason: 'endpoint_degraded' },
      coverage: {
        coverage: heard ? 'complete' : 'partial',
        viableRouteConfirmed: false,
        bestRouteConfirmed: false,
      },
      simulatedRoundTripBps: null,
      simulatedReturnedAtomic: null,
      simulatedAcquiredAtomic: null,
      simulationBlockNumber: null,
    });
  }

  // Pass two: all four calls, with the exit selling exactly what pass one saw.
  const calls = opportunityBlueprintCallsV1({
    wallet: input.wallet,
    tokenAddress: input.tokenAddress,
    profile: input.profile,
    entry: entryLeg,
    exit: {
      route: exit.best.route,
      amountInAtomic: acquired.acquiredAtomic,
      quotedOutAtomic: exit.best.outputAtomic.toString(),
    },
    deadlineSeconds: deadline,
  });
  const roundTrip = await simulateV1(provider, { wallet: input.wallet, calls });

  const certified = certifyOpportunityV1({
    profile: input.profile,
    tokenAddress: input.tokenAddress,
    roundTrip,
    // Coverage is the WEAKER of the two searches: one silent candidate on
    // either leg is enough to make a best-route claim unprovable.
    candidatesTotal: entry.total + exit.total,
    candidatesAnswered: entry.answered + exit.answered,
  });

  return {
    certified,
    entryRoute: entry.best.route,
    exitRoute: exit.best.route,
    calls,
    simulationEvidenceHash: roundTrip.evidenceHash,
  };
}
