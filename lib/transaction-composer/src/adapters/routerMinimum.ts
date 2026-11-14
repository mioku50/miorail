import { minimumOutputAtomic } from '@mioagent/swap-adapters';

/**
 * The least a router call's own minimum may be for the slippage the person
 * allowed (audit SW-1, 2026-11-14).
 *
 * The review states the minimum the bytes guarantee, read from them, rather
 * than one worked out from the quote's JSON. The provider works its minimum
 * out from its build-time quote, which can be a unit below the routes quote
 * (KyberSwap, measured 2026-11-14: 1 892 482 quoted, 1 892 481 built), and
 * rounds each leg down on its own. So one basis point beyond the allowed
 * slippage, and a unit per minimum, is tolerated; anything lower is a floor
 * the person never accepted, and the build is refused.
 */
export function routerMinimumFloorAtomicV1(expectedAtomic: string, slippageBps: number, minimumSources = 1): bigint {
  const floor = BigInt(minimumOutputAtomic(expectedAtomic, Math.min(slippageBps + 1, 10_000))) - BigInt(minimumSources);
  return floor > 1n ? floor : 1n;
}
