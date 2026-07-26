import { stableHashV1, type NftPurchaseBlueprintV1, type SimulationStateV1 } from '@mioagent/route-domain';
import {
  SimulationProviderResponseV1Schema,
  createSimulationProviderFromConfigV1,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
} from '@mioagent/paid-intelligence';

// ---------------------------------------------------------------------------
// T65.1 §3 — the NFT Blueprint's simulation.
//
// The T63B Alchemy provider, reused directly. NOT the paid x402 apparatus
// around it: an NFT purchase is not a metered intelligence product, and
// running the billing coordinator here would open a charge for a wallet
// prompt the user may never accept.
//
// The provider is asked about EXACTLY the persisted calls. Nothing here can
// simulate one batch and hand a wallet another: the request carries the
// blueprint's own callsHash, and a response that cannot be read leaves the
// state `unavailable` rather than passing by default.
// ---------------------------------------------------------------------------

export interface NftSimulationDepsV1 {
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

/**
 * Simulates an NFT purchase blueprint.
 *
 * Always returns a state. `unavailable` is an honest answer and is NEVER
 * treated as a pass — the safety kernel is what decides whether an
 * unsimulated purchase may be signed.
 */
export async function simulateNftBlueprintV1(
  blueprint: NftPurchaseBlueprintV1,
  deps: NftSimulationDepsV1 = {},
): Promise<SimulationStateV1> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const requestHash = stableHashV1('nft-simulation-request/v1', {
    chainId: 8453,
    walletAddress: blueprint.buyer.toLowerCase(),
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
  });

  const provider =
    deps.provider === undefined
      ? createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(process.env))
      : deps.provider;
  if (!provider) return unavailable(requestHash, nowIso, 'provider_not_configured');

  const transport = await provider.simulate({
    chainId: 8453,
    walletAddress: blueprint.buyer,
    blueprintHash: blueprint.blueprintHash,
    callsHash: blueprint.callsHash,
    calls: blueprint.calls,
  });
  if (!transport.ok) return unavailable(requestHash, nowIso, transport.errorCode);

  const parsed = SimulationProviderResponseV1Schema.safeParse(transport.body);
  if (!parsed.success) return unavailable(requestHash, nowIso, 'invalid_response');
  const response = parsed.data;
  if (!(response.blockNumber > 0)) return unavailable(requestHash, nowIso, 'invalid_response');

  const responseHash = stableHashV1('nft-simulation-response/v1', response);
  const blockNumber = String(response.blockNumber);
  // A simulated revert is a RESULT, not a transport failure. It is reported as
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
