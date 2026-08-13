import type { RouteIntentV1 } from '@mioagent/route-domain';
import { AerodromeSwapRouteAdapter } from './aerodrome.js';
import { KyberSwapRouteAdapter } from './kyberswap.js';
import { UniswapSwapRouteAdapter } from './uniswap.js';
import { O1SwapRouteAdapter } from './o1.js';
import { HydrexSwapRouteAdapter } from './hydrex.js';
import { BalancerSwapRouteAdapter } from './balancer.js';
import type {
  ReleasedSwapAdapterId,
  SwapAdapterId,
  SwapAdapterSelectionResult,
  SwapRouteAdapter,
} from './types.js';

const RELEASED_ADAPTER_ORDER: readonly ReleasedSwapAdapterId[] = ['uniswap', 'kyberswap', 'aerodrome', 'o1-exchange', 'hydrex', 'balancer'];
const ADAPTER_ORDER: readonly SwapAdapterId[] = [
  ...RELEASED_ADAPTER_ORDER,
];

export function createDefaultSwapAdapters(): SwapRouteAdapter[] {
  return [
    new UniswapSwapRouteAdapter(),
    new KyberSwapRouteAdapter(),
    new AerodromeSwapRouteAdapter(),
    new O1SwapRouteAdapter(),
    new HydrexSwapRouteAdapter(),
    new BalancerSwapRouteAdapter(),
  ];
}

export function getEligibleSwapAdapters(
  intent: RouteIntentV1,
  adapters: readonly SwapRouteAdapter[] = createDefaultSwapAdapters(),
): SwapAdapterSelectionResult {
  const unique = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  // A generic comparison includes only released quote adapters. Manifested
  // providers enter the engine when explicitly requested and return an honest
  // typed failure until their quote/build/proof vertical passes its gate.
  let allowed = new Set<SwapAdapterId>(RELEASED_ADAPTER_ORDER);
  if (intent.protocolConstraint.mode === 'include_only') {
    allowed = new Set(
      intent.protocolConstraint.protocols.filter(
        (protocol): protocol is SwapAdapterId => ADAPTER_ORDER.includes(protocol as SwapAdapterId),
      ),
    );
  } else if (intent.protocolConstraint.mode === 'exclude') {
    for (const protocol of intent.protocolConstraint.protocols) {
      if (ADAPTER_ORDER.includes(protocol as SwapAdapterId)) allowed.delete(protocol as SwapAdapterId);
    }
  }

  const selected = ADAPTER_ORDER.flatMap((id) => {
    const adapter = unique.get(id);
    return adapter && allowed.has(id) && adapter.supports(intent) ? [adapter] : [];
  });
  return selected.length > 0
    ? { outcome: 'selected', adapters: selected }
    : {
        outcome: 'no_eligible_adapters',
        adapters: [],
        errorCode: 'no_eligible_swap_adapters',
      };
}
