import {
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  SimulationProviderResponseV1Schema,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  AERODROME_ROUTER_V1,
  parseAerodromeSourceKeyV1,
  type AerodromeReaderV1,
} from '@mioagent/swap-adapters';
import {
  buildB20CardV1,
  exitControlsFromSnapshotV1,
  inspectB20TokenV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import {
  CLEARANCE_REFUSAL_COPY_V1,
  clearanceRefusalV1,
  type B20OpportunityClearanceV1,
} from '@mioagent/route-storage';
import { OPPORTUNITY_QUOTE_ASSET_V1 } from '@mioagent/opportunity-rail';

import {
  ENTRY_DEADLINE_WINDOW_SECONDS_V1,
  ENTRY_PLAN_REFUSAL_COPY_V1,
  buildEntryBlueprintV1,
  revalidateControlsV1,
  revalidateQuoteV1,
  runEntryKernelV1,
  verifyEntrySimulationV1,
  type B20EntryBlueprintV1,
} from './b20EntryPlan.js';

// ---------------------------------------------------------------------------
// T68E — the prepare-entry run.
//
// Order matters and is the design: clearance bindings, then a FRESH control
// read, then a re-quote of the exact cleared route, then the blueprint, then
// the kernel, then a simulation of those precise calls. Each step is cheaper
// than the next, and each one that fails saves the cost of the rest.
//
// The clearance's own simulation is NOT reused here. That one proved a viable
// entry-and-exit scenario existed; this proves the exact bytes now on offer do
// not revert and match the plan. They are different claims.
// ---------------------------------------------------------------------------

export interface PrepareEntryDepsV1 {
  b20Reader: B20ReaderV1;
  aerodromeReader: AerodromeReaderV1;
  provider?: SimulationProvider | null;
  now: () => Date;
}

export interface PrepareEntryInputV1 {
  clearance: B20OpportunityClearanceV1 | null;
  tenantId: string;
  walletAddress: string;
  chainId: number;
  profileIdentity: string;
}

/** What the prepare-time simulation observed. Hashes and a block number — never
 * the provider's body, which can carry an endpoint and an endpoint can carry a
 * key. Present only when the simulation actually passed. */
export interface PrepareSimulationEvidenceV1 {
  requestHash: string;
  evidenceHash: string;
  blockNumber: string;
}

export interface PrepareEntryResultV1 {
  blueprint: B20EntryBlueprintV1 | null;
  refusal: string | null;
  detail: string | null;
  /** Present even on a refusal, so a surface can name the token it refused
   * about without reaching into a clearance that may be null. */
  tokenAddress: string;
  /** T68F-A — carried out so the plan can be persisted with the evidence that
   * justified it, rather than a later reader taking the simulation on trust. */
  simulation: PrepareSimulationEvidenceV1 | null;
  /** From this server's own fresh control read, for the Review screen. Never
   * from a client and never from token metadata treated as identity. */
  tokenName: string | null;
  tokenSymbol: string | null;
}

const REFUSED_TOKEN_V1 = '0x0000000000000000000000000000000000000000';

export async function prepareB20EntryV1(
  deps: PrepareEntryDepsV1,
  input: PrepareEntryInputV1,
): Promise<PrepareEntryResultV1> {
  const now = deps.now();
  const clearance = input.clearance;
  let tokenName: string | null = null;
  let tokenSymbol: string | null = null;
  const refuse = (refusal: string, detail: string, token = clearance?.tokenAddress ?? REFUSED_TOKEN_V1): PrepareEntryResultV1 => ({
    blueprint: null,
    refusal,
    detail,
    tokenAddress: token,
    simulation: null,
    tokenName,
    tokenSymbol,
  });

  // 1. The clearance bindings, through the SHARED taxonomy. A parallel set of
  // slightly different rules inside a route is how two gates drift apart.
  const bindingRefusal = clearanceRefusalV1({
    clearance,
    now,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    tokenAddress: clearance?.tokenAddress ?? REFUSED_TOKEN_V1,
    profileIdentity: input.profileIdentity,
    entryRouteHash: clearance?.entryRouteHash ?? '',
    controlSnapshotHash: clearance?.controlSnapshotHash ?? '',
    provider: clearance?.entryProvider ?? 'aerodrome',
  });
  if (bindingRefusal || !clearance) {
    const reason = bindingRefusal ?? 'clearance_missing';
    return refuse(reason, CLEARANCE_REFUSAL_COPY_V1[reason as keyof typeof CLEARANCE_REFUSAL_COPY_V1]);
  }
  if (clearance.profileIdentity !== input.profileIdentity) {
    return refuse('clearance_profile_mismatch', CLEARANCE_REFUSAL_COPY_V1.clearance_profile_mismatch);
  }
  if (clearance.quoteAsset.toLowerCase() !== OPPORTUNITY_QUOTE_ASSET_V1) {
    return refuse('clearance_profile_mismatch', CLEARANCE_REFUSAL_COPY_V1.clearance_profile_mismatch);
  }

  // 2. A FRESH control read. A clearance describes a past state; this is the
  // present one, and preparation is refused when they differ.
  const inspection = await inspectB20TokenV1(
    { reader: deps.b20Reader },
    { tenantId: input.tenantId, chainId: 8453, tokenAddress: clearance.tokenAddress, now },
  );
  // The display identity comes from THIS read, not from a client and not from
  // metadata treated as identity — the address remains the only identity.
  const card = buildB20CardV1(inspection.snapshot);
  tokenName = card.displayName;
  tokenSymbol = card.displaySymbol;
  const freshControls = {
    ...exitControlsFromSnapshotV1(inspection.snapshot),
    snapshotHash: inspection.snapshot.snapshotHash,
    blockNumber: inspection.snapshot.blockNumber,
  };
  const controlRefusal = revalidateControlsV1({
    cleared: { snapshotHash: clearance.controlSnapshotHash },
    fresh: freshControls,
  });
  if (controlRefusal) return refuse(controlRefusal, ENTRY_PLAN_REFUSAL_COPY_V1[controlRefusal]);

  // 3. Re-quote the EXACT cleared route. Not a fresh search: a better route
  // discovered since certification has not been through this gate at all.
  const clearedRoute = parseAerodromeSourceKeyV1(clearance.entrySourceKey);
  if (!clearedRoute) return refuse('entry_plan_stale', ENTRY_PLAN_REFUSAL_COPY_V1.entry_plan_stale);
  const position = BigInt(clearance.positionAtomic);
  const quoted = await deps.aerodromeReader.readAmountsOut({
    amountIn: position,
    route: [clearedRoute],
  });
  const fresh = quoted.ok
    ? {
        route: [clearedRoute],
        outputAtomic: (quoted.value[quoted.value.length - 1] ?? 0n).toString(),
        quotedAt: now,
      }
    : null;
  const quoteRefusal = revalidateQuoteV1({
    clearance,
    clearedRoute: [clearedRoute],
    fresh,
    profile: {
      quoteAsset: OPPORTUNITY_QUOTE_ASSET_V1,
      positionAtomic: clearance.positionAtomic,
      maxRoundTripBps: clearance.maxRoundTripBps,
      maxExitSlippageBps: clearance.maxExitSlippageBps,
    },
    now,
  });
  if (quoteRefusal || !fresh) {
    const reason = quoteRefusal ?? 'entry_plan_stale';
    return refuse(reason, ENTRY_PLAN_REFUSAL_COPY_V1[reason]);
  }

  // 4. The standing allowance, so an approval nobody needs is not emitted.
  const allowance = await deps.aerodromeReader.readAllowance({
    token: OPPORTUNITY_QUOTE_ASSET_V1,
    owner: clearance.walletAddress as `0x${string}`,
    spender: AERODROME_ROUTER_V1,
  });

  const blueprint = buildEntryBlueprintV1({
    clearance,
    fresh,
    freshControls,
    // An unreadable allowance is treated as none: emitting an approval that
    // turns out to be unnecessary is safe, skipping a required one is not.
    observedAllowanceAtomic: allowance.ok ? allowance.value.toString() : '0',
    deadlineSeconds: BigInt(Math.floor(now.getTime() / 1000)) + ENTRY_DEADLINE_WINDOW_SECONDS_V1,
  });

  // 5. The kernel over what was actually built.
  const kernel = runEntryKernelV1({
    blueprint,
    walletAddress: input.walletAddress,
    clearance,
    now,
  });
  if (kernel.verdict === 'blocked') {
    const reason = kernel.blockedReason ?? 'entry_kernel_blocked';
    return refuse(reason, ENTRY_PLAN_REFUSAL_COPY_V1[reason]);
  }

  // 6. Simulate THESE calls. A clearance does not replace this, and neither
  // does a near-identical batch that passed minutes ago.
  const provider =
    deps.provider === undefined
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  if (!provider) {
    return refuse('entry_simulation_unavailable', ENTRY_PLAN_REFUSAL_COPY_V1.entry_simulation_unavailable);
  }
  const callsHash = stableHashV1('b20-entry-calls/v1', {
    calls: blueprint.calls.map((call) => ({ to: call.to, data: call.data, value: call.valueWei })),
  });
  const transport = await provider.simulate({
    chainId: 8453,
    walletAddress: input.walletAddress,
    blueprintHash: blueprint.blueprintHash,
    callsHash,
    calls: blueprint.calls,
  });
  const parsedResponse = transport.ok
    ? SimulationProviderResponseV1Schema.safeParse(transport.body)
    : null;
  const observed = parsedResponse?.success === true ? parsedResponse.data : null;
  const simulationRefusal = verifyEntrySimulationV1({
    blueprint,
    simulation:
      observed
        ? {
            ok: true,
            calls: (observed.callResults ?? []).map((call) => ({
              index: call.index,
              status: call.status,
            })),
            assetChangesAvailable: observed.assetChanges?.status === 'available',
            assetChanges: (observed.assetChanges?.changes ?? []).map((change) => ({
              token: change.token,
              direction: change.direction,
              amountAtomic: change.amountAtomic,
              callIndex: change.callIndex,
            })),
          }
        : { ok: false },
  });
  if (simulationRefusal || !observed) {
    const reason = simulationRefusal ?? 'entry_simulation_unavailable';
    return refuse(reason, ENTRY_PLAN_REFUSAL_COPY_V1[reason]);
  }

  return {
    blueprint,
    refusal: null,
    detail: null,
    tokenAddress: clearance.tokenAddress,
    // Derived here, from the response THIS server parsed — never the provider's
    // body, which can carry an endpoint, and an endpoint can carry a key.
    simulation: {
      requestHash: callsHash,
      evidenceHash: stableHashV1('b20-entry-simulation/v1', {
        blueprintHash: blueprint.blueprintHash,
        callsHash,
        status: observed.status,
        blockNumber: observed.blockNumber,
        gasUsed: observed.gasUsed,
        callResults: (observed.callResults ?? []).map((call) => ({
          index: call.index,
          status: call.status,
        })),
      }),
      blockNumber: String(observed.blockNumber),
    },
    tokenName,
    tokenSymbol,
  };
}
