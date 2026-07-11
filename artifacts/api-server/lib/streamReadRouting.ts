import type { ToolAggregator, ToolDef } from '@mioagent/tools';

export type DirectStreamReadKind = 'base_portfolio' | 'morpho_usdc_vaults';

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

export function sanitizeStreamToolArgs(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeStreamToolArgs(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : value;
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
  const lower = message.trim().toLowerCase();
  if (/deposit|withdraw|supply|borrow|repay|swap|send|transfer|sign|execute|prepare|transaction/.test(lower)) {
    return false;
  }
  if (!/show|find|list|check|query|view|available|opportunit|position|market|vault|pool|rate|apy/.test(lower)) {
    return false;
  }
  const namespaces = inventory
    .map((tool) => tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0])
    .filter((name): name is string => !!name && !['get', 'list', 'query', 'read', 'search', 'check'].includes(name));
  return namespaces.some((namespace) => lower.includes(namespace));
}

function schemaProperties(tool: ToolDef): Record<string, any> {
  const properties = tool.inputSchema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, any>
    : {};
}

function buildBaseReadArgs(tool: ToolDef, walletAddress?: string): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const normalized = key.toLowerCase();
    if (['address', 'walletaddress', 'useraddress', 'accountaddress'].includes(normalized) && walletAddress) {
      args[key] = walletAddress;
    } else if (normalized === 'chainid') {
      args[key] = 8453;
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

function extractWalletAddress(content: string): string | undefined {
  return content.match(/0x[a-fA-F0-9]{40}/)?.[0];
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
}): Promise<DirectStreamReadResult | null> {
  const kind = detectDirectStreamRead(input.message);
  if (!kind) return null;
  const inventory = await input.tools.listTools();
  const traces: StreamToolTrace[] = [];

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
      sort: 'apy_desc',
      limit: 5,
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
    return {
      kind,
      content: `Live Morpho USDC vault opportunities on Base:\n${displayPayload(unwrapToolPayload(call.content))}\n\nRead-only result — no deposit or transaction was prepared.`,
      toolCalls: traces,
    };
  }

  const portfolioTool = inventory.find((item) => item.name === 'get_portfolio');
  const walletsTool = inventory.find((item) => item.name === 'get_wallets');
  let walletAddress = input.walletAddress;

  if (!walletAddress && walletsTool) {
    const wallets = await callReadTool(input.tools, walletsTool, buildBaseReadArgs(walletsTool));
    traces.push(wallets.trace);
    if (!wallets.errorCode) walletAddress = extractWalletAddress(wallets.content);
  }

  if (!portfolioTool) {
    return {
      kind,
      content: 'Base MCP OAuth may be connected, but the required get_portfolio tool is not available. Reconnect Base MCP and retry.',
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
