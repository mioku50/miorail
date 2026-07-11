import crypto from 'node:crypto';
import type { AutonomyPolicyRepository } from '@mioagent/autonomy';
import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { screenAction } from '@mioagent/security';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { getAutonomyPolicyRepository } from './autonomyGateway.js';
import { loadTokenSecurityContext } from './executionSecurity.js';
import {
  resolveBaseMcpApprovalLifecycle,
  type BaseMcpApprovalState,
} from './baseMcpApprovalLifecycle.js';
import { sanitizeStreamToolArgs, sanitizedToolErrorCode, type StreamToolTrace } from './streamReadRouting.js';

export interface DirectBaseMcpSendResult {
  kind: 'base_mcp_send';
  content: string;
  toolCalls: StreamToolTrace[];
  errorCode?: string;
  approvalUrl?: string;
  requestId?: string;
  approvalState?: BaseMcpApprovalState;
}

export interface BaseMcpSendIntent {
  amount: number;
  amountText: string;
  recipient: string;
}

export const baseMcpSendRuntime: {
  getRepository: () => AutonomyPolicyRepository;
} = {
  getRepository: getAutonomyPolicyRepository,
};

export function detectBaseMcpSendIntent(message: string): BaseMcpSendIntent | null {
  const match = message.match(/\b(?:send|transfer)\s+(\d+(?:\.\d+)?)\s+USDC\s+to\s+(0x[a-fA-F0-9]{40})\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, amountText: match[1], recipient: match[2].toLowerCase() };
}

function sendToolFromProviderInventory(inventory: Array<{ providerId: string; tools: ToolDef[] }>): ToolDef | undefined {
  return inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools)
    .find((tool) => /^(?:send|transfer|send_token|transfer_token)$/i.test(tool.name));
}

function mapArgs(tool: ToolDef, intent: BaseMcpSendIntent, walletAddress: string): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const put = (aliases: string[], value: unknown) => {
    const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (key) args[key] = value;
  };
  put(['amount', 'value', 'tokenAmount'], intent.amountText);
  put(['token', 'asset', 'tokenSymbol', 'currency'], 'USDC');
  put(['recipient', 'to', 'destination', 'toAddress'], intent.recipient);
  put(['walletAddress', 'from', 'fromAddress', 'sender'], walletAddress);
  put(['chainId'], 8453);
  put(['chain', 'network'], 'base');
  return Object.keys(args).length > 0
    ? args
    : {
        amount: intent.amountText,
        token: 'USDC',
        recipient: intent.recipient,
        walletAddress,
        chainId: 8453,
      };
}

function blocked(content: string, errorCode: string): DirectBaseMcpSendResult {
  return { kind: 'base_mcp_send', content, toolCalls: [], errorCode };
}

export async function runDirectBaseMcpSend(input: {
  message: string;
  walletAddress?: string;
  tools: ToolAggregator;
  userConfirmedEnabled: boolean;
  userId: string;
}): Promise<DirectBaseMcpSendResult | null> {
  const intent = detectBaseMcpSendIntent(input.message);
  if (!intent) return null;
  if (!input.userConfirmedEnabled) {
    return blocked('Mainnet is read-only. No transfer was requested.', 'mainnet_readonly');
  }
  if (!input.walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) {
    return blocked('Connect Base Account before requesting a transfer.', 'send_wallet_required');
  }

  const walletAddress = input.walletAddress.toLowerCase();
  const repository = baseMcpSendRuntime.getRepository();
  const policy = await repository.getByUser(input.userId, 8453).catch(() => undefined);
  if (!policy || !policy.isActive || policy.killSwitch || !policy.mainnetOptIn
    || policy.expiresAt <= Date.now() || policy.walletAddress !== walletAddress) {
    return blocked('Base MCP send is blocked until the active mainnet policy and connected wallet pass readiness checks.', 'mainnet_policy_not_ready');
  }
  if (!policy.whitelist.some((address) => address.toLowerCase() === intent.recipient)) {
    return blocked('Transfer blocked: the recipient is not in the active policy whitelist.', 'send_recipient_not_whitelisted');
  }
  if (intent.amount > policy.maxPerAction) {
    return blocked('Transfer blocked: the amount exceeds the policy maximum per action.', 'send_max_per_action_exceeded');
  }

  const canonicalUsdc = canonicalUsdcForBaseChain(8453).toLowerCase();
  const security = await loadTokenSecurityContext(8453, [canonicalUsdc]);
  const verdict = security.tokenSecurity.find((item) => item.address.toLowerCase() === canonicalUsdc);
  const screening = screenAction({
    instruction: input.message,
    providerContext: { ...security.providerContext, requiresTokenSecurity: true },
  });
  if (!screening.allowed || !verdict || verdict.provider !== 'goplus' || !['ok', 'warning'].includes(verdict.status)) {
    return blocked('Transfer blocked: no fresh usable GoPlus verdict exists for canonical Base USDC.', 'send_token_security_unavailable');
  }

  const inventory = await input.tools.listProviderTools();
  const tool = sendToolFromProviderInventory(inventory);
  if (!tool) return blocked('Base MCP send tools are unavailable.', 'base_mcp_send_unavailable');

  const actionId = `base-mcp-send:${crypto.randomUUID()}`;
  const ttlMs = Math.max(1, Math.min(30 * 60_000, policy.expiresAt - Date.now()));
  const reservation = await repository.reserve({
    policyId: policy.id,
    userId: input.userId,
    actionId,
    amount: intent.amount,
    ttlMs,
  });
  if (!reservation.success) {
    return blocked('Transfer blocked by the active policy spending limits.', `send_${reservation.status}`);
  }

  const args = mapArgs(tool, intent, walletAddress);
  let called: { content: string; isError: boolean };
  try {
    called = await input.tools.callTool(tool.name, args);
  } catch {
    called = { content: JSON.stringify({ errorCode: 'base_mcp_send_failed' }), isError: true };
  }
  const callError = called.isError ? sanitizedToolErrorCode(called.content, 'base_mcp_send_failed') : undefined;
  const trace: StreamToolTrace = {
    toolName: tool.name,
    args: sanitizeStreamToolArgs(args) as Record<string, unknown>,
    result: { status: called.isError ? 'error' : 'success', ...(callError ? { errorCode: callError } : {}) },
    isError: called.isError,
  };
  if (called.isError) {
    await repository.release(actionId, callError);
    return {
      kind: 'base_mcp_send',
      content: `Base MCP send is unavailable (${callError}).`,
      toolCalls: [trace],
      errorCode: callError,
      approvalState: 'failed',
    };
  }

  const approval = await resolveBaseMcpApprovalLifecycle({ initialResult: called.content, tools: input.tools });
  const toolCalls = [trace, ...approval.toolCalls];
  if (approval.state === 'completed') {
    await repository.settle(actionId, {
      receiptId: approval.requestId || actionId,
      confirmedAt: new Date().toISOString(),
    });
  } else if (['rejected', 'failed'].includes(approval.state)) {
    await repository.release(actionId, `base_mcp_${approval.state}`);
  }

  const content = approval.state === 'completed'
    ? 'Base MCP confirms that the USDC transfer completed.'
    : approval.state === 'rejected'
      ? 'The Base Account transfer confirmation was rejected.'
      : approval.state === 'failed'
        ? 'The Base MCP transfer request failed. The spending reservation was released.'
        : approval.approvalUrl
          ? `Base MCP prepared a ${intent.amountText} USDC transfer. Confirm in Base Account.`
          : 'The Base MCP transfer request is pending. It is not confirmed or settled yet.';

  return {
    kind: 'base_mcp_send',
    content,
    toolCalls,
    approvalState: approval.state,
    ...(approval.approvalUrl ? { approvalUrl: approval.approvalUrl } : {}),
    ...(approval.requestId ? { requestId: approval.requestId } : {}),
    ...(['rejected', 'failed'].includes(approval.state)
      ? { errorCode: approval.errorCode || `base_mcp_${approval.state}` }
      : {}),
  };
}
