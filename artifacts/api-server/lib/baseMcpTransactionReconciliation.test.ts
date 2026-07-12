import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { reconcileBaseMcpChatMessages } from './baseMcpTransactionReconciliation.js';

const WALLET = '0x1234567890123456789012345678901234567890';
const TX_HASH = `0x${'b'.repeat(64)}`;

class RequestStatusProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls = 0;
  private readonly tool: ToolDef = {
    name: 'get_request_status',
    description: 'Get request status',
    inputSchema: { type: 'object', properties: { requestId: {} } },
  };
  constructor(private readonly response: Record<string, unknown>) {}
  async listTools() { return [this.tool]; }
  findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
  async callTool() {
    this.calls += 1;
    return { content: JSON.stringify(this.response), isError: false };
  }
}

async function reservedRepository(actionId: string) {
  const repository = new InMemoryAutonomyPolicyRepository();
  const policy = await repository.configure({
    userId: 'default-user', chainId: 8453, walletAddress: WALLET,
    dailyLimit: 10, maxPerAction: 2, whitelist: [WALLET], scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000, mainnetOptIn: true,
  });
  await repository.reserve({ policyId: policy.id, userId: 'default-user', actionId, amount: 0.25, ttlMs: 60_000 });
  return repository;
}

function pendingMessage(actionId?: string) {
  return {
    chatId: 'chat-1', messageId: 'message-1', role: 'assistant', createdAt: new Date().toISOString(),
    content: 'Pending confirmation',
    metadata: {
      directReadKind: 'base_mcp_send',
      approvalState: 'approval_required',
      approvalUrl: 'https://wallet.base.org/approve/external',
      requestId: 'request-external',
      ...(actionId ? {
        reservationActionId: actionId,
        reservationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      } : {}),
    },
  };
}

test('external approval followed by completed status settles reservation using durable tx proof', async () => {
  const actionId = 'base-mcp-send:completed';
  const repository = await reservedRepository(actionId);
  const provider = new RequestStatusProvider({ result: { request_status: 'completed', transaction_hash: TX_HASH } });
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await reconcileBaseMcpChatMessages({
    messages: [pendingMessage(actionId)], tools, repository, userId: 'default-user',
  });
  assert.equal(provider.calls, 1);
  assert.equal(result.messages[0].metadata.approvalState, 'completed');
  assert.equal(result.messages[0].metadata.transactionProof.txHash, TX_HASH);
  assert.equal(result.messages[0].metadata.approvalUrl, 'https://wallet.base.org/approve/external');
  assert.equal(result.spentTodayUsdc, '0.25');
  assert.equal(result.reservedTodayUsdc, '0');
});

test('rejected approval releases the pending reservation', async () => {
  const actionId = 'base-mcp-send:rejected';
  const repository = await reservedRepository(actionId);
  const tools = new ToolAggregator();
  tools.registerProvider(new RequestStatusProvider({ status: 'rejected', request_id: 'request-external' }));
  const result = await reconcileBaseMcpChatMessages({
    messages: [pendingMessage(actionId)], tools, repository, userId: 'default-user',
  });
  assert.equal(result.messages[0].metadata.approvalState, 'rejected');
  assert.equal(result.spentTodayUsdc, '0');
  assert.equal(result.reservedTodayUsdc, '0');
});

test('completed status without durable proof remains pending and cannot settle', async () => {
  const actionId = 'base-mcp-send:proofless';
  const repository = await reservedRepository(actionId);
  const tools = new ToolAggregator();
  tools.registerProvider(new RequestStatusProvider({ status: 'completed', requestId: 'request-external' }));
  const result = await reconcileBaseMcpChatMessages({
    messages: [pendingMessage(actionId)], tools, repository, userId: 'default-user',
  });
  assert.equal(result.messages[0].metadata.approvalState, 'pending');
  assert.equal(result.messages[0].metadata.errorCode, 'base_mcp_durable_proof_missing');
  assert.equal(result.spentTodayUsdc, '0');
  assert.equal(result.reservedTodayUsdc, '0.25');
});

test('legacy pending message safely recovers its sole matching reservation action ID', async () => {
  const actionId = 'base-mcp-send:legacy';
  const repository = await reservedRepository(actionId);
  const tools = new ToolAggregator();
  tools.registerProvider(new RequestStatusProvider({ status: 'completed', txHash: TX_HASH }));
  const result = await reconcileBaseMcpChatMessages({
    messages: [pendingMessage()], tools, repository, userId: 'default-user',
  });
  assert.equal(result.messages[0].metadata.reservationActionId, actionId);
  assert.equal(result.messages[0].metadata.approvalState, 'completed');
  assert.equal(result.spentTodayUsdc, '0.25');
});
