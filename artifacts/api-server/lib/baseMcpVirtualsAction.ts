import type { Request } from 'express';
import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  PostgresBaseMcpActionReceiptRepositoryV1,
  baseMcpActionHashV1,
  publicBaseMcpActionReceiptV1,
  type BaseMcpActionReceiptRepositoryV1,
  type BaseMcpVirtualsActionIntentV1,
  type StoredBaseMcpActionReceiptV1,
} from './baseMcpActionReceipts.js';
import { createApiToolAggregatorForUser } from './baseMcpTools.js';
import { verifyBaseMcpWalletMatch } from './baseMcpWalletReconciliation.js';
import { extractBaseMcpApprovalSnapshot } from './baseMcpApprovalLifecycle.js';
import {
  PostgresBaseMcpPluginSessionStoreV1,
  type BaseMcpPluginSessionStoreV1,
} from './baseMcpPluginSessionStore.js';
import { callVirtualsReviewedV1, firstStringFieldV1 } from './virtualsReviewedClient.js';
import { sanitizedToolErrorCode } from './streamReadRouting.js';

const ADDRESS_V1 = /^0x[a-fA-F0-9]{40}$/;

export interface BaseMcpVirtualsActionResultV1 {
  kind: 'action' | 'failed';
  reply: string;
  errorCode: string | null;
  toolsAvailable: number;
  receipt: ReturnType<typeof publicBaseMcpActionReceiptV1> | null;
  approvalUrl: string | null;
  resultPreview: string | null;
}

export const baseMcpVirtualsActionRuntimeV1 = {
  repository: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  sessions: new PostgresBaseMcpPluginSessionStoreV1() as BaseMcpPluginSessionStoreV1,
  createTools: createApiToolAggregatorForUser,
  verifyWallet: verifyBaseMcpWalletMatch,
  callVirtuals: callVirtualsReviewedV1,
  now: () => new Date(),
};

function result(
  receipt: StoredBaseMcpActionReceiptV1,
  reply: string,
  options: { approvalUrl?: string | null; errorCode?: string | null; toolsAvailable?: number; preview?: string | null } = {},
): BaseMcpVirtualsActionResultV1 {
  const errorCode = options.errorCode ?? receipt.errorCode;
  return {
    kind: receipt.status === 'failed' ? 'failed' : 'action',
    reply,
    errorCode,
    toolsAvailable: options.toolsAvailable ?? 0,
    receipt: publicBaseMcpActionReceiptV1(receipt),
    approvalUrl: options.approvalUrl ?? null,
    resultPreview: options.preview ?? null,
  };
}

function failed(reply: string, errorCode: string): BaseMcpVirtualsActionResultV1 {
  return { kind: 'failed', reply, errorCode, toolsAvailable: 0, receipt: null, approvalUrl: null, resultPreview: null };
}

function normalizeName(name: string): string | null {
  const value = name.trim().replace(/\s+/gu, ' ');
  return value.length >= 2 && value.length <= 80 ? value : null;
}

function normalizeDescription(description: string): string | null {
  const value = description.trim().replace(/\s+/gu, ' ');
  return value.length >= 8 && value.length <= 500 ? value : null;
}

function exactTool(inventory: readonly { providerId: string; tools: ToolDef[] }[], expected: string): ToolDef | null {
  const normalized = expected.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools)
    .find((tool) => tool.name.toLowerCase().replace(/[^a-z0-9]/gu, '') === normalized) ?? null;
}

function statusArgs(tool: ToolDef, requestId: string): Record<string, unknown> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const key = ['requestId', 'request_id', 'id'].find((item) => Object.hasOwn(properties, item)) ?? 'requestId';
  return { [key]: requestId };
}

function jwtExpiryV1(token: string, fallbackMs = 55 * 60_000): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return new Date(payload.exp * 1000).toISOString();
  } catch {
    // Opaque token: use a bounded session lifetime shorter than the spec's hour.
  }
  return new Date(baseMcpVirtualsActionRuntimeV1.now().getTime() + fallbackMs).toISOString();
}

async function createAgentV1(input: {
  receipt: StoredBaseMcpActionReceiptV1;
  token: string;
  intent: BaseMcpVirtualsActionIntentV1;
}): Promise<BaseMcpVirtualsActionResultV1> {
  const response = await baseMcpVirtualsActionRuntimeV1.callVirtuals({
    method: 'agent_create',
    args: {
      token: input.token,
      name: input.intent.agentName,
      description: input.intent.agentDescription,
    },
  });
  const now = baseMcpVirtualsActionRuntimeV1.now().toISOString();
  if (!response.ok) {
    if (response.errorCode === 'virtuals_session_expired') {
      await baseMcpVirtualsActionRuntimeV1.sessions.clear(input.receipt.tenantId);
    }
    const failedReceipt = await baseMcpVirtualsActionRuntimeV1.repository.update({
      id: input.receipt.id,
      tenantId: input.receipt.tenantId,
      status: 'failed',
      reconciliationState: 'unavailable',
      errorCode: response.errorCode,
      finalizedAt: now,
      now,
    });
    return result(failedReceipt ?? input.receipt, 'Virtuals did not create the agent. No alternate method or host was attempted.', {
      errorCode: response.errorCode,
    });
  }
  const providerObjectId = firstStringFieldV1(response.data, ['agentId', 'agent_id', 'id']);
  const responseHash = stableHashV1('base-mcp-virtuals-agent-create-response/v1', response.data);
  const completed = await baseMcpVirtualsActionRuntimeV1.repository.update({
    id: input.receipt.id,
    tenantId: input.receipt.tenantId,
    status: 'completed',
    reconciliationState: 'provider_confirmed',
    durableProof: { virtualsStage: 'agent_created', ...(providerObjectId ? { providerObjectId } : {}) },
    responseHash,
    errorCode: null,
    finalizedAt: now,
    now,
  });
  return result(completed ?? input.receipt, `Virtuals confirmed creation of ${input.intent.agentName}.`, {
    preview: providerObjectId ? `Virtuals agent ID: ${providerObjectId}` : `Virtuals created ${input.intent.agentName}.`,
  });
}

export async function prepareBaseMcpVirtualsAgentCreateV1(input: {
  req: Request;
  userId: string;
  walletAddress?: string;
  sessionSecret: string;
  idempotencyKey?: string;
  intent: BaseMcpVirtualsActionIntentV1;
}): Promise<BaseMcpVirtualsActionResultV1> {
  if (!input.idempotencyKey) return failed('This action needs an idempotency request ID.', 'base_mcp_action_request_id_required');
  if (!input.walletAddress || !ADDRESS_V1.test(input.walletAddress)) {
    return failed('Connect the same Base Account that will approve Virtuals sign-in.', 'base_mcp_action_wallet_required');
  }
  const agentName = normalizeName(input.intent.agentName);
  const agentDescription = normalizeDescription(input.intent.agentDescription);
  if (!agentName || !agentDescription) {
    return failed('Give the Virtuals agent an explicit name and a description of at least 8 characters. Nothing was created.', 'virtuals_agent_facts_required');
  }
  if (!(await baseMcpVirtualsActionRuntimeV1.repository.available()) || !(await baseMcpVirtualsActionRuntimeV1.sessions.available())) {
    return failed('Virtuals Action Receipt/session storage is unavailable, so no sign-in was prepared.', 'virtuals_storage_unavailable');
  }
  const walletAddress = input.walletAddress.toLowerCase() as `0x${string}`;
  const intent: BaseMcpVirtualsActionIntentV1 = { operation: 'agent_create', agentName, agentDescription };
  const now = baseMcpVirtualsActionRuntimeV1.now();
  const created = await baseMcpVirtualsActionRuntimeV1.repository.create({
    tenantId: input.userId,
    walletAddress,
    idempotencyKey: input.idempotencyKey,
    actionType: 'virtuals',
    intent,
    now: now.toISOString(),
  });
  if (!created.created) {
    const expectedHash = baseMcpActionHashV1({
      tenantId: input.userId,
      walletAddress,
      idempotencyKey: input.idempotencyKey,
      actionType: 'virtuals',
      intent,
    });
    if (created.receipt.actionHash !== expectedHash) {
      return result(created.receipt, 'That request ID is already bound to different Virtuals action facts.', {
        errorCode: 'base_mcp_action_idempotency_conflict',
      });
    }
    return result(created.receipt, 'This idempotent Virtuals action already exists. No second agent was created.');
  }

  const existingSession = await baseMcpVirtualsActionRuntimeV1.sessions.load({
    userId: input.userId,
    sessionSecret: input.sessionSecret,
  });
  if (existingSession?.stage === 'authenticated' && existingSession.walletAddress.toLowerCase() === walletAddress) {
    return createAgentV1({ receipt: created.receipt, token: existingSession.token, intent });
  }
  if (existingSession?.stage === 'awaiting_signature') {
    const failedReceipt = await baseMcpVirtualsActionRuntimeV1.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status: 'failed',
      reconciliationState: 'not_started',
      errorCode: 'virtuals_sign_in_already_pending',
      finalizedAt: now.toISOString(),
      now: now.toISOString(),
    });
    return result(failedReceipt ?? created.receipt, 'Another Virtuals sign-in is awaiting approval. Finish that Action Receipt before starting a different action.');
  }

  let tools: ToolAggregator;
  try {
    tools = await baseMcpVirtualsActionRuntimeV1.createTools(input.req, input.userId, input.sessionSecret, {
      baseMcpOnly: true,
      baseMcpAllowedActionTools: ['sign', 'personal_sign', 'sign_message'],
    });
  } catch {
    const failedReceipt = await baseMcpVirtualsActionRuntimeV1.repository.update({
      id: created.receipt.id, tenantId: input.userId, status: 'failed', reconciliationState: 'not_started',
      errorCode: 'base_mcp_connect_failed', finalizedAt: now.toISOString(), now: now.toISOString(),
    });
    return result(failedReceipt ?? created.receipt, 'Base MCP could not be reached. No sign-in approval was prepared.');
  }
  try {
    const inventory = await tools.listProviderTools();
    const toolsAvailable = inventory.reduce((count, entry) => count + entry.tools.length, 0);
    if (inventory.some((entry) => !entry.providerId.startsWith('base-mcp'))) {
      throw new Error('non_base_mcp_provider_registered');
    }
    const signTool = exactTool(inventory, 'sign') ?? exactTool(inventory, 'personal_sign') ?? exactTool(inventory, 'sign_message');
    if (!signTool) throw new Error('virtuals_sign_tool_unavailable');
    const walletMatch = await baseMcpVirtualsActionRuntimeV1.verifyWallet(tools, walletAddress);
    if (!walletMatch.checked || !walletMatch.match) throw new Error('base_mcp_wallet_unverified');

    const login = await baseMcpVirtualsActionRuntimeV1.callVirtuals({
      method: 'login_start',
      args: { walletAddress },
    });
    if (!login.ok) throw new Error(login.errorCode);
    const message = firstStringFieldV1(login.data, ['message']);
    if (!message || message.length > 10_000) throw new Error('virtuals_login_message_invalid');
    const expiresAt = new Date(now.getTime() + 25 * 60_000).toISOString();
    await baseMcpVirtualsActionRuntimeV1.sessions.save({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
      session: { stage: 'awaiting_signature', walletAddress, message, receiptId: created.receipt.id, expiresAt },
    });

    const signed = await tools.callTool(signTool.name, { type: 'personal_sign', data: { message } });
    if (signed.isError) throw new Error(sanitizedToolErrorCode(signed.content, 'virtuals_sign_prepare_failed'));
    const snapshot = extractBaseMcpApprovalSnapshot(signed.content);
    if (!snapshot.requestId) throw new Error('base_mcp_request_id_missing');
    const status = snapshot.approvalUrl ? 'approval_required' : 'pending';
    const updated = await baseMcpVirtualsActionRuntimeV1.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status,
      reconciliationState: 'not_started',
      providerRequestId: snapshot.requestId,
      durableProof: { virtualsStage: 'awaiting_signature' },
      errorCode: null,
      now: now.toISOString(),
    });
    return result(updated ?? created.receipt, 'Virtuals returned a SIWE challenge. Approve only this sign-in message in Base Account; the agent is not created until reconciliation completes.', {
      approvalUrl: snapshot.approvalUrl ?? null,
      toolsAvailable,
    });
  } catch (error) {
    await baseMcpVirtualsActionRuntimeV1.sessions.clear(input.userId).catch(() => undefined);
    const errorCode = sanitizedToolErrorCode(error instanceof Error ? error.message : String(error), 'virtuals_prepare_failed');
    const failedReceipt = await baseMcpVirtualsActionRuntimeV1.repository.update({
      id: created.receipt.id, tenantId: input.userId, status: 'failed', reconciliationState: 'not_started',
      errorCode, finalizedAt: now.toISOString(), now: now.toISOString(),
    });
    return result(failedReceipt ?? created.receipt, 'Miorail could not prepare the reviewed Virtuals sign-in. No agent was created.', { errorCode });
  } finally {
    await tools.close().catch(() => undefined);
  }
}

export async function reconcileBaseMcpVirtualsActionV1(input: {
  req: Request;
  userId: string;
  walletAddress?: string;
  sessionSecret: string;
  receipt: StoredBaseMcpActionReceiptV1;
}): Promise<BaseMcpVirtualsActionResultV1> {
  const stored = input.receipt;
  if (stored.actionType !== 'virtuals') return failed('This is not a Virtuals Action Receipt.', 'virtuals_receipt_type_mismatch');
  if (['completed', 'failed', 'rejected'].includes(stored.status)) return result(stored, 'This Virtuals Action Receipt is already final.');
  if (!input.walletAddress || input.walletAddress.toLowerCase() !== stored.walletAddress) {
    return result(stored, 'Connect the same Base Account that started this Virtuals sign-in.', { errorCode: 'base_mcp_action_wallet_mismatch' });
  }
  if (!stored.providerRequestId) return result(stored, 'The Virtuals sign-in has no durable Base MCP request ID.', { errorCode: 'base_mcp_action_outcome_unknown' });
  const pending = await baseMcpVirtualsActionRuntimeV1.sessions.load({ userId: input.userId, sessionSecret: input.sessionSecret });
  if (!pending || pending.stage !== 'awaiting_signature' || pending.receiptId !== stored.id) {
    return result(stored, 'The encrypted Virtuals sign-in session expired. Start the action again with a new request ID.', { errorCode: 'virtuals_sign_in_session_expired' });
  }

  let tools: ToolAggregator;
  try {
    tools = await baseMcpVirtualsActionRuntimeV1.createTools(input.req, input.userId, input.sessionSecret, {
      baseMcpOnly: true,
      baseMcpSensitiveResultTools: ['get_request_status'],
    });
  } catch {
    return result(stored, 'Base MCP could not be reached. The Virtuals Action Receipt remains pending.', { errorCode: 'base_mcp_connect_failed' });
  }
  try {
    const inventory = await tools.listProviderTools();
    const statusTool = exactTool(inventory, 'get_request_status');
    if (!statusTool) return result(stored, 'Base MCP did not expose request status for the pending sign-in.', { errorCode: 'base_mcp_status_unavailable' });
    const called = await tools.callTool(statusTool.name, statusArgs(statusTool, stored.providerRequestId));
    if (called.isError) return result(stored, 'Base MCP could not read the pending sign-in status.', {
      errorCode: sanitizedToolErrorCode(called.content, 'base_mcp_status_failed'),
    });
    const snapshot = extractBaseMcpApprovalSnapshot(called.content);
    if (snapshot.state === 'rejected' || snapshot.state === 'failed') {
      const now = baseMcpVirtualsActionRuntimeV1.now().toISOString();
      await baseMcpVirtualsActionRuntimeV1.sessions.clear(input.userId);
      const terminal = await baseMcpVirtualsActionRuntimeV1.repository.update({
        id: stored.id, tenantId: input.userId, status: snapshot.state, reconciliationState: 'not_started',
        errorCode: `base_mcp_${snapshot.state}`, finalizedAt: now, now,
      });
      return result(terminal ?? stored, snapshot.state === 'rejected' ? 'The Base Account sign-in approval was rejected.' : 'The Base Account sign-in approval failed.');
    }
    const signature = firstStringFieldV1(called.content, ['signature']);
    if (!signature) {
      const now = baseMcpVirtualsActionRuntimeV1.now().toISOString();
      const updated = await baseMcpVirtualsActionRuntimeV1.repository.update({
        id: stored.id, tenantId: input.userId, status: 'pending', reconciliationState: 'not_started', errorCode: null, now,
      });
      return result(updated ?? stored, 'The Base Account sign-in approval is still pending.');
    }

    const login = await baseMcpVirtualsActionRuntimeV1.callVirtuals({
      method: 'login_complete',
      args: { message: pending.message, signature },
    });
    if (!login.ok) {
      await baseMcpVirtualsActionRuntimeV1.sessions.clear(input.userId);
      const now = baseMcpVirtualsActionRuntimeV1.now().toISOString();
      const failedReceipt = await baseMcpVirtualsActionRuntimeV1.repository.update({
        id: stored.id, tenantId: input.userId, status: 'failed', reconciliationState: 'unavailable',
        errorCode: login.errorCode, finalizedAt: now, now,
      });
      return result(failedReceipt ?? stored, 'Virtuals rejected the signed SIWE challenge. No agent was created.', { errorCode: login.errorCode });
    }
    const token = firstStringFieldV1(login.data, ['token', 'accessToken', 'access_token']);
    const refreshToken = firstStringFieldV1(login.data, ['refreshToken', 'refresh_token']);
    const returnedWallet = firstStringFieldV1(login.data, ['walletAddress', 'wallet_address']);
    if (!token || (returnedWallet && returnedWallet.toLowerCase() !== stored.walletAddress)) {
      await baseMcpVirtualsActionRuntimeV1.sessions.clear(input.userId);
      return result(stored, 'Virtuals returned an invalid or mismatched authenticated session. No agent was created.', { errorCode: 'virtuals_login_response_invalid' });
    }
    await baseMcpVirtualsActionRuntimeV1.sessions.save({
      userId: input.userId,
      sessionSecret: input.sessionSecret,
      session: {
        stage: 'authenticated',
        walletAddress: stored.walletAddress,
        token,
        refreshToken,
        expiresAt: jwtExpiryV1(token),
      },
    });
    return createAgentV1({ receipt: stored, token, intent: stored.intent as BaseMcpVirtualsActionIntentV1 });
  } finally {
    await tools.close().catch(() => undefined);
  }
}
