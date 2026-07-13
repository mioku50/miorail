import { ToolAggregator } from './aggregator.js';
import { NativeToolProvider } from './native.js';
import { BaseMcpToolProvider } from './base_mcp.js';
import { DynamicBaseMcpToolProvider, type DynamicBaseMcpTool } from './dynamic_base_mcp.js';
import { listDynamicBaseMcpToolsCached, dynamicBaseMcpCacheKey } from './dynamicBaseMcpCache.js';
import { MorphoMcpToolProvider } from './morpho_mcp.js';
import { UniswapQuoteToolProvider } from './uniswap_quote.js';
import { MoonwellHttpToolProvider } from './moonwell_http.js';
import { resolvePluginCredential } from '@mioagent/security/httpAllowlist';
import type { BaseMcpOAuthProvider } from '@mioagent/mcp';
import * as settingsModule from '@mioagent/settings';
import {
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
  baseMcpReadOnlyOnly?: boolean;
  includeMorphoReadOnly?: boolean;
  includeUniswapQuote?: boolean;
  includeMoonwell?: boolean;
  includeBaseMcpSwap?: boolean;
  includeBaseMcpSend?: boolean;
  /**
   * T48b: version tag for the bounded TTL inventory cache
   * (dynamicBaseMcpCache.ts), typically derived from the user's Base MCP
   * oauth-token state (e.g. connectedAt+expiresAt). Changing this value
   * busts the cache immediately; a stable value across calls reuses the
   * cached `listTools()` result for up to the cache TTL (~60s).
   */
  dynamicToolsCacheVersion?: string;
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

function baseMcpCatalogEnabled(toggles?: Record<string, boolean>): boolean {
  return toggles?.base_mcp !== false && toggles?.['base-mcp'] !== false;
}

export function selectBaseMcpRuntimeTools(
  tools: DynamicBaseMcpTool[],
  readOnlyOnly = false,
  includeUserConfirmedSwap = false,
  includeUserConfirmedSend = false,
): DynamicBaseMcpTool[] {
  return readOnlyOnly
    ? tools.filter((tool) => (tool.capability === 'read_only' && tool.enabled)
      || (includeUserConfirmedSwap && tool.capability === 'user_confirmed_transaction' && tool.group === 'swap')
      || (includeUserConfirmedSend && tool.capability === 'user_confirmed_transaction' && tool.group === 'base'
        && /^(?:send|transfer|send_token|transfer_token)$/i.test(tool.name)))
    : tools;
}

export async function createToolAggregatorForUser(userId: string, sessionSecret: string, options: CreateToolAggregatorOptions = {}): Promise<ToolAggregator> {
  const aggregator = new ToolAggregator();
  const settings = await settingsAPI.getUserSettings(userId);

  const toggles = settings?.protocolToggles as Record<string, boolean> | undefined;

  const useCoinGecko = toggles?.coingecko === true;
  const useMoralis = toggles?.moralis === true;

  const coinGeckoProvider = useCoinGecko ? new RealCoinGeckoProvider() : undefined;
  let moralisProvider: RealMoralisProvider | undefined;

  if (useMoralis) {
    try {
      const moralisKey = await settingsAPI.getDecryptedKey(userId, 'moralis_api_key', sessionSecret);
      if (moralisKey) {
        moralisProvider = new RealMoralisProvider(moralisKey);
      }
    } catch {
      // Real-or-fail-closed: do not substitute balances when the encrypted
      // credential cannot be opened.
    }
  }

  if (coinGeckoProvider || moralisProvider) {
    aggregator.registerProvider(new NativeToolProvider(coinGeckoProvider, moralisProvider));
  }

  const baseMcpEnabled = options.baseMcpEnabled ?? parseBool(process.env.BASE_MCP_ENABLED);
  const baseMcpServerUrl = options.baseMcpServerUrl || baseMcpServerUrlFromEnv();
  let mcpClient: any;

  if (baseMcpEnabled && baseMcpServerUrl && options.baseMcpOAuthProvider && baseMcpCatalogEnabled(toggles)) {
    const { BaseMcpClient, createBaseMcpHttpTransport, McpSendCallsClient } = await import('@mioagent/mcp');

    try {
      const baseClient = new BaseMcpClient();
      const transport = createBaseMcpHttpTransport(new URL(baseMcpServerUrl), options.baseMcpOAuthProvider);
      await baseClient.connect(transport);
      aggregator.registerCleanup(() => baseClient.close());
      mcpClient = new McpSendCallsClient(baseClient);
      if (!options.baseMcpReadOnlyOnly) {
        aggregator.registerProvider(new BaseMcpToolProvider(mcpClient));
      }
      try {
        const cacheKey = dynamicBaseMcpCacheKey(userId, options.dynamicToolsCacheVersion);
        const discoveredTools = await listDynamicBaseMcpToolsCached(baseClient, cacheKey, toggles);
        const dynamicTools = selectBaseMcpRuntimeTools(
          discoveredTools,
          options.baseMcpReadOnlyOnly,
          options.includeBaseMcpSwap,
          options.includeBaseMcpSend,
        );
        if (dynamicTools.length > 0) {
          aggregator.registerProvider(new DynamicBaseMcpToolProvider(baseClient, dynamicTools, {
            allowUserConfirmedSwap: options.includeBaseMcpSwap,
            allowUserConfirmedSend: options.includeBaseMcpSend,
          }));
        }
      } catch (error) {
        console.warn('Failed to list dynamic Base MCP tools', {
          code: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    } catch (e) {
      console.error('Failed to initialize Base MCP client', {
        code: e instanceof Error ? e.name : 'unknown_error',
      });
    }
  }

  if (options.includeMorphoReadOnly && toggles?.morpho !== false) {
    aggregator.registerProvider(new MorphoMcpToolProvider());
  }

  if (options.includeUniswapQuote && toggles?.uniswap !== false) {
    // T48b: BASE_MCP_PLUGIN_MODE default 'mcp' resolves UNISWAP_MCP_GATEWAY_KEY
    // here; UNISWAP_API_KEY is only consulted in 'direct' mode. Registration
    // never fails or gates on UNISWAP_API_KEY being unset in mcp mode — the
    // provider itself already degrades to an empty tool list when no
    // credential is configured (read-only quote availability, not a crash).
    aggregator.registerProvider(new UniswapQuoteToolProvider(undefined, resolvePluginCredential('uniswap')));
  }

  // Moonwell is a plain HTTP API (no MCP server, no API key). It is a Base
  // mainnet product, so it is only registered outside the Sepolia runtime.
  if (options.includeMoonwell && toggles?.moonwell !== false && process.env.CHAIN_ENV !== 'sepolia') {
    aggregator.registerProvider(new MoonwellHttpToolProvider());
  }

  if (process.env.CHAIN_ENV === 'sepolia' && !options.baseMcpReadOnlyOnly) {
    const { SepoliaToolProvider } = await import('./sepolia.js');
    aggregator.registerProvider(new SepoliaToolProvider(mcpClient));
  }

  return aggregator;
}
