import { logger } from '@mioagent/utils';
import { stableHashV1, type SimulationStateV1 } from '@mioagent/route-domain';
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
  const provider =
    productionWiring
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
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
    ]).has(transport.errorCode);
    const fallback = deps.fallbackProvider === undefined
      ? (productionWiring ? createBaseRpcSwapSimulationProviderFromEnvV1(process.env) : null)
      : deps.fallbackProvider;
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
        errorCode: 'reverted',
      };
}
