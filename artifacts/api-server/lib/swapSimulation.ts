import { logger } from '@mioagent/utils';
import { hashApprovedCallsV1, stableHashV1, type SimulationStateV1 } from '@mioagent/route-domain';
import type { SwapSimulationRequestV1 } from '@mioagent/transaction-composer';
import {
  SimulationProviderResponseV1Schema,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
  type SimulationProviderResultV1,
} from '@mioagent/paid-intelligence';
import {
  createBasePublicBatchSimulationProviderFromEnvV1,
  createBaseRpcBatchSimulationProviderFromEnvV1,
  createBaseRpcSwapSimulationProviderFromEnvV1,
} from './baseRpcSwapSimulation.js';

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
  /** A second BATCH provider, tried after retryable failures of the primary and
   * still able to prove approve-then-swap. Undefined enables the Base RPC
   * `eth_simulateV1` path in normal production wiring; tests inject it. */
  batchFallbackProvider?: SimulationProvider | null;
  /** A third, narrower provider (one call only), tried last. Undefined enables
   * the Base RPC `eth_call` path in production wiring; tests may inject/null it. */
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
  /** WHICH provider last proved the batch claim. An operator reading "batch
   * simulation: true" needs to know whether that is the paid key or the chain's
   * own endpoint, because those fail for entirely different reasons. */
  batchProviderId: string | null;
  lastErrorCode: string | null;
  observedAt: string | null;
}

const simulationHealthV1: SimulationHealthV1 = {
  batchProven: null,
  batchProviderId: null,
  lastErrorCode: null,
  observedAt: null,
};

/** What the last real simulation attempt proved about the primary provider. */
export function simulationProviderHealthV1(): Readonly<SimulationHealthV1> {
  return { ...simulationHealthV1 };
}

/** Reset between tests; never called in production. */
export function resetSimulationProviderHealthV1(): void {
  simulationHealthV1.batchProven = null;
  simulationHealthV1.batchProviderId = null;
  simulationHealthV1.lastErrorCode = null;
  simulationHealthV1.observedAt = null;
}

function noteSimulationHealthV1(
  errorCode: string | null,
  observedAt: string,
  providerId: string | null = null,
): void {
  if (errorCode === null) {
    simulationHealthV1.batchProven = true;
    simulationHealthV1.batchProviderId = providerId;
    simulationHealthV1.lastErrorCode = null;
    simulationHealthV1.observedAt = observedAt;
    return;
  }
  if (!BATCH_CANNOT_SERVE_CODES_V1.has(errorCode)) return;
  simulationHealthV1.batchProven = false;
  simulationHealthV1.batchProviderId = null;
  simulationHealthV1.lastErrorCode = errorCode;
  simulationHealthV1.observedAt = observedAt;
}

// ---------------------------------------------------------------------------
// The batch chain.
//
// Two providers can execute an ordered batch against one evolving state, and
// they are tried in this order:
//
//   1. the configured primary (Alchemy eth_simulateV1, when a key is set)
//   2. the deployment's own Base RPC, via the same eth_simulateV1 adapter
//
// Step 2 exists because the assumption that only a paid endpoint serves this
// method was wrong: `mainnet.base.org` answers eth_simulateV1, with state
// evolving across calls. While that assumption stood, an exhausted Alchemy plan
// took every server-written-calldata route down with it, and the product
// correctly — but needlessly — reported those routes unavailable.
//
// A third, narrower provider (eth_call + estimateGas, exactly one call) follows
// them for endpoints that do not serve eth_simulateV1 at all; Infura is one,
// answering -32601. It proves a single call and refuses anything longer.
// ---------------------------------------------------------------------------

/** Codes that mean a batch-capable provider cannot serve this deployment at
 * all, as opposed to a transient blip. `provider_method_unsupported` belongs
 * here for an RPC that simply does not implement the method. */
const BATCH_CANNOT_SERVE_CODES_V1: ReadonlySet<string> = new Set([
  ...PROVIDER_EXHAUSTED_CODES_V1,
  'provider_method_unsupported',
]);

/** Codes where asking the NEXT provider is worthwhile. A revert is not here:
 * a revert is a result, reported to the user, never retried elsewhere. */
const SIMULATION_RETRYABLE_CODES_V1: ReadonlySet<string> = new Set([
  'provider_rate_limited',
  'provider_timeout',
  'provider_http_error',
  'network_error',
  'timeout',
  'http_error',
  'provider_method_unsupported',
]);

interface SimulationChainV1 {
  /** Ordered, de-duplicated by provider id. */
  providers: readonly SimulationProvider[];
  /** Those among them that execute an ordered batch. */
  batchCapableIds: ReadonlySet<string>;
}

/** Orders and de-duplicates the chain. One function so the production wiring
 * and the test wiring cannot drift into two different orders. */
function orderSimulationChainV1(
  configured: SimulationProvider | null,
  batchRpc: SimulationProvider | null,
  publicBatchRpc: SimulationProvider | null,
  narrowRpc: SimulationProvider | null,
): SimulationChainV1 {
  const providers: SimulationProvider[] = [];
  const batchCapableIds = new Set<string>();
  const seen = new Set<string>();
  const push = (provider: SimulationProvider | null, batchCapable: boolean): void => {
    if (!provider || seen.has(provider.providerId)) return;
    seen.add(provider.providerId);
    providers.push(provider);
    if (batchCapable) batchCapableIds.add(provider.providerId);
  };
  push(configured, true);
  push(batchRpc, true);
  push(publicBatchRpc, true);
  push(narrowRpc, false);
  return { providers, batchCapableIds };
}

function buildSimulationChainV1(env: NodeJS.ProcessEnv): SimulationChainV1 {
  return orderSimulationChainV1(
    createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(env)),
    createBaseRpcBatchSimulationProviderFromEnvV1(env),
    createBasePublicBatchSimulationProviderFromEnvV1(env),
    createBaseRpcSwapSimulationProviderFromEnvV1(env),
  );
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
  const chain = buildSimulationChainV1(env);
  const batchProviders = chain.providers.filter((entry) => chain.batchCapableIds.has(entry.providerId));
  if (batchProviders.length === 0) return simulationProviderHealthV1();
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
  const probeRequest = {
    chainId: 8453 as const,
    walletAddress: '0x000000000000000000000000000000000000dEaD' as const,
    blueprintHash: stableHashV1('swap-simulation-health/v1', { nowIso }),
    callsHash: hashApprovedCallsV1(calls),
    calls,
  };
  // Every batch provider is asked until one answers. Stopping at the first
  // refusal is what let one exhausted key speak for a capability another
  // configured endpoint could serve.
  let lastErrorCode: string | null = null;
  const refusals: string[] = [];
  for (const provider of batchProviders) {
    try {
      const result = await provider.simulate(probeRequest);
      if (result.ok) {
        noteSimulationHealthV1(null, nowIso, provider.providerId);
        // The VERDICT goes through the same channel as the refusals above.
        // It used to be a bare console line while they were structured JSON,
        // so anything reading levels saw two warnings and never saw that a
        // later provider had answered — which is exactly how this deployment
        // was read as having no simulator while it had one.
        logger.info('Simulation provider health probe answered', {
          provider: provider.providerId,
          refusedBefore: refusals,
        });
        return simulationProviderHealthV1();
      }
      lastErrorCode = result.errorCode;
      // Two different facts wear the same shape here, and only one of them is
      // an incident. `provider_method_unsupported` means this endpoint can
      // NEVER serve eth_simulateV1 — Infura answers -32601 and always will —
      // so it is a configuration fact that will repeat at every boot forever.
      // Capacity is an outage that ends. Saying which is what stops an
      // operator chasing a permanent line, and what stops a reader concluding
      // from two warnings that simulation is down when the next provider
      // proved it.
      refusals.push(provider.providerId);
      const permanent = result.errorCode === 'provider_method_unsupported';
      logger.warn('Simulation provider health probe did not answer', {
        provider: provider.providerId,
        errorCode: result.errorCode,
        // Structured, because the message is what a human reads and this is
        // what a filter reads.
        permanent,
        detail: permanent
          ? 'this endpoint does not implement eth_simulateV1 and will not on retry; the next provider decides'
          : 'temporary — the next provider decides',
      });
      if (!BATCH_CANNOT_SERVE_CODES_V1.has(result.errorCode)) return simulationProviderHealthV1();
    } catch (error) {
      logger.warn('Simulation provider health probe threw', {
        provider: provider.providerId,
        name: error instanceof Error ? error.name : 'unknown',
      });
      return simulationProviderHealthV1();
    }
  }
  // Every batch provider was asked and each said it cannot serve.
  if (lastErrorCode) noteSimulationHealthV1(lastErrorCode, nowIso);
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
  const chain = buildSimulationChainV1(env);
  const health = simulationProviderHealthV1();
  return {
    singleCall: chain.providers.length > 0,
    // Batch capability is a property of the CHAIN, not of the paid key. It
    // holds when some configured provider executes an ordered batch and the
    // last real attempt did not disprove all of them — a key is still not a
    // capability, and now neither is its absence a disqualification.
    batch: chain.batchCapableIds.size > 0 && health.batchProven !== false,
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

  // Test wiring stays explicit: `deps.provider === undefined` means production,
  // and whatever a test injects is the entire chain it gets.
  const productionWiring = deps.provider === undefined;
  const configured =
    productionWiring
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  const batchFallback = deps.batchFallbackProvider === undefined
    ? (productionWiring ? createBaseRpcBatchSimulationProviderFromEnvV1(process.env) : null)
    : deps.batchFallbackProvider;
  const publicBatchFallback = productionWiring
    ? createBasePublicBatchSimulationProviderFromEnvV1(process.env)
    : null;
  const narrowFallback = deps.fallbackProvider === undefined
    ? (productionWiring ? createBaseRpcSwapSimulationProviderFromEnvV1(process.env) : null)
    : deps.fallbackProvider;

  // An UNCONFIGURED primary used to end the function here, and the Base RPC
  // providers below were never reached. That is how a deployment holding a
  // perfectly good Base RPC URL still reported "no simulation provider
  // answered" for a call it could have executed. A reviewed provider that can
  // prove this call shape IS a production simulation path.
  const { providers: chain, batchCapableIds } = orderSimulationChainV1(
    configured ?? null,
    batchFallback,
    publicBatchFallback,
    narrowFallback ?? null,
  );
  if (chain.length === 0) return unavailable(requestHash, nowIso, 'provider_not_configured');

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

  let transport: SimulationProviderResultV1 | null = null;
  let answeredBy: SimulationProvider | null = null;
  let firstErrorCode: string | null = null;
  let batchRefusals = 0;
  let lastBatchErrorCode: string | null = null;

  for (const provider of chain) {
    const isBatch = batchCapableIds.has(provider.providerId);
    const result = await provider.simulate(simulationRequest);
    transport = result;
    if (result.ok) {
      answeredBy = provider;
      break;
    }
    if (firstErrorCode === null) firstErrorCode = result.errorCode;
    if (isBatch && BATCH_CANNOT_SERVE_CODES_V1.has(result.errorCode)) {
      batchRefusals += 1;
      lastBatchErrorCode = result.errorCode;
    }
    // Without this an operator saw an error code on screen and nothing in the
    // log, for the one gate that decides whether a swap may be signed.
    logger.warn('Swap simulation did not answer', {
      provider: provider.providerId,
      errorCode: result.errorCode,
      detail: result.detail,
      providerMessage: result.providerMessage,
      blueprintId: request.blueprintId,
      callsHash: request.callsHash,
    });
    // A provider that declined this call SHAPE has still answered, and the next
    // one may execute it. Refusing to ask turned a recoverable shape mismatch
    // into "no provider answered".
    if (!SIMULATION_RETRYABLE_CODES_V1.has(result.errorCode)) break;
  }

  // Batch health is the CHAIN's verdict, never the first provider's. A primary
  // that is out of capacity while a second batch provider answers leaves this
  // deployment batch-capable, and claiming otherwise is exactly what took the
  // server-written-calldata routes offline.
  if (answeredBy && batchCapableIds.has(answeredBy.providerId)) {
    noteSimulationHealthV1(null, nowIso, answeredBy.providerId);
  } else if (lastBatchErrorCode && batchRefusals === batchCapableIds.size) {
    noteSimulationHealthV1(lastBatchErrorCode, nowIso);
  }

  if (!transport || !transport.ok) {
    return unavailable(requestHash, nowIso, transport?.errorCode ?? 'provider_not_configured');
  }
  if (answeredBy && answeredBy.providerId !== chain[0]?.providerId) {
    logger.info('Swap simulation recovered through a reviewed fallback provider', {
      primaryErrorCode: firstErrorCode,
      answeredBy: answeredBy.providerId,
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
