import type { PublicProofProviderV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// T68F §9 — naming the provider that actually executed a route.
//
// `provider: null` was hardcoded at both public-bundle call sites since the
// feature shipped. The contract had `providerId`, `providerName` and
// `sourceKey` waiting, all nullable, with a comment saying a null is "a real
// answer" — and it was the ONLY answer, including for the many proofs where the
// server knew perfectly well who quoted the route. A public artifact that
// cannot say which venue filled a trade is a weaker claim than the data
// supports.
//
// Two rules hold this honest:
//
//   * The identity comes from the SERVER'S OWN record — the derived provider
//     outcome, keyed by proof id. Never from a client, and never from a name
//     that travelled in a request.
//   * A legacy proof with no outcome row still resolves to null. Null keeps
//     meaning "we do not know", so an old bundle stays readable and is not
//     back-filled with a guess.
// ---------------------------------------------------------------------------

/** Display names for the providers this server can execute through. An id with
 * no entry is shown as itself rather than hidden: a provider the map has not
 * caught up with is still a fact about the route. */
export const PUBLIC_PROOF_PROVIDER_NAMES_V1: Record<string, string> = {
  uniswap: 'Uniswap',
  kyberswap: 'KyberSwap',
  aerodrome: 'Aerodrome',
};

export function publicProviderNameV1(providerId: string): string {
  return PUBLIC_PROOF_PROVIDER_NAMES_V1[providerId] ?? providerId;
}

/**
 * Whether a liquidity source key is safe to publish.
 *
 * Aerodrome keys are `aerodrome:<factory>:<from>:<to>:<curve>` — all on-chain
 * addresses, all already implied by the proof's own calls. Anything else is
 * withheld rather than guessed at: a source key is free-form by contract, and
 * a public bundle is the wrong place to discover what somebody put in one.
 */
export function publicSafeSourceKeyV1(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  return /^aerodrome:0x[0-9a-f]{40}:0x[0-9a-f]{40}:0x[0-9a-f]{40}:(stable|volatile)$/.test(sourceKey)
    ? sourceKey
    : null;
}

/** The record a provider identity is derived from. Structural on purpose: this
 * module must not depend on the outcome package's whole surface. */
export interface ProviderOutcomeLikeV1 {
  providerId: string;
}

/**
 * The provider identity for a public bundle.
 *
 * Null when the server genuinely has no record — which is what a legacy proof
 * looks like, and what it must keep looking like.
 */
export function publicProofProviderV1(input: {
  outcome: ProviderOutcomeLikeV1 | null;
  sourceKey?: string | null;
}): PublicProofProviderV1 | null {
  const providerId = input.outcome?.providerId;
  if (!providerId) return null;
  return {
    providerId,
    providerName: publicProviderNameV1(providerId),
    sourceKey: publicSafeSourceKeyV1(input.sourceKey),
  };
}
