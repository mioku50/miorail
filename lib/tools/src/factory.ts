import { ToolAggregator } from './aggregator.js';
import { NativeToolProvider } from './native.js';
import * as settingsModule from '@mioagent/settings';
import {
  MockCoinGeckoProvider, MockMoralisProvider,
  RealCoinGeckoProvider, RealMoralisProvider
} from '@mioagent/data-providers';

// Allow overriding settings in tests via an injected interface or similar, or just let node:test mock handle it if configured right.
// We can expose an internal configurable getter.
export const settingsAPI = {
    getUserSettings: settingsModule.getUserSettings,
    getDecryptedKey: settingsModule.getDecryptedKey
};

export async function createToolAggregatorForUser(userId: string, sessionSecret: string): Promise<ToolAggregator> {
  const aggregator = new ToolAggregator();
  const settings = await settingsAPI.getUserSettings(userId);

  const toggles = settings?.protocolToggles as Record<string, boolean> | undefined;

  const useCoinGecko = toggles?.coingecko === true;
  const useMoralis = toggles?.moralis === true;

  const coinGeckoProvider = useCoinGecko ? new RealCoinGeckoProvider() : new MockCoinGeckoProvider();
  let moralisProvider: MockMoralisProvider | RealMoralisProvider = new MockMoralisProvider();

  if (useMoralis) {
    try {
      const moralisKey = await settingsAPI.getDecryptedKey(userId, 'moralis_api_key', sessionSecret);
      if (moralisKey) {
        moralisProvider = new RealMoralisProvider(moralisKey);
      }
    } catch {
      // Fallback to mock silently to prevent leaking secrets/errors
    }
  }

  // Register NativeToolProvider
  aggregator.registerProvider(new NativeToolProvider(coinGeckoProvider, moralisProvider));

  return aggregator;
}
