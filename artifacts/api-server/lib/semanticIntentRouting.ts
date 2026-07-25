import type { LlmProvider } from '@mioagent/llm';
import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { getRuntimeSkill, runtimeSkillAvailability } from '@mioagent/runtime-skills';
import { loadTokenSecurityContext } from './executionSecurity.js';
import { runDirectBaseMcpSend } from './streamBaseMcpSendRouting.js';
import { runDirectBaseMcpSwap } from './streamBaseMcpSwapRouting.js';
import { runDirectMoonwellWrite, type MoonwellWriteVerb } from './streamMoonwellWriteRouting.js';
import { runDirectBaseAppNativeSend, runDirectBaseAppNativeSwap } from './streamBaseAppNativeRouting.js';
import type { WalletEnvironment } from './walletContext.js';
import type { BaseMcpWalletMatchResult } from './baseMcpWalletReconciliation.js';
import { runDirectQuoteRead } from './streamQuoteRouting.js';
import {
  runDirectStreamRead,
  sanitizeStreamToolArgs,
  sanitizedToolErrorCode,
  toolMatchesProviderNamespace,
  type StreamToolTrace,
} from './streamReadRouting.js';
import { screenPartnerToolResult } from './partnerResultTrust.js';
import {
  extractSemanticIntent,
  isFinancialLanguage,
  normalizeSemanticIntent,
  semanticWriteClarification,
  stableSemanticHash,
  type NormalizedSemanticIntent,
  type SemanticConversationContext,
  type SemanticIntentExtraction,
} from './semanticIntent.js';

export interface SemanticDirectResult {
  kind: string;
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
  approvalUrl?: string;
  requestId?: string;
  approvalState?: string;
  reservationActionId?: string;
  reservationExpiresAt?: string;
  approvalTerminal?: boolean;
  actionId?: string;
  actionExpiresAt?: string;
  preparedPayload?: Record<string, unknown>;
}

export interface SemanticRoutingDecision {
  extraction: SemanticIntentExtraction | null;
  normalized: NormalizedSemanticIntent | null;
  normalizedIntentHash?: string;
  result?: SemanticDirectResult;
  recommendationIntent?: 'portfolio' | 'risk' | 'security' | 'yield';
}

function direct(
  kind: string,
  content: string,
  errorCode?: string,
  toolCalls: StreamToolTrace[] = [],
): SemanticDirectResult {
  return { kind, content, toolCalls, ...(errorCode ? { errorCode } : {}) };
}

function displayScreened(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2).slice(0, 12_000);
  } catch {
    return content.slice(0, 12_000);
  }
}

function schemaProperties(tool: ToolDef): Record<string, unknown> {
  const properties = tool.inputSchema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {};
}

function buildProviderArgs(tool: ToolDef, normalized: NormalizedSemanticIntent, walletAddress?: string): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (lower === 'chain') args[key] = 'base';
    else if (lower === 'chainid') args[key] = 8453;
    else if (['address', 'useraddress', 'walletaddress'].includes(lower) && walletAddress) args[key] = walletAddress;
    else if (['asset', 'assetsymbol'].includes(lower) && normalized.asset) args[key] = normalized.asset.symbol;
    else if (lower === 'assetaddress' && normalized.asset?.address) args[key] = normalized.asset.address;
    else if (lower === 'loanasset' && (normalized.asset || normalized.fromAsset)) {
      args[key] = (normalized.asset || normalized.fromAsset)!.address || (normalized.asset || normalized.fromAsset)!.symbol;
    } else if (lower === 'limit') args[key] = 25;
    else if (lower === 'sort') args[key] = 'tvl_desc';
    else if (lower === 'sortby') args[key] = 'liquidityAssetsUsd';
    else if (lower === 'sortdirection') args[key] = 'desc';
    else if (lower === 'active') args[key] = true;
  }
  return args;
}

function chooseProviderTool(tools: ToolDef[], normalized: NormalizedSemanticIntent): ToolDef | undefined {
  const names = tools.map((tool) => tool.name.toLowerCase());
  const pick = (fragment: string) => {
    const index = names.findIndex((name) => name.includes(fragment));
    return index >= 0 ? tools[index] : undefined;
  };
  if (normalized.intent === 'yield_discovery') return pick('vault') || pick('rate') || pick('market');
  if (normalized.intent === 'market_discovery') return pick('market') || pick('rate');
  return pick('position') || pick('market') || pick('vault') || pick('rate') || tools[0];
}

async function runProviderRead(input: {
  normalized: NormalizedSemanticIntent;
  tools: ToolAggregator;
  walletAddress?: string;
}): Promise<SemanticDirectResult> {
  const namespace = input.normalized.protocol;
  if (!namespace) {
    return direct('semantic_clarification', 'Which protocol should I query, for example Moonwell or Morpho?', 'provider_required');
  }
  const inventory = await input.tools.listTools();
  const matching = inventory.filter((tool) => toolMatchesProviderNamespace(tool.name, namespace));
  const skill = getRuntimeSkill(namespace);
  if (!skill || !runtimeSkillAvailability({ skill, intent: 'read', toolNames: matching.map((tool) => tool.name) }).available) {
    const displayName = namespace.charAt(0).toUpperCase() + namespace.slice(1);
    return direct('partner_provider_unavailable', `${displayName} read tools are unavailable.`, `${namespace}_tools_unavailable`);
  }

  // Preserve the richer, heavily screened Morpho vault formatter.
  if (namespace === 'morpho' && input.normalized.intent === 'yield_discovery') {
    return (await runDirectStreamRead({
      message: 'Show available USDC Morpho vault opportunities on Base',
      walletAddress: input.walletAddress,
      tools: input.tools,
    }))!;
  }

  const tool = chooseProviderTool(matching, input.normalized);
  if (!tool) return direct('partner_provider_unavailable', `${skill.displayName} read tools are unavailable.`, `${namespace}_tools_unavailable`);
  const args = buildProviderArgs(tool, input.normalized, input.walletAddress);
  const required = Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required.filter((key): key is string => typeof key === 'string')
    : [];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(args, key))) {
    return direct('semantic_clarification', `What ${required.filter((key) => !(key in args)).join(' and ')} should I use for ${skill.displayName}?`, `${namespace}_parameters_required`);
  }
  let called: { content: string; isError: boolean };
  try {
    called = await input.tools.callTool(tool.name, args);
  } catch {
    called = { content: JSON.stringify({ errorCode: `${namespace}_tool_failed` }), isError: true };
  }
  const screened = screenPartnerToolResult({
    toolName: tool.name,
    content: called.content,
    isError: called.isError,
    providerNamespace: namespace,
  });
  const errorCode = screened.isError ? sanitizedToolErrorCode(screened.content, `${namespace}_result_unavailable`) : undefined;
  const trace: StreamToolTrace = {
    toolName: tool.name,
    args: sanitizeStreamToolArgs(args) as Record<string, unknown>,
    result: { status: screened.isError ? 'error' : 'success', ...(errorCode ? { errorCode } : {}) },
    isError: screened.isError,
  };
  if (screened.isError) {
    return direct('partner_provider_unavailable', `${skill.displayName} data did not pass provider-specific screening (${errorCode}).`, errorCode, [trace]);
  }
  return direct(
    'partner_semantic_read',
    `Live screened ${skill.displayName} read result on Base:\n${displayScreened(screened.content)}\n\nThis is not a safety claim or transaction recommendation. No transaction was prepared.`,
    undefined,
    [trace],
  );
}

function latestApprovalStatus(context: SemanticConversationContext): SemanticDirectResult {
  const prior = [...context.recentMessages].reverse().find((message) => {
    const metadata = message.metadata && typeof message.metadata === 'object'
      ? message.metadata as Record<string, unknown>
      : {};
    return typeof metadata.approvalState === 'string' && typeof metadata.reservationActionId === 'string';
  });
  const metadata = prior?.metadata && typeof prior.metadata === 'object'
    ? prior.metadata as Record<string, unknown>
    : undefined;
  if (!metadata) return direct('confirmation_status', 'Which prepared action do you want to check?', 'approval_action_required');
  const state = String(metadata.approvalState);
  const actionId = String(metadata.reservationActionId);
  const labels: Record<string, string> = {
    approval_required: 'waiting for Base Account confirmation',
    pending: 'pending confirmation or durable onchain proof',
    completed: 'completed with durable onchain proof',
    rejected: 'rejected',
    failed: 'failed or expired',
  };
  return direct('confirmation_status', `Action ${actionId.slice(0, 18)}… is ${labels[state] || state}.`);
}

async function runTokenSecurityRead(normalized: NormalizedSemanticIntent): Promise<SemanticDirectResult> {
  const asset = normalized.asset;
  const address = asset?.address || normalized.explicitAssetAddress;
  if (!address) {
    return direct('semantic_clarification', 'Which verified Base token symbol or contract address should I check?', 'token_security_asset_required');
  }
  const label = asset?.symbol || `${address.slice(0, 8)}…${address.slice(-4)}`;
  const security = await loadTokenSecurityContext(8453, [address.toLowerCase()]);
  const verdict = security.tokenSecurity.find((item) => item.address.toLowerCase() === address.toLowerCase());
  if (!verdict || !['ok', 'warning'].includes(verdict.status)) {
    return direct('token_security', `Contract checks for ${label} are unavailable or incomplete. No safety claim can be made.`, 'token_security_unavailable');
  }
  return direct(
    'token_security',
    `${label} contract check on Base returned a usable ${verdict.status} verdict from ${verdict.provider}. This is contract-risk context, not a guarantee that the token or market is safe.`,
  );
}

export async function routeSemanticIntent(input: {
  llm: LlmProvider;
  message: string;
  context: SemanticConversationContext;
  walletAddress?: string;
  tools: ToolAggregator;
  userConfirmedEnabled: boolean;
  userId: string;
  walletEnvironment?: WalletEnvironment;
  walletMatch?: BaseMcpWalletMatchResult;
  nativePortfolioReader?: (walletAddress: string) => Promise<unknown>;
}): Promise<SemanticRoutingDecision> {
  const extraction = await extractSemanticIntent({ llm: input.llm, message: input.message, context: input.context });
  if (!extraction) {
    return isFinancialLanguage(input.message)
      ? { extraction: null, normalized: null, result: direct('semantic_clarification', 'Please clarify the financial request with the asset, amount or read you want on Base.', 'semantic_intent_invalid') }
      : { extraction: null, normalized: null };
  }
  const normalized = normalizeSemanticIntent({ extraction, message: input.message, context: input.context });
  const normalizedIntentHash = stableSemanticHash(normalized);
  const decision = (result?: SemanticDirectResult, recommendationIntent?: SemanticRoutingDecision['recommendationIntent']): SemanticRoutingDecision => ({
    extraction,
    normalized,
    normalizedIntentHash,
    ...(result ? { result } : {}),
    ...(recommendationIntent ? { recommendationIntent } : {}),
  });

  if (normalized.confidence < 0.55 && (isFinancialLanguage(input.message)
    || !['assistant'].includes(normalized.intent))) {
    return decision(direct('semantic_clarification', normalized.clarification || 'Please clarify what financial read or transaction you want on Base.', 'semantic_intent_low_confidence'));
  }

  if (normalized.intent === 'portfolio_review') return decision(undefined, 'portfolio');
  if (normalized.intent === 'confirmation_status') return decision(latestApprovalStatus(input.context));
  if (normalized.intent === 'balance' || normalized.intent === 'portfolio') {
    const result = await runDirectStreamRead({
      message: 'check my Base balance',
      walletAddress: input.walletAddress,
      tools: input.tools,
      walletEnvironment: input.walletEnvironment,
      walletMatch: input.walletMatch,
      nativePortfolioReader: input.nativePortfolioReader,
    });
    return decision(result || direct('base_portfolio', 'Base MCP portfolio reads are unavailable.', 'base_mcp_portfolio_tool_unavailable'));
  }
  if (normalized.intent === 'token_security') return decision(await runTokenSecurityRead(normalized));
  if (['yield_discovery', 'market_discovery', 'protocol_read'].includes(normalized.intent)) {
    return decision(await runProviderRead({ normalized, tools: input.tools, walletAddress: input.walletAddress }));
  }
  if (normalized.intent === 'quote') {
    const clarification = semanticWriteClarification({ ...normalized, intent: 'swap' });
    if (clarification) return decision(direct('semantic_clarification', clarification, 'quote_parameters_required'));
    const result = await runDirectQuoteRead({
      message: input.message,
      normalizedIntent: {
        quoteOnly: true,
        amountIn: normalized.amount!.kind === 'exact' ? normalized.amount!.value : undefined,
        tokenIn: normalized.fromAsset!.symbol,
        tokenOut: normalized.toAsset!.symbol,
      },
      walletAddress: input.walletAddress,
      tools: input.tools,
    });
    return decision(result || direct('uniswap_quote', "Uniswap didn't answer. Comparing 1 of 2 routes.", 'uniswap_tools_unavailable'));
  }

  const isWrite = ['send', 'swap', 'protocol_action', 'supply', 'withdraw', 'borrow', 'repay'].includes(normalized.intent);
  if (isWrite && !normalized.executionRequested) return decision();
  if (isWrite) {
    const clarification = semanticWriteClarification(normalized);
    if (clarification) return decision(direct('semantic_clarification', clarification, normalized.errors[0] || 'transaction_parameters_required'));
  }
  if (normalized.intent === 'send') {
    if (normalized.asset?.symbol !== 'USDC') return decision(direct('semantic_clarification', 'Miorail direct sends currently support canonical Base USDC only. Which USDC amount should I send?', 'send_asset_unsupported'));
    const result = input.walletEnvironment === 'baseapp' ? await runDirectBaseAppNativeSend({
      message: input.message,
      normalizedIntent: {
        amount: Number(normalized.amount!.kind === 'exact' ? normalized.amount!.value : Number.NaN),
        amountText: normalized.amount!.kind === 'exact' ? normalized.amount!.value : '',
        recipient: normalized.recipient!.toLowerCase(),
      },
      walletAddress: input.walletAddress,
      userConfirmedEnabled: input.userConfirmedEnabled,
      userId: input.userId,
    }) : await runDirectBaseMcpSend({
      message: input.message,
      normalizedIntent: {
        amount: Number(normalized.amount!.kind === 'exact' ? normalized.amount!.value : Number.NaN),
        amountText: normalized.amount!.kind === 'exact' ? normalized.amount!.value : '',
        recipient: normalized.recipient!.toLowerCase(),
      },
      walletAddress: input.walletAddress,
      tools: input.tools,
      userConfirmedEnabled: input.userConfirmedEnabled,
      userId: input.userId,
    });
    return decision(result || direct('base_mcp_send', 'Base MCP send is unavailable.', 'base_mcp_send_unavailable'));
  }
  if (normalized.intent === 'swap') {
    const result = input.walletEnvironment === 'baseapp' ? await runDirectBaseAppNativeSwap({
      message: input.message,
      normalizedIntent: {
        amount: normalized.amount!.kind === 'exact' ? normalized.amount!.value : '',
        tokenIn: normalized.fromAsset!.symbol,
        tokenOut: normalized.toAsset!.symbol,
      },
      walletAddress: input.walletAddress,
      userConfirmedEnabled: input.userConfirmedEnabled,
      userId: input.userId,
    }) : await runDirectBaseMcpSwap({
      message: input.message,
      normalizedIntent: {
        amount: normalized.amount!.kind === 'exact' ? normalized.amount!.value : '',
        tokenIn: normalized.fromAsset!.symbol,
        tokenOut: normalized.toAsset!.symbol,
      },
      walletAddress: input.walletAddress,
      tools: input.tools,
      userConfirmedEnabled: input.userConfirmedEnabled,
      userId: input.userId,
    });
    return decision(result || direct('base_mcp_swap', 'Base MCP swap is unavailable.', 'base_mcp_swap_unavailable'));
  }
  if (['supply', 'withdraw', 'borrow', 'repay'].includes(normalized.intent)) {
    if (normalized.protocol !== 'moonwell') {
      const name = normalized.protocol ? normalized.protocol[0].toUpperCase() + normalized.protocol.slice(1) : 'Requested protocol';
      return decision(direct('partner_provider_unavailable', `${name} write adapter is unavailable. No other protocol was substituted.`, `${normalized.protocol || 'protocol'}_write_unavailable`));
    }
    const result = await runDirectMoonwellWrite({
      message: input.message,
      normalizedIntent: {
        verb: normalized.intent as MoonwellWriteVerb,
        amount: Number(normalized.amount!.kind === 'exact' ? normalized.amount!.value : Number.NaN),
        amountText: normalized.amount!.kind === 'exact' ? normalized.amount!.value : '',
        asset: normalized.asset!.symbol,
      },
      walletAddress: input.walletAddress,
      tools: input.tools,
      userConfirmedEnabled: input.userConfirmedEnabled,
      userId: input.userId,
    });
    return decision(result || direct('moonwell_write', 'Moonwell write tools are unavailable.', 'moonwell_tools_unavailable'));
  }
  if (normalized.intent === 'protocol_action') {
    return decision(direct('semantic_clarification', 'Which exact protocol action should I prepare?', 'protocol_action_required'));
  }
  return decision();
}
