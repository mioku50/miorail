import { logger } from '@mioagent/utils';
import { hashApprovedCallsV1, stableHashV1, type SimulationStateV1 } from '@mioagent/route-domain';
import type { SwapSimulationRequestV1 } from '@mioagent/transaction-composer';
import {
  SimulationProviderResponseV1Schema,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';
import { createBaseRpcSwapSimulationProviderFromEnvV1 } from './baseRpcSwapSimulation.js';

// ---------------------------------------------------------------------------
// T67B.1 §6 — the swap Blueprint's simulation.
//
// The same T63B Alchemy provider the NFT path uses, and for the same reason:
// this is a precondition for handing a wallet a batch, not a metered
// intelligence product. Running the x402 billing coordinator here would open a
// charge for a wallet prompt the user may never accept.
//
// Aerodrome and o1.exchange reach this function. Aerodrome calldata is written
// by this server; o1 calldata targets a pinned upgradeable proxy and its swap
// ABI has no explicit recipient argument. Both must execute successfully
// against current Base state before the wallet sees them.
//
// An answer that cannot be read leaves the state `unavailable`, and
// `unavailable` is not a pass — the Safety Kernel is what decides, and for
// both providers it requires `passed`.
// ---------------------------------------------------------------------------

export interface SwapSimulationDepsV1 {
  provider?: SimulationProvider | null;
  /** A second, narrower provider used only after retryable primary transport
   * failures. Undefined enables the Base RPC single-call fallback in normal
   * production wiring; tests may inject/null it explicitly. */
  fallbackProvider?: SimulationProvider | null;
  now?: () => Date;
}

function unavailable(requestHash: string, nowIso: string, errorCode: string): SimulationStateV1 {
  return {
    status: 'unavailable',
    observedAt: nowIso,
    blockNumber: null,
    requestHash: requestHash as SimulationStateV1['requestHash'],
    responseHash: null,
    errorCode,
  };
}

// ---------------------------------------------------------------------------
// Measured provider health.
//
// Holding an API key is not a capability. Production held a perfectly valid
// ALCHEMY_BASE_API_KEY whose account had exhausted its monthly capacity, so
// every eth_simulateV1 came back HTTP 429 — and anything that asked "is a
// batch simulator configured?" answered yes, all the way into the console,
// which then advertised a Balancer swap it could never sign.
//
// So the claim degrades on evidence. The first refusal that means "this key
// cannot serve requests" demotes the batch claim for the rest of the process,
// and a later success restores it. No extra request, no probe on the hot path,
// and no capability asserted that the last real call disproved.
// ---------------------------------------------------------------------------

/** Codes that mean the primary cannot serve requests at all, as opposed to a
 * transient blip or a call shape it declined. */
const PROVIDER_EXHAUSTED_CODES_V1: ReadonlySet<string> = new Set([
  'provider_rate_limited',
  'provider_not_configured',
]);

interface SimulationHealthV1 {
  batchProven: boolean | null;
  lastErrorCode: string | null;
  observedAt: string | null;
}

const simulationHealthV1: SimulationHealthV1 = { batchProven: null, lastErrorCode: null, observedAt: null };

/** What the last real simulation attempt proved about the primary provider. */
export function simulationProviderHealthV1(): Readonly<SimulationHealthV1> {
  return { ...simulationHealthV1 };
}

/** Reset between tests; never called in production. */
export function resetSimulationProviderHealthV1(): void {
  simulationHealthV1.batchProven = null;
  simulationHealthV1.lastErrorCode = null;
  simulationHealthV1.observedAt = null;
}

function noteSimulationHealthV1(errorCode: string | null, observedAt: string): void {
  if (errorCode === null) {
    simulationHealthV1.batchProven = true;
    simulationHealthV1.lastErrorCode = null;
    simulationHealthV1.observedAt = observedAt;
    return;
  }
  if (!PROVIDER_EXHAUSTED_CODES_V1.has(errorCode)) return;
  simulationHealthV1.batchProven = false;
  simulationHealthV1.lastErrorCode = errorCode;
  simulationHealthV1.observedAt = observedAt;
}

/**
 * One cheap read against the configured primary, to learn at BOOT whether it
 * can serve requests at all.
 *
 * Without it the batch claim is optimistic until a user's first swap disproves
 * it — and that user is the one who reaches the dead end. This costs a single
 * request per process, simulates a `name()` read on WETH from the burn address,
 * signs nothing and moves nothing.
 *
 * A failure here is recorded, never thrown: an unreachable simulator is a
 * capability fact, not a startup error.
 */
export async function probeSimulationProviderHealthV1(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<SimulationHealthV1>> {
  const provider = createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(env));
  if (!provider) return simulationProviderHealthV1();
  const nowIso = new Date().toISOString();
  const calls = [{
    index: 0,
    callType: 'other' as const,
    to: '0x4200000000000000000000000000000000000006' as const,
    valueWei: '0',
    // `name()` — a pure read that cannot change state on any input.
    data: '0x06fdde03' as const,
    asset: {
      assetId: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006',
      chainId: 8453 as const,
      kind: 'erc20' as const,
      address: '0x4200000000000000000000000000000000000006' as const,
      symbol: 'WETH',
      decimals: 18,
    },
    amountAtomic: '0',
    recipient: '0x000000000000000000000000000000000000dEaD' as const,
    spender: null,
    minimumAmountAtomic: null,
  }];
  try {
    const result = await provider.simulate({
      chainId: 8453,
      walletAddress: '0x000000000000000000000000000000000000dEaD',
      blueprintHash: stableHashV1('swap-simulation-health/v1', { nowIso }),
      callsHash: hashApprovedCallsV1(calls),
      calls,
    });
    noteSimulationHealthV1(result.ok ? null : result.errorCode, nowIso);
    if (!result.ok) {
      logger.warn('Simulation provider health probe did not answer', { errorCode: result.errorCode });
    }
  } catch (error) {
    logger.warn('Simulation provider health probe threw', {
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
  return simulationProviderHealthV1();
}

/**
 * Which call SHAPES this deployment can actually prove.
 *
 * The capability matrix asks this before it calls any Routes handoff
 * `released`. A provider whose calldata Miorail writes itself is only signable
 * if something here can execute it, so a deployment with no batch simulator
 * has no end-to-end Balancer swap however good its quote adapter is.
 *
 * `singleCall` — one call from the real wallet against latest state (Base RPC
 *                `eth_call` + `estimateGas`). Enough for a native-ETH swap.
 * `batch`      — an ordered batch against ONE evolving state, which is the
 *                only thing that proves approve-then-swap.
 */
export function swapSimulationCapabilityV1(
  env: NodeJS.ProcessEnv = process.env,
): { singleCall: boolean; batch: boolean; primaryProviderId: string | null } {
  const config = resolveSimulationProviderConfigV1(env);
  const primary = createSimulationProviderFromConfigV1(config);
  const fallback = createBaseRpcSwapSimulationProviderFromEnvV1(env);
  const health = simulationProviderHealthV1();
  return {
    singleCall: Boolean(primary) || Boolean(fallback),
    // Only the full provider executes an ordered batch; the Base RPC path
    // fails closed for callCount !== 1 and says so in its own comment. And a
    // configured provider whose last real answer was "capacity exceeded" does
    // not count: a key is not a capability.
    batch: Boolean(primary) && health.batchProven !== false,
    primaryProviderId: primary ? config.providerId : null,
  };
}

export async function simulateSwapCallsV1(
  request: SwapSimulationRequestV1,
  deps: SwapSimulationDepsV1 = {},
): Promise<SimulationStateV1> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const requestHash = stableHashV1('swap-simulation-request/v1', {
    chainId: request.chainId,
    walletAddress: request.walletAddress.toLowerCase(),
    blueprintId: request.blueprintId,
    callsHash: request.callsHash,
  });

  const productionWiring = deps.provider === undefined;
  const configured =
    productionWiring
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  const narrowFallback = deps.fallbackProvider === undefined
    ? (productionWiring ? createBaseRpcSwapSimulationProviderFromEnvV1(process.env) : null)
    : deps.fallbackProvider;
  // An UNCONFIGURED primary used to end the function here, and the narrow
  // Base-RPC path below was never reached. That is how a deployment holding a
  // perfectly good Base RPC URL still reported "no simulation provider
  // answered" for a single-call native swap it could have executed. A reviewed
  // fallback that can prove this call shape IS a production simulation path.
  const provider = configured ?? narrowFallback;
  if (!provider) return unavailable(requestHash, nowIso, 'provider_not_configured');

  const simulationRequest = {
    chainId: 8453,
    walletAddress: request.walletAddress,
    // The Blueprint does not exist yet — its own simulationState is what this
    // call produces. The binding the provider actually enforces is callsHash,
    // which it recomputes from the calls it is about to simulate; this is the
    // caller-side bookkeeping value the interface documents.
    blueprintHash: requestHash,
    callsHash: request.callsHash,
    calls: request.calls,
  } as const;
  let transport = await provider.simulate(simulationRequest);
  // Only the PRIMARY's verdict says anything about batch capability; the
  // narrow fallback declining a batch is by design, not a health signal.
  if (configured && provider === configured) {
    noteSimulationHealthV1(transport.ok ? null : transport.errorCode, nowIso);
  }
  if (!transport.ok) {
    // Without this an operator saw an error code on screen and nothing in the
    // log, for the one gate that decides whether a swap may be signed.
    logger.warn('Swap simulation did not answer', {
      errorCode: transport.errorCode,
      detail: transport.detail,
      providerMessage: transport.providerMessage,
      blueprintId: request.blueprintId,
      callsHash: request.callsHash,
    });
    const retryable = new Set([
      'provider_rate_limited',
      'provider_timeout',
      'provider_http_error',
      'network_error',
      'timeout',
      'http_error',
      // A primary that declines this call SHAPE has answered — and the narrow
      // fallback may well execute it, because a single call is exactly what it
      // proves. Refusing to ask it turned a recoverable shape mismatch into
      // "no provider answered".
      'provider_method_unsupported',
    ]).has(transport.errorCode);
    const fallback = narrowFallback;
    if (!retryable || !fallback || fallback.providerId === provider.providerId) {
      return unavailable(requestHash, nowIso, transport.errorCode);
    }
    const primaryErrorCode = transport.errorCode;
    transport = await fallback.simulate(simulationRequest);
    if (!transport.ok) {
      logger.warn('Swap fallback simulation did not answer', {
        primaryErrorCode,
        fallbackErrorCode: transport.errorCode,
        detail: transport.detail,
        providerMessage: transport.providerMessage,
        fallbackProvider: fallback.providerId,
        blueprintId: request.blueprintId,
        callsHash: request.callsHash,
      });
      return unavailable(requestHash, nowIso, transport.errorCode);
    }
    logger.info('Swap simulation recovered through bounded Base RPC fallback', {
      primaryErrorCode,
      fallbackProvider: fallback.providerId,
      blueprintId: request.blueprintId,
      callsHash: request.callsHash,
    });
  }

  const parsed = SimulationProviderResponseV1Schema.safeParse(transport.body);
  if (!parsed.success) return unavailable(requestHash, nowIso, 'invalid_response');
  const response = parsed.data;
  if (!(response.blockNumber > 0)) return unavailable(requestHash, nowIso, 'invalid_response');

  const responseHash = stableHashV1('swap-simulation-response/v1', response);
  const blockNumber = String(response.blockNumber);
  // A simulated revert is a RESULT, not a transport failure: it is reported as
  // `failed`, which is a thing the user is told, not a thing that is retried.
  return response.status === 'success'
    ? {
        status: 'passed',
        observedAt: nowIso,
        blockNumber,
        requestHash: requestHash as SimulationStateV1['requestHash'],
        responseHash: responseHash as SimulationStateV1['responseHash'],
        errorCode: null,
      }
    : {
        status: 'failed',
        observedAt: nowIso,
        blockNumber,
        requestHash: requestHash as SimulationStateV1['requestHash'],
        responseHash: responseHash as SimulationStateV1['responseHash'],
        // A revert because the WALLET cannot pay is not a statement about the
        // route. Collapsing it into `reverted` told a user with an empty
        // balance that the market was broken.
        errorCode: /insufficient\s+(?:funds|balance)|exceeds\s+balance/iu.test(response.revertReason ?? '')
          ? 'insufficient_funds'
          : 'reverted',
      };
}
