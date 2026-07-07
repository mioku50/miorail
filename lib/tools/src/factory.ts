import { ToolAggregator } from './aggregator.js';
import { NativeToolProvider } from './native.js';
import { BaseMcpToolProvider } from './base_mcp.js';
import type { BaseMcpOAuthProvider } from '@mioagent/mcp';
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

export interface CreateToolAggregatorOptions {
  baseMcpEnabled?: boolean;
  baseMcpServerUrl?: string;
  baseMcpOAuthProvider?: BaseMcpOAuthProvider;
}

function parseBool(value?: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes((value || '').trim().toLowerCase());
}

let warnedLegacyBaseMcpUrl = false;

function baseMcpServerUrlFromEnv(): string | undefined {
  const canonical = process.env.BASE_MCP_SERVER_URL;
  const legacy = process.env.MCP_SERVER_URL || process.env.BASE_MCP_URL;
  if (!canonical && legacy && !warnedLegacyBaseMcpUrl) {
    warnedLegacyBaseMcpUrl = true;
    console.warn('BASE_MCP_SERVER_URL is the canonical Base MCP env; MCP_SERVER_URL and BASE_MCP_URL are deprecated aliases.');
  }
  return canonical || legacy || undefined;
}

export async function createToolAggregatorForUser(userId: string, sessionSecret: string, options: CreateToolAggregatorOptions = {}): Promise<ToolAggregator> {
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

  const baseMcpEnabled = options.baseMcpEnabled ?? parseBool(process.env.BASE_MCP_ENABLED);
  const baseMcpServerUrl = options.baseMcpServerUrl || baseMcpServerUrlFromEnv();
  let mcpClient: any;

  if (baseMcpEnabled && baseMcpServerUrl && options.baseMcpOAuthProvider) {
    const { BaseMcpClient, createBaseMcpHttpTransport, McpSendCallsClient } = await import('@mioagent/mcp');

    try {
      const baseClient = new BaseMcpClient();
      const transport = createBaseMcpHttpTransport(new URL(baseMcpServerUrl), options.baseMcpOAuthProvider);
      await baseClient.connect(transport);
      mcpClient = new McpSendCallsClient(baseClient);
      aggregator.registerProvider(new BaseMcpToolProvider(mcpClient));
    } catch (e) {
      console.error('Failed to initialize Base MCP client:', e);
    }
  }

  if (process.env.CHAIN_ENV === 'sepolia') {
    const { SepoliaToolProvider } = await import('./sepolia.js');
    aggregator.registerProvider(new SepoliaToolProvider(mcpClient));
  } else if (process.env.NODE_ENV === 'test') {
    const { MockMcpToolProvider } = await import('./mock_mcp.js');
    aggregator.registerProvider(new MockMcpToolProvider());
  }

  return aggregator;
}
