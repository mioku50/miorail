import crypto from 'node:crypto';
import type { AutonomyPolicyRepository } from '@mioagent/autonomy';
import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { screenAction } from '@mioagent/security';
import { logger } from '@mioagent/utils';
import { loadTokenSecurityContext } from './executionSecurity.js';
import { sanitizeStreamToolArgs, sanitizedToolErrorCode, type StreamToolTrace } from './streamReadRouting.js';
import { getAutonomyPolicyRepository } from './autonomyGateway.js';
import {
  resolveBaseMcpApprovalLifecycle,
  hasBaseMcpDurableProof,
  sanitizedBaseMcpResponseShape,
  type BaseMcpApprovalState,
} from './baseMcpApprovalLifecycle.js';
import {
  BASE_MCP_WALLET_MISMATCH_ERROR_CODE,
  BASE_MCP_WALLET_MISMATCH_MESSAGE,
  verifyBaseMcpWalletMatch,
} from './baseMcpWalletReconciliation.js';

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
  approvalState?: BaseMcpApprovalState;
  reservationActionId?: string;
  reservationExpiresAt?: string;
  approvalTerminal?: boolean;
}

export const baseMcpSwapRuntime: { getRepository: () => AutonomyPolicyRepository } = {
  getRepository: getAutonomyPolicyRepository,
};

export function detectSwapIntent(message: string): { amount: string; tokenIn: string; tokenOut: string } | null {
  if (/(?:quote|estimate|route|price impact|котировк|курс|маршрут)/iu.test(message)) return null;
  const direct = message.match(/(?:^|\s)(?:swap|exchange|обменяй|обменять|свапни|свапнуть)\s+(\d+(?:[.,]\d+)?)\s+(USDC|WETH|ETH)\s+(?:to|for|into|на|в)\s+(USDC|WETH|ETH)(?:\s|$)/iu);
  const buy = message.match(/(?:^|\s)(?:buy|купи|купить)\s+(USDC|WETH|ETH)\s+(?:for|за)\s+(\d+(?:[.,]\d+)?)\s+(USDC|WETH|ETH)(?:\s|$)/iu);
  const amount = (direct?.[1] || buy?.[2])?.replace(',', '.');
  const tokenIn = (direct?.[2] || buy?.[3])?.toUpperCase();
  const tokenOut = (direct?.[3] || buy?.[1])?.toUpperCase();
  if (!amount || !tokenIn || !tokenOut || tokenIn === tokenOut) return null;
  return { amount, tokenIn, tokenOut };
}

function swapToolFromProviderInventory(inventory: Array<{ providerId: string; tools: ToolDef[] }>): ToolDef | undefined {
  const tools = inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools);
  return tools.find((tool) => /^(?:swap|swap_tokens|token_swap)$/i.test(tool.name));
}

export function mapBaseMcpSwapArgs(
  tool: ToolDef,
  intent: { amount: string; tokenIn: string; tokenOut: string },
  walletAddress: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; errorCode: 'base_mcp_swap_schema_unmappable' } {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
    ? tool.inputSchema as Record<string, unknown>
    : null;
  const properties = schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  if (Object.keys(properties).length === 0) {
    return {
      ok: true,
      args: { amount: intent.amount, fromAsset: intent.tokenIn, toAsset: intent.tokenOut },
    };
  }
  const args: Record<string, unknown> = {};
  const put = (aliases: string[], value: unknown): string | undefined => {
    const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (key) args[key] = value;
    return key;
  };
  const amountKey = put(['amount', 'amountIn', 'fromAmount', 'sellAmount'], intent.amount);
  const fromKey = put(['fromAsset', 'fromToken', 'tokenIn', 'sellToken', 'inputToken', 'from'], intent.tokenIn);
  const toKey = put(['toAsset', 'toToken', 'tokenOut', 'buyToken', 'outputToken', 'to'], intent.tokenOut);
  put(['walletAddress', 'address', 'swapper'], walletAddress);
  put(['chainId'], 8453);
  put(['chain', 'network'], 'base');
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === 'string')
    : [];
  if (!amountKey || !fromKey || !toKey || required.some((key) => !Object.prototype.hasOwnProperty.call(args, key))) {
    return { ok: false, errorCode: 'base_mcp_swap_schema_unmappable' };
  }
  return { ok: true, args };
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
  const repository = baseMcpSwapRuntime.getRepository();
  const policy = await repository.getByUser(input.userId, 8453).catch(() => undefined);
  if (!policy || !policy.isActive || policy.killSwitch || !policy.mainnetOptIn
    || policy.expiresAt <= Date.now() || policy.walletAddress !== input.walletAddress.toLowerCase()) {
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP swap is blocked until the active mainnet policy and connected wallet pass readiness checks.',
      toolCalls: [],
      errorCode: 'mainnet_policy_not_ready',
    };
  }
  if (intent.tokenIn !== 'USDC') {
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP swap is blocked because the active policy accounts spending in USDC only.',
      toolCalls: [],
      errorCode: 'swap_policy_asset_unsupported',
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

  // T44: a VERIFIED wallet mismatch between the Base MCP account and the
  // session wallet blocks the swap; an unverifiable get_wallets read does not.
  const walletMatch = await verifyBaseMcpWalletMatch(input.tools, input.walletAddress);
  if (walletMatch.checked && !walletMatch.match) {
    return {
      kind: 'base_mcp_swap',
      content: BASE_MCP_WALLET_MISMATCH_MESSAGE,
      toolCalls: [],
      errorCode: BASE_MCP_WALLET_MISMATCH_ERROR_CODE,
    };
  }
  const mapped = mapBaseMcpSwapArgs(tool, intent, input.walletAddress);
  if (!mapped.ok) {
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP swap is unavailable because its live input schema cannot be mapped safely.',
      toolCalls: [],
      errorCode: mapped.errorCode,
    };
  }
  const args = mapped.args;
  const actionId = `base-mcp-swap:${crypto.randomUUID()}`;
  const ttlMs = Math.max(1, Math.min(30 * 60_000, policy.expiresAt - Date.now()));
  const reservation = await repository.reserve({
    policyId: policy.id,
    userId: input.userId,
    actionId,
    amount: Number(intent.amount),
    ttlMs,
  });
  if (!reservation.success) {
    return {
      kind: 'base_mcp_swap',
      content: 'Swap blocked by the active policy spending limits.',
      toolCalls: [],
      errorCode: `swap_${reservation.status}`,
    };
  }
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
    await repository.release(actionId, errorCode);
    return { kind: 'base_mcp_swap', content: `Base MCP swap is unavailable (${errorCode}).`, toolCalls: [trace], errorCode };
  }
  const approval = await resolveBaseMcpApprovalLifecycle({ initialResult: called.content, tools: input.tools });
  const toolCalls = [trace, ...approval.toolCalls];
  const durableProof = hasBaseMcpDurableProof(approval.proof);
  let settlementConfirmed = false;
  if (approval.state === 'completed' && durableProof) {
    const settled = await repository.settle(actionId, { ...approval.proof, confirmedAt: new Date().toISOString() });
    settlementConfirmed = settled.success && settled.status === 'settled';
  } else if (['rejected', 'failed'].includes(approval.state)) {
    await repository.release(actionId, `base_mcp_${approval.state}`);
  }
  const approvalState: BaseMcpApprovalState = approval.state === 'completed' && !settlementConfirmed
    ? 'pending'
    : approval.state;
  if (approval.state === 'failed' && !approval.approvalUrl && !approval.requestId) {
    logger.warn('base-mcp-swap-approval-reference-missing', {
      toolName: tool.name,
      responseShape: sanitizedBaseMcpResponseShape(called.content),
    });
    return {
      kind: 'base_mcp_swap',
      content: 'Base MCP returned a successful protected-tool response, but its approval state is unavailable. The response was not treated as settled.',
      toolCalls,
      errorCode: approval.errorCode || 'base_mcp_approval_state_unknown',
      approvalState: 'failed',
      approvalTerminal: true,
      reservationActionId: actionId,
      reservationExpiresAt: new Date(reservation.reservation?.expiresAt || Date.now() + ttlMs).toISOString(),
    };
  }
  const content = approval.state === 'completed' && settlementConfirmed
    ? 'Base MCP confirms that the swap completed.'
    : approval.state === 'completed' && durableProof
      ? 'Base MCP confirmed the transaction, but local settlement accounting is still pending.'
    : approval.state === 'completed'
      ? 'Base MCP reports completion, but durable transaction proof is not available yet. The spending reservation remains pending.'
    : approval.state === 'rejected'
      ? 'The Base Account swap confirmation was rejected.'
      : approval.state === 'failed'
        ? 'The Base MCP swap request failed.'
        : approval.approvalUrl
          ? `Base MCP prepared the ${intent.amount} ${intent.tokenIn} → ${intent.tokenOut} swap. Confirm in Base Account.`
          : 'The Base MCP swap request is pending. It is not confirmed or settled yet.';
  return {
    kind: 'base_mcp_swap',
    content,
    toolCalls,
    approvalState,
    approvalTerminal: ['completed', 'rejected', 'failed'].includes(approval.state),
    reservationActionId: actionId,
    reservationExpiresAt: new Date(reservation.reservation?.expiresAt || Date.now() + ttlMs).toISOString(),
    ...(approval.approvalUrl ? { approvalUrl: approval.approvalUrl } : {}),
    ...(approval.requestId ? { requestId: approval.requestId } : {}),
    ...(approval.state === 'completed' && !settlementConfirmed
      ? { errorCode: durableProof ? 'base_mcp_settlement_accounting_failed' : 'base_mcp_durable_proof_missing' }
      : ['rejected', 'failed'].includes(approval.state)
      ? { errorCode: approval.errorCode || `base_mcp_${approval.state}` }
      : {}),
  };
}
