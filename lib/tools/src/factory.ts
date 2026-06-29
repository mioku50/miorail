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
  console.log("TRACE: createToolAggregatorForUser before getUserSettings");
  const settings = await settingsAPI.getUserSettings(userId);
  console.log("TRACE: createToolAggregatorForUser after getUserSettings");

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

  if (process.env.CHAIN_ENV === 'sepolia') {
    const { SepoliaToolProvider } = await import('./sepolia.js');
    const { BaseMcpClient, createBaseMcpSseTransport, McpSendCallsClient } = await import('@mioagent/mcp');

    let mcpClient: any;
    if (process.env.MCP_SERVER_URL) {
      try {
        const baseClient = new BaseMcpClient();
        const transport = createBaseMcpSseTransport(new URL(process.env.MCP_SERVER_URL));
        await baseClient.connect(transport);
        mcpClient = new McpSendCallsClient(baseClient);
      } catch (e) {
        console.error('Failed to initialize MCP client:', e);
      }
    }
    aggregator.registerProvider(new SepoliaToolProvider(mcpClient));
  } else if (process.env.NODE_ENV === 'test') {
    const { MockMcpToolProvider } = await import('./mock_mcp.js');
    aggregator.registerProvider(new MockMcpToolProvider());
  }

  return aggregator;
}
