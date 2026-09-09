import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { filterTrustedMorphoVaults, formatTrustedMorphoVaults } from './morphoVaultTrust.js';
import { extractWalletAddresses } from './baseMcpWalletReconciliation.js';
import type { BaseMcpWalletMatchResult } from './baseMcpWalletReconciliation.js';
import { BASE_MCP_DIFFERENT_WALLET_NOTICE, type WalletEnvironment } from './walletContext.js';

export type DirectStreamReadKind = 'base_portfolio' | 'morpho_usdc_vaults' | 'partner_provider_unavailable' | 'partner_provider_required';

export interface StreamToolTrace {
  toolName: string;
  args: Record<string, unknown>;
  result: { status: 'success' | 'error'; errorCode?: string };
  isError: boolean;
}

export interface DirectStreamReadResult {
  kind: DirectStreamReadKind;
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
}

const PRIVATE_KEY_NAMES = /^(access_?token|refresh_?token|id_?token|api_?token|secret|authorization|cookie|password|private_?key|credential|signature)$/i;
const READ_LANGUAGE = /show|find|list|check|query|view|available|opportunit|position|market|vault|pool|rate|apy|yield/;
const READ_NOUN_LANGUAGE = /\b(?:supply|borrow|deposit)\s+(?:apy|rates?|markets?|yield|opportunit(?:y|ies))\b|\b(?:apy|rates?|markets?|yield|opportunit(?:y|ies))\s+(?:for\s+)?(?:supply|borrow|deposit)\b/;
const QUANTIFIED_WRITE_LANGUAGE = /\b(?:supply|deposit|withdraw|borrow|repay|swap|send|transfer)\s+(?:all|max|\$?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:usdc|eth|tokens?))/;
const FUNDS_WRITE_LANGUAGE = /\b(?:supply|deposit|withdraw|repay|send|transfer)\s+(?:my\s+|the\s+)?(?:funds?|assets?|tokens?|usdc|eth)\b/;
const EXPLICIT_WRITE_LANGUAGE = /\b(?:sign|execute|prepare)\b|\b(?:make|create|submit)\s+(?:a\s+)?transaction\b/;
const PROVIDER_NAMES = new Map<string, string>([
  ['morpho', 'Morpho'],
  ['moonwell', 'Moonwell'],
  ['uniswap', 'Uniswap'],
  ['avantis', 'Avantis'],
  ['virtuals', 'Virtuals'],
  ['aerodrome', 'Aerodrome'],
  ['bankr', 'Bankr'],
]);

export interface ProviderReadScope {
  namespace: string;
  displayName: string;
  matchingTools: ToolDef[];
}

export interface RequestedProvider {
  namespace: string;
  displayName: string;
  matchingTools: ToolDef[];
}

export function toolMatchesProviderNamespace(toolName: string, namespace: string): boolean {
  const lower = toolName.toLowerCase();
  return lower === namespace || lower.startsWith(`${namespace}_`) || lower.startsWith(`${namespace}:`)
    || lower.startsWith(`${namespace}.`) || lower.startsWith(`${namespace}-`) || lower.startsWith(`${namespace}/`);
}

export function detectRequestedProvider(message: string, inventory: ToolDef[]): RequestedProvider | null {
  const lower = message.trim().toLowerCase();
  let namespace: string | undefined;
  let displayName: string | undefined;
  for (const [candidate, label] of PROVIDER_NAMES) {
    if (new RegExp(`\\b${candidate}\\b`, 'i').test(lower)) {
      namespace = candidate;
      displayName = label;
      break;
    }
  }
  if (!namespace) {
    const discovered = inventory
      .map((tool) => tool.name.toLowerCase().split(/[_:.\-/]/)[0])
      .filter((value): value is string => !!value && !['get', 'list', 'query', 'read', 'search', 'check'].includes(value));
    namespace = discovered.find((candidate) => new RegExp(`\\b${candidate}\\b`, 'i').test(lower));
    displayName = namespace ? namespace.charAt(0).toUpperCase() + namespace.slice(1) : undefined;
  }
  if (!namespace || !displayName) return null;
  return {
    namespace,
    displayName,
    matchingTools: inventory.filter((tool) => toolMatchesProviderNamespace(tool.name, namespace!)),
  };
}

export function isPartnerWriteCommand(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (READ_NOUN_LANGUAGE.test(lower)) return false;
  return QUANTIFIED_WRITE_LANGUAGE.test(lower)
    || FUNDS_WRITE_LANGUAGE.test(lower)
    || EXPLICIT_WRITE_LANGUAGE.test(lower);
}

export function isAmbiguousPartnerMarketRead(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return READ_NOUN_LANGUAGE.test(lower) && !isPartnerWriteCommand(message);
}

export function detectProviderReadScope(message: string, inventory: ToolDef[]): ProviderReadScope | null {
  // Resolve an explicit provider first. Words such as "supply" are ambiguous:
  // they are read nouns in "supply markets" and commands in "supply 10 USDC".
  const provider = detectRequestedProvider(message, inventory);
  if (!provider || isPartnerWriteCommand(message)) return null;
  const lower = message.trim().toLowerCase();
  if (!READ_LANGUAGE.test(lower) && !READ_NOUN_LANGUAGE.test(lower)) return null;
  return provider;
}

export function sanitizeStreamToolArgs(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeStreamToolArgs(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string'
      ? [...value].map((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 500)
      : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = PRIVATE_KEY_NAMES.test(key) ? '[redacted]' : sanitizeStreamToolArgs(inner, depth + 1);
  }
  return output;
}

export function sanitizedToolErrorCode(content: unknown, fallback = 'tool_call_failed'): string {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    const raw = parsed && typeof parsed === 'object'
      ? String((parsed as Record<string, unknown>).errorCode || (parsed as Record<string, unknown>).error || '')
      : '';
    const normalized = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized && normalized.length <= 80 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

export function detectDirectStreamRead(message: string): DirectStreamReadKind | null {
  const lower = message.trim().toLowerCase();
  const morphoVaultRead = lower.includes('morpho')
    && (lower.includes('vault') || lower.includes('yield') || lower.includes('opportunit'))
    && !/deposit|withdraw|supply|borrow|repay|prepare|execute|transaction/.test(lower);
  if (morphoVaultRead) return 'morpho_usdc_vaults';

  const analytical = /review|analy[sz]e|rebalance|recommend|risk|security|plan|optim[sz]e|monitor|scan/.test(lower);
  const walletRead = /balance|portfolio|how much\s+usdc|usdc.*have|holdings/.test(lower);
  if (walletRead && !analytical) return 'base_portfolio';
  return null;
}

export function shouldPreferPartnerRuntimeRead(message: string, inventory: ToolDef[]): boolean {
  return (detectProviderReadScope(message, inventory)?.matchingTools.length || 0) > 0;
}

function schemaProperties(tool: ToolDef): Record<string, any> {
  const properties = tool.inputSchema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, any>
    : {};
}

/**
 * A page size the wallet actually fits in.
 *
 * `get_portfolio` pages, and this builder never said how big a page it wanted,
 * so the provider used its own default of 15. A wallet holding 22 tokens was
 * reported as 15 — the same failure class as the balance cap our own provider
 * had, one surface over — and the payload printed underneath it even carried
 * `hasMore: false`. Asking for a bounded page we can show is the difference
 * between a truncated answer and a complete one.
 */
export const BASE_READ_PAGE_LIMIT_V1 = 100;

function buildBaseReadArgs(tool: ToolDef, walletAddress?: string): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const normalized = key.toLowerCase();
    if (['address', 'walletaddress', 'useraddress', 'accountaddress'].includes(normalized) && walletAddress) {
      args[key] = walletAddress;
    } else if (normalized === 'chainid') {
      args[key] = 8453;
    } else if (normalized === 'limit' || normalized === 'pagesize') {
      args[key] = BASE_READ_PAGE_LIMIT_V1;
    } else if (normalized === 'chain' || normalized === 'network') {
      const values = Array.isArray(properties[key]?.enum) ? properties[key].enum : [];
      args[key] = values.includes('base') ? 'base' : values.includes('eip155:8453') ? 'eip155:8453' : 'base';
    }
  }
  return args;
}

function unwrapToolPayload(content: string): unknown {
  let value: unknown = content;
  for (let i = 0; i < 3; i += 1) {
    if (typeof value === 'string') {
      const stringValue = value;
      try { value = JSON.parse(stringValue); } catch { return stringValue.slice(0, 20_000); }
      continue;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, any>;
      if (Array.isArray(obj.content)) {
        const text = obj.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
        if (text) { value = text; continue; }
      }
    }
    break;
  }
  return sanitizeStreamToolArgs(value);
}

function displayPayload(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 12_000);
  const json = JSON.stringify(value, null, 2);
  return (json || 'No records returned.').slice(0, 12_000);
}

async function callReadTool(
  tools: ToolAggregator,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<{ content: string; trace: StreamToolTrace; errorCode?: string }> {
  const safeArgs = sanitizeStreamToolArgs(args) as Record<string, unknown>;
  try {
    const result = await tools.callTool(tool.name, args);
    const errorCode = result.isError ? sanitizedToolErrorCode(result.content) : undefined;
    return {
      content: result.content,
      errorCode,
      trace: {
        toolName: tool.name,
        args: safeArgs,
        result: { status: result.isError ? 'error' : 'success', ...(errorCode ? { errorCode } : {}) },
        isError: result.isError,
      },
    };
  } catch {
    return {
      content: '',
      errorCode: 'tool_call_failed',
      trace: {
        toolName: tool.name,
        args: safeArgs,
        result: { status: 'error', errorCode: 'tool_call_failed' },
        isError: true,
      },
    };
  }
}

export async function runDirectStreamRead(input: {
  message: string;
  walletAddress?: string;
  tools: ToolAggregator;
  walletEnvironment?: WalletEnvironment;
  walletMatch?: BaseMcpWalletMatchResult;
  nativePortfolioReader?: (walletAddress: string) => Promise<unknown>;
}): Promise<DirectStreamReadResult | null> {
  const kind = detectDirectStreamRead(input.message);
  const inventory = await input.tools.listTools();
  const traces: StreamToolTrace[] = [];

  if (!kind) {
    const providerScope = detectProviderReadScope(input.message, inventory);
    if (providerScope && providerScope.matchingTools.length === 0) {
      return {
        kind: 'partner_provider_unavailable',
        content: `${providerScope.displayName} read tools are unavailable.`,
        toolCalls: traces,
        errorCode: `${providerScope.namespace}_tools_unavailable`,
      };
    }
    if (!providerScope && isAmbiguousPartnerMarketRead(input.message)) {
      return {
        kind: 'partner_provider_required',
        content: 'Specify a provider, such as Moonwell or Morpho, before requesting supply markets or rates.',
        toolCalls: traces,
        errorCode: 'partner_provider_required',
      };
    }
    return null;
  }

  if (kind === 'morpho_usdc_vaults') {
    const tool = inventory.find((item) => item.name === 'morpho_query_vaults');
    if (!tool) {
      return {
        kind,
        content: 'Morpho read tools are currently unavailable. No transaction was prepared.',
        toolCalls: traces,
        errorCode: 'morpho_tools_unavailable',
      };
    }
    const call = await callReadTool(input.tools, tool, {
      chain: 'base',
      assetSymbol: 'USDC',
      sort: 'tvl_desc',
      limit: 50,
    });
    traces.push(call.trace);
    if (call.errorCode) {
      return {
        kind,
        content: `Morpho vault data is temporarily unavailable (${call.errorCode}). No transaction was prepared.`,
        toolCalls: traces,
        errorCode: call.errorCode,
      };
    }
    const trustworthyVaults = filterTrustedMorphoVaults(unwrapToolPayload(call.content));
    if (trustworthyVaults.length === 0) {
      return {
        kind,
        content: 'No trustworthy Morpho USDC vault results remained after Base mainnet, canonical USDC, verification, TVL, and APY screening. No transaction was prepared.',
        toolCalls: traces,
        errorCode: 'morpho_no_trustworthy_vaults',
      };
    }
    return {
      kind,
      content: `Live screened Morpho USDC vault results on Base:\n${formatTrustedMorphoVaults(trustworthyVaults)}\n\nOrdered by verification metadata and TVL; this is not a recommendation. No deposit or transaction was prepared.`,
      toolCalls: traces,
    };
  }

  const nativePortfolio = async (notice?: string): Promise<DirectStreamReadResult | null> => {
    if (!input.walletAddress || !input.nativePortfolioReader) return null;
    try {
      const portfolio = await input.nativePortfolioReader(input.walletAddress);
      return {
        kind,
        content: [
          ...(notice ? [notice, ''] : []),
          `Live portfolio for the authenticated BaseApp wallet:\n${displayPayload(sanitizeStreamToolArgs(portfolio))}`,
        ].join('\n'),
        toolCalls: traces,
      };
    } catch {
      return {
        kind,
        content: 'The native portfolio provider could not read the authenticated tenant wallet.',
        toolCalls: traces,
        errorCode: 'native_portfolio_unavailable',
      };
    }
  };

  // BaseApp is always tenant-wallet first. No OAuth-wallet lookup is needed to
  // display balances, and no Base MCP address can substitute for the SIWE one.
  if (input.walletEnvironment === 'baseapp') {
    const notice = input.walletMatch?.checked && !input.walletMatch.match
      ? BASE_MCP_DIFFERENT_WALLET_NOTICE
      : undefined;
    const native = await nativePortfolio(notice);
    if (native) return native;
  }

  const portfolioTool = inventory.find((item) => item.name === 'get_portfolio');
  const walletsTool = inventory.find((item) => item.name === 'get_wallets');
  let walletAddress = input.walletAddress;

  if (input.walletMatch?.checked && !input.walletMatch.match) {
    const native = await nativePortfolio(BASE_MCP_DIFFERENT_WALLET_NOTICE);
    if (native) return native;
    return {
      kind,
      content: BASE_MCP_DIFFERENT_WALLET_NOTICE,
      toolCalls: traces,
      errorCode: 'base_mcp_wallet_mismatch',
    };
  }

  // The SIWE session remains authoritative, but Base MCP may accept only an
  // address returned by its user-scoped get_wallets tool. Reconcile first and
  // never query or display a different account as a fallback.
  if (walletsTool) {
    const wallets = await callReadTool(input.tools, walletsTool, buildBaseReadArgs(walletsTool));
    traces.push(wallets.trace);
    if (!wallets.errorCode) {
      const mcpAddresses = extractWalletAddresses(wallets.content);
      if (walletAddress && mcpAddresses.length > 0 && !mcpAddresses.includes(walletAddress.toLowerCase())) {
        const native = await nativePortfolio(BASE_MCP_DIFFERENT_WALLET_NOTICE);
        if (native) return native;
        return {
          kind,
          content: BASE_MCP_DIFFERENT_WALLET_NOTICE,
          toolCalls: traces,
          errorCode: 'base_mcp_wallet_mismatch',
        };
      }
      if (!walletAddress && mcpAddresses.length > 0) walletAddress = mcpAddresses[0];
    }
  }

  if (!portfolioTool) {
    const native = await nativePortfolio();
    if (native) return native;
    return {
      kind,
      content: 'Base MCP get_portfolio is unavailable. No substitute provider data was returned.',
      toolCalls: traces,
      errorCode: 'base_mcp_portfolio_tool_unavailable',
    };
  }

  const portfolio = await callReadTool(input.tools, portfolioTool, buildBaseReadArgs(portfolioTool, walletAddress));
  traces.push(portfolio.trace);
  if (portfolio.errorCode) {
    return {
      kind,
      content: `Base MCP could not read the portfolio (${portfolio.errorCode}). Reconnect Base MCP and retry.`,
      toolCalls: traces,
      errorCode: portfolio.errorCode,
    };
  }
  return {
    kind,
    content: `Live Base MCP portfolio result:\n${displayPayload(unwrapToolPayload(portfolio.content))}`,
    toolCalls: traces,
  };
}
