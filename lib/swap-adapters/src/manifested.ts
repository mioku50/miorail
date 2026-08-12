import { protocolAllowsAdapter, supportsSwapIntent } from './normalization.js';
import type {
  ManifestedSwapAdapterId,
  SwapAdapterQuoteInput,
  SwapAdapterResult,
  SwapRouteAdapter,
} from './types.js';

/**
 * A provider that is owned by Routes and understood by the intent pipeline,
 * but has not passed quote/build/proof gates yet.
 *
 * This is deliberately a typed failure adapter, not a fake quote. It lets an
 * explicit provider request reach Route Engine and return a provider-specific
 * `Not available` fact without silently falling back to Uniswap/KyberSwap.
 */
export class ManifestedSwapRouteAdapter implements SwapRouteAdapter {
  constructor(readonly id: ManifestedSwapAdapterId) {}

  supports(intent: Parameters<SwapRouteAdapter['supports']>[0]): boolean {
    return supportsSwapIntent(intent) && protocolAllowsAdapter(intent, this.id);
  }

  async quote(_input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    return {
      outcome: 'not_configured',
      provider: this.id,
      errorCode: `${this.id.replace(/-/g, '_')}_route_adapter_not_released`,
      retryable: false,
    };
  }
}
