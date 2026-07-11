import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { screenAction } from '@mioagent/security';
import { loadTokenSecurityContext } from './executionSecurity.js';
import { sanitizeStreamToolArgs, sanitizedToolErrorCode, type StreamToolTrace } from './streamReadRouting.js';
import { getAutonomyPolicyRepository } from './autonomyGateway.js';

const TOKENS: Record<string, string | undefined> = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006',
  ETH: undefined,
};

export interface DirectBaseMcpSwapResult {
  kind: 'base_mcp_swap';
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
  approvalUrl?: string;
  requestId?: string;
}

export const baseMcpSwapRuntime = {
  getPolicy: (userId: string) => getAutonomyPolicyRepository().getByUser(userId, 8453),
};

export function detectSwapIntent(message: string): { amount: string; tokenIn: string; tokenOut: string } | null {
  if (/\b(?:quote|estimate|route|price impact)\b/i.test(message)) return null;
  const match = message.match(/\b(?:swap|exchange)\s+(\d+(?:\.\d+)?)\s+(USDC|WETH|ETH)\s+(?:to|for|into)\s+(USDC|WETH|ETH)\b/i);
  if (!match || match[2].toUpperCase() === match[3].toUpperCase()) return null;
  return { amount: match[1], tokenIn: match[2].toUpperCase(), tokenOut: match[3].toUpperCase() };
}

function swapToolFromProviderInventory(inventory: Array<{ providerId: string; tools: ToolDef[] }>): ToolDef | undefined {
  const tools = inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools);
  return tools.find((tool) => /^(?:swap|swap_tokens|token_swap)$/i.test(tool.name));
}

function mapArgs(tool: ToolDef, intent: { amount: string; tokenIn: string; tokenOut: string }, walletAddress: string) {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const put = (aliases: string[], value: unknown) => {
    const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (key) args[key] = value;
  };
  put(['amount', 'amountIn', 'fromAmount', 'sellAmount'], intent.amount);
  put(['fromToken', 'tokenIn', 'sellToken', 'inputToken', 'from'], intent.tokenIn);
  put(['toToken', 'tokenOut', 'buyToken', 'outputToken', 'to'], intent.tokenOut);
  put(['walletAddress', 'address', 'swapper'], walletAddress);
  put(['chainId'], 8453);
  put(['chain', 'network'], 'base');
  return Object.keys(args).length > 0
    ? args
    : { amount: intent.amount, fromToken: intent.tokenIn, toToken: intent.tokenOut, walletAddress, chainId: 8453 };
}

function approvalReference(value: unknown, depth = 0): { approvalUrl: string; requestId: string } | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return approvalReference(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = approvalReference(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.approvalUrl === 'string' && typeof record.requestId === 'string') {
    try {
      const url = new URL(record.approvalUrl);
      if (url.protocol === 'https:' && record.requestId.length > 0 && record.requestId.length <= 200) {
        return { approvalUrl: url.toString(), requestId: record.requestId };
      }
    } catch {
      return null;
    }
  }
  if (record.type === 'text' && typeof record.text === 'string') return approvalReference(record.text, depth + 1);
  for (const item of Object.values(record)) {
    const found = approvalReference(item, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function runDirectBaseMcpSwap(input: {
  message: string;
  walletAddress?: string;
  tools: ToolAggregator;
  userConfirmedEnabled: boolean;
  userId: string;
}): Promise<DirectBaseMcpSwapResult | null> {
  const intent = detectSwapIntent(input.message);
  if (!intent) return null;
  if (!input.userConfirmedEnabled) {
    return { kind: 'base_mcp_swap', content: 'Mainnet is read-only. No swap was requested.', toolCalls: [], errorCode: 'mainnet_readonly' };
  }
  if (!input.walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) {
    return { kind: 'base_mcp_swap', content: 'Connect Base Account before requesting a swap.', toolCalls: [], errorCode: 'swap_wallet_required' };
  }
  const policy = await baseMcpSwapRuntime.getPolicy(input.userId).catch(() => undefined);
  if (!policy || !policy.isActive || policy.killSwitch || !policy.mainnetOptIn
    || policy.expiresAt <= Date.now() || policy.walletAddress !== input.walletAddress.toLowerCase()) {
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP swap is blocked until the active mainnet policy and connected wallet pass readiness checks.',
      toolCalls: [],
      errorCode: 'mainnet_policy_not_ready',
    };
  }

  const tokenAddress = TOKENS[intent.tokenIn];
  if (tokenAddress) {
    const security = await loadTokenSecurityContext(8453, [tokenAddress.toLowerCase()]);
    const verdict = security.tokenSecurity.find((item) => item.address.toLowerCase() === tokenAddress.toLowerCase());
    const screening = screenAction({
      instruction: input.message,
      providerContext: { ...security.providerContext, requiresTokenSecurity: true },
    });
    if (!screening.allowed || !verdict || verdict.provider !== 'goplus' || !['ok', 'warning'].includes(verdict.status)) {
      return {
        kind: 'base_mcp_swap',
        content: `Swap blocked: no usable GoPlus verdict for ${intent.tokenIn}.`,
        toolCalls: [],
        errorCode: 'swap_token_security_unavailable',
      };
    }
  }

  const inventory = await input.tools.listProviderTools();
  const tool = swapToolFromProviderInventory(inventory);
  if (!tool) {
    return { kind: 'base_mcp_swap', content: 'Base MCP swap tools are unavailable.', toolCalls: [], errorCode: 'base_mcp_swap_unavailable' };
  }
  const args = mapArgs(tool, intent, input.walletAddress);
  let called: { content: string; isError: boolean };
  try {
    called = await input.tools.callTool(tool.name, args);
  } catch {
    called = { content: JSON.stringify({ errorCode: 'base_mcp_swap_failed' }), isError: true };
  }
  const errorCode = called.isError ? sanitizedToolErrorCode(called.content, 'base_mcp_swap_failed') : undefined;
  const trace: StreamToolTrace = {
    toolName: tool.name,
    args: sanitizeStreamToolArgs(args) as Record<string, unknown>,
    result: { status: called.isError ? 'error' : 'success', ...(errorCode ? { errorCode } : {}) },
    isError: called.isError,
  };
  if (called.isError) {
    return { kind: 'base_mcp_swap', content: `Base MCP swap is unavailable (${errorCode}).`, toolCalls: [trace], errorCode };
  }
  const approval = approvalReference(called.content);
  if (!approval) {
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP did not return a valid Base Account approval reference. No swap was submitted.',
      toolCalls: [trace],
      errorCode: 'base_mcp_approval_reference_missing',
    };
  }
  return {
    kind: 'base_mcp_swap',
    content: `Base MCP prepared the ${intent.amount} ${intent.tokenIn} → ${intent.tokenOut} swap. Final Base Account approval is required.`,
    toolCalls: [trace],
    approvalUrl: approval.approvalUrl,
    requestId: approval.requestId,
  };
}
