import { ToolAggregator } from './aggregator.js';
import { NativeToolProvider } from './native.js';
import { getUserSettings, getDecryptedKey } from '@mioagent/settings';
import {
  MockCoinGeckoProvider, MockMoralisProvider, MockDeFiLlamaProvider, MockGoPlusProvider,
  RealCoinGeckoProvider, RealMoralisProvider, RealDeFiLlamaProvider, RealGoPlusProvider
} from '@mioagent/data-providers';

export async function createToolAggregatorForUser(userId: string, sessionSecret: string): Promise<ToolAggregator> {
  const aggregator = new ToolAggregator();
  const settings = await getUserSettings(userId);

  const toggles = settings?.protocolToggles as Record<string, boolean> | undefined;

  const useCoinGecko = toggles?.coingecko === true;
  const useMoralis = toggles?.moralis === true;
  // While we created defi_llama and goplus real providers, the native tool provider currently only uses coingecko and moralis.
  // We'll prepare them here just in case they get added to native tools later, or to a different provider.
  // But currently native only takes CoinGecko and Moralis.
  // Let's stick to Native for now.

  const coinGeckoProvider = useCoinGecko ? new RealCoinGeckoProvider() : new MockCoinGeckoProvider();
  let moralisProvider: MockMoralisProvider | RealMoralisProvider = new MockMoralisProvider();

  if (useMoralis) {
    try {
      const moralisKey = await getDecryptedKey(userId, 'moralis_api_key', sessionSecret);
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
