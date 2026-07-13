import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { getRuntimeSkill, runtimeSkillAvailability } from '@mioagent/runtime-skills';
import type { StreamToolTrace } from './streamReadRouting.js';

export interface QuoteIntent {
  quoteOnly: true;
  amountIn?: string;
  tokenIn?: 'USDC' | 'ETH' | 'WETH';
  tokenOut?: 'USDC' | 'ETH' | 'WETH';
  slippageTolerance?: number;
}

export interface DirectQuoteResult {
  kind: 'uniswap_quote';
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
}

const WRITE_EXECUTION = /\b(?:execute|swap|buy|sell|trade|submit|approve|prepare)\b/i;
const QUOTE_LANGUAGE = /\bquote\b|\b(?:show|estimate|check)\b[^\n]{0,80}\b(?:route|slippage|gas|price impact)\b/i;

export function detectQuoteIntent(message: string): QuoteIntent | null {
  if (!QUOTE_LANGUAGE.test(message) || (WRITE_EXECUTION.test(message) && !/\bquote\b/i.test(message))) return null;
  const amountPair = message.match(/\b(\d+(?:\.\d+)?)\s*(USDC|WETH|ETH)\s+(?:to|into|for)\s+(USDC|WETH|ETH)\b/i);
  const slippage = message.match(/\bslippage(?:\s+(?:of|at|=|:))?\s*(\d+(?:\.\d+)?)\s*%/i);
  return {
    quoteOnly: true,
    ...(amountPair ? {
      amountIn: amountPair[1],
      tokenIn: amountPair[2].toUpperCase() as QuoteIntent['tokenIn'],
      tokenOut: amountPair[3].toUpperCase() as QuoteIntent['tokenOut'],
    } : {}),
    ...(slippage ? { slippageTolerance: Number(slippage[1]) } : {}),
  };
}

function safeErrorCode(content: string, fallback: string): string {
  try {
    const parsed = JSON.parse(content);
    const value = String(parsed.errorCode || parsed.error || '');
    const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized && normalized.length <= 80 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    /token|secret|authorization|cookie|password|credential/i.test(key) && !['tokenIn', 'tokenOut'].includes(key)
      ? '[redacted]'
      : value,
  ]));
}

async function callTool(
  tools: ToolAggregator,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<{ content: string; trace: StreamToolTrace; errorCode?: string }> {
  try {
    const result = await tools.callTool(tool.name, args);
    const errorCode = result.isError ? safeErrorCode(result.content, 'quote_tool_failed') : undefined;
    return {
      content: result.content,
      errorCode,
      trace: {
        toolName: tool.name,
        args: safeArgs(args),
        result: { status: result.isError ? 'error' : 'success', ...(errorCode ? { errorCode } : {}) },
        isError: result.isError,
      },
    };
  } catch {
    return {
      content: '',
      errorCode: 'quote_tool_failed',
      trace: {
        toolName: tool.name,
        args: safeArgs(args),
        result: { status: 'error', errorCode: 'quote_tool_failed' },
        isError: true,
      },
    };
  }
}

function walletFrom(content: string): string | undefined {
  return content.match(/0x[a-fA-F0-9]{40}/)?.[0];
}

function screenedQuote(content: string): Record<string, any> | null {
  try {
    const quote = JSON.parse(content) as Record<string, any>;
    const serialized = JSON.stringify(quote);
    if (quote.quoteOnly !== true || quote.transactionPrepared !== false) return null;
    if (/calldata|approval|permit|signature|transaction|encodedOrder|wallet_sendCalls/i.test(serialized.replace(/transactionPrepared/g, ''))) return null;
    if (!quote.amountIn || !quote.amountOut || !quote.tokenIn?.decimals || !quote.tokenOut?.decimals || !quote.route) return null;
    return quote;
  } catch {
    return null;
  }
}

export async function runDirectQuoteRead(input: {
  message: string;
  normalizedIntent?: QuoteIntent;
  walletAddress?: string;
  tools: ToolAggregator;
}): Promise<DirectQuoteResult | null> {
  const intent = input.normalizedIntent ?? detectQuoteIntent(input.message);
  if (!intent) return null;
  const traces: StreamToolTrace[] = [];
  if (!intent.amountIn || !intent.tokenIn || !intent.tokenOut) {
    return {
      kind: 'uniswap_quote',
      content: 'Provide an amount and pair, for example: “quote 0.1 USDC to ETH”. Quote mode is read-only.',
      toolCalls: traces,
      errorCode: 'quote_parameters_required',
    };
  }
  const inventory = await input.tools.listTools();
  const skill = getRuntimeSkill('uniswap')!;
  const availability = runtimeSkillAvailability({
    skill,
    intent: 'quote',
    toolNames: inventory.map((tool) => tool.name),
  });
  const quoteTool = inventory.find((tool) => tool.name === 'uniswap_quote');
  if (!availability.available || !quoteTool) {
    return {
      kind: 'uniswap_quote',
      content: 'Uniswap quote tools are unavailable.',
      toolCalls: traces,
      errorCode: availability.code || 'uniswap_tools_unavailable',
    };
  }

  // T44 invariant: the SIWE session address is authoritative. get_wallets is
  // only a fallback when NO session address exists — a Base MCP address never
  // substitutes or overrides the session wallet.
  let walletAddress = input.walletAddress;
  if (!walletAddress) {
    const walletTool = inventory.find((tool) => tool.name === 'get_wallets');
    if (walletTool) {
      const wallet = await callTool(input.tools, walletTool, {});
      traces.push(wallet.trace);
      if (!wallet.errorCode) walletAddress = walletFrom(wallet.content);
    }
  }
  if (!walletAddress) {
    return {
      kind: 'uniswap_quote',
      content: 'Connect Base Account before requesting a Uniswap quote. No transaction was prepared.',
      toolCalls: traces,
      errorCode: 'quote_wallet_required',
    };
  }

  const args = skill.argumentMapper('quote', {
    amountIn: intent.amountIn,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    swapper: walletAddress,
    ...(intent.slippageTolerance === undefined ? {} : { slippageTolerance: intent.slippageTolerance }),
  });
  const called = await callTool(input.tools, quoteTool, args);
  traces.push(called.trace);
  if (called.errorCode) {
    return {
      kind: 'uniswap_quote',
      content: `Uniswap quote is unavailable (${called.errorCode}). No transaction was prepared.`,
      toolCalls: traces,
      errorCode: called.errorCode,
    };
  }
  const quote = screenedQuote(called.content);
  if (!quote) {
    return {
      kind: 'uniswap_quote',
      content: 'Uniswap returned an incomplete or unsafe quote result. No transaction was prepared.',
      toolCalls: traces,
      errorCode: 'uniswap_quote_failed_screening',
    };
  }
  const impact = quote.priceImpactPct === null ? 'unavailable' : `${quote.priceImpactPct}%`;
  const gas = quote.gasEstimate?.value === null
    ? 'unavailable'
    : `${quote.gasEstimate?.value} ${quote.gasEstimate?.unit || ''}`.trim();
  return {
    kind: 'uniswap_quote',
    content: [
      `Uniswap read-only quote on Base: ${quote.amountIn} ${quote.tokenIn.symbol} → ${quote.amountOut} ${quote.tokenOut.symbol}`,
      `Decimals: ${quote.tokenIn.symbol} ${quote.tokenIn.decimals}, ${quote.tokenOut.symbol} ${quote.tokenOut.decimals}`,
      `Route: ${quote.route.path.join(' → ')} (${quote.route.routing})`,
      `Price impact: ${impact} · Slippage: ${quote.slippagePct}% · Gas estimate: ${gas}`,
      'No calldata, approval, or transaction was prepared.',
    ].join('\n'),
    toolCalls: traces,
  };
}
