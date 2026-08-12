import { logger } from '@mioagent/utils';
import { stableHashV1, type SimulationStateV1 } from '@mioagent/route-domain';
import type { SwapSimulationRequestV1 } from '@mioagent/transaction-composer';
import {
  SimulationProviderResponseV1Schema,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';

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

  const provider =
    deps.provider === undefined
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  if (!provider) return unavailable(requestHash, nowIso, 'provider_not_configured');

  const transport = await provider.simulate({
    chainId: 8453,
    walletAddress: request.walletAddress,
    // The Blueprint does not exist yet — its own simulationState is what this
    // call produces. The binding the provider actually enforces is callsHash,
    // which it recomputes from the calls it is about to simulate; this is the
    // caller-side bookkeeping value the interface documents.
    blueprintHash: requestHash,
    callsHash: request.callsHash,
    calls: request.calls,
  });
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
    return unavailable(requestHash, nowIso, transport.errorCode);
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
