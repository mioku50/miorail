import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { Request } from 'express';
import { InMemoryBaseMcpActionReceiptRepositoryV1 } from './baseMcpActionReceipts.js';
import { InMemoryBaseMcpPluginSessionStoreV1 } from './baseMcpPluginSessionStore.js';
import {
  baseMcpVirtualsActionRuntimeV1,
  prepareBaseMcpVirtualsAgentCreateV1,
  reconcileBaseMcpVirtualsActionV1,
} from './baseMcpVirtualsAction.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const original = { ...baseMcpVirtualsActionRuntimeV1 };

afterEach(() => {
  Object.assign(baseMcpVirtualsActionRuntimeV1, original);
});

function fakeBaseMcpTools(calls: string[]) {
  return {
    async listProviderTools() {
      return [{
        providerId: 'base-mcp-dynamic',
        tools: [
          { name: 'sign', inputSchema: { type: 'object', properties: {} } },
          { name: 'get_request_status', inputSchema: { type: 'object', properties: { requestId: {} } } },
        ],
      }];
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === 'sign') {
        assert.deepEqual(args, {
          type: 'personal_sign',
          data: { message: 'Sign in to Virtuals\nNonce: reviewed-1' },
        });
        return {
          content: JSON.stringify({
            status: 'approval_required',
            requestId: 'base-sign-1',
            approvalUrl: 'https://keys.coinbase.com/approve/base-sign-1',
          }),
          isError: false,
        };
      }
      assert.deepEqual(args, { requestId: 'base-sign-1' });
      return {
        content: JSON.stringify({ status: 'signed', signature: '0xsensitive-signature' }),
        isError: false,
      };
    },
    async close() {},
  } as any;
}

test('Virtuals agent creation stops for sign-in approval, reconciles once, and persists no secrets', async () => {
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const sessions = new InMemoryBaseMcpPluginSessionStoreV1();
  const baseCalls: string[] = [];
  const virtualsCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  baseMcpVirtualsActionRuntimeV1.repository = repository;
  baseMcpVirtualsActionRuntimeV1.sessions = sessions;
  baseMcpVirtualsActionRuntimeV1.createTools = async () => fakeBaseMcpTools(baseCalls);
  baseMcpVirtualsActionRuntimeV1.verifyWallet = async () => ({ checked: true, match: true, mcpAddresses: [WALLET] });
  baseMcpVirtualsActionRuntimeV1.now = () => new Date('2099-08-20T20:00:00.000Z');
  baseMcpVirtualsActionRuntimeV1.callVirtuals = async (input) => {
    virtualsCalls.push(structuredClone(input));
    if (input.method === 'login_start') {
      return { ok: true, data: { message: 'Sign in to Virtuals\nNonce: reviewed-1' } };
    }
    if (input.method === 'login_complete') {
      assert.equal(input.args.signature, '0xsensitive-signature');
      return {
        ok: true,
        data: { walletAddress: WALLET, token: 'jwt-secret', refreshToken: 'refresh-secret' },
      };
    }
    assert.equal(input.method, 'agent_create');
    assert.equal(input.args.token, 'jwt-secret');
    return { ok: true, data: { agentId: 'virtuals-agent-1', name: input.args.name } };
  };

  const input = {
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'server-session-secret',
    idempotencyKey: 'virtuals-action-1',
    intent: {
      operation: 'agent_create' as const,
      agentName: 'Mio Researcher',
      agentDescription: 'Summarize Base research every morning',
    },
  };
  const prepared = await prepareBaseMcpVirtualsAgentCreateV1(input);

  assert.equal(prepared.receipt?.status, 'approval_required');
  assert.equal(prepared.approvalUrl, 'https://keys.coinbase.com/approve/base-sign-1');
  assert.deepEqual(baseCalls, ['sign']);
  assert.deepEqual(virtualsCalls.map((call) => call.method), ['login_start']);

  const stored = await repository.get(prepared.receipt!.id, 'tenant-1');
  assert.ok(stored);
  const reconciled = await reconcileBaseMcpVirtualsActionV1({
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'server-session-secret',
    receipt: stored,
  });

  assert.equal(reconciled.receipt?.status, 'completed');
  assert.equal(reconciled.receipt?.reconciliationState, 'provider_confirmed');
  if (reconciled.receipt?.actionType === 'virtuals') {
    assert.equal(reconciled.receipt.providerObjectId, 'virtuals-agent-1');
  }
  assert.deepEqual(baseCalls, ['sign', 'get_request_status']);
  assert.deepEqual(virtualsCalls.map((call) => call.method), ['login_start', 'login_complete', 'agent_create']);
  const finalStored = await repository.get(prepared.receipt!.id, 'tenant-1');
  assert.doesNotMatch(JSON.stringify(finalStored), /sensitive-signature|jwt-secret|refresh-secret|Nonce: reviewed-1/);

  const repeated = await prepareBaseMcpVirtualsAgentCreateV1(input);
  assert.equal(repeated.receipt?.id, prepared.receipt?.id);
  assert.deepEqual(virtualsCalls.map((call) => call.method), ['login_start', 'login_complete', 'agent_create']);
});

test('Virtuals action refuses incomplete facts before storage or provider calls', async () => {
  let providerCalled = false;
  baseMcpVirtualsActionRuntimeV1.callVirtuals = async () => {
    providerCalled = true;
    return { ok: false, errorCode: 'unexpected' };
  };
  const response = await prepareBaseMcpVirtualsAgentCreateV1({
    req: {} as Request,
    userId: 'tenant-1',
    walletAddress: WALLET,
    sessionSecret: 'secret',
    idempotencyKey: 'bad',
    intent: { operation: 'agent_create', agentName: 'M', agentDescription: 'short' },
  });
  assert.equal(response.errorCode, 'virtuals_agent_facts_required');
  assert.equal(providerCalled, false);
});
