import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { executionSecurityRuntime } from './executionSecurity.js';
import {
  baseMcpSendRuntime,
  detectBaseMcpSendIntent,
  runDirectBaseMcpSend,
} from './streamBaseMcpSendRouting.js';

const WALLET = '0x1234567890123456789012345678901234567890';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const originalGetProvider = executionSecurityRuntime.getProvider;
const originalSetHealth = executionSecurityRuntime.setHealth;
const originalGetRepository = baseMcpSendRuntime.getRepository;

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  executionSecurityRuntime.setHealth = originalSetHealth;
  baseMcpSendRuntime.getRepository = originalGetRepository;
});

class BaseSendProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls: Array<Record<string, unknown>> = [];
  private readonly tool: ToolDef = {
    name: 'send',
    description: 'Base Account token send',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string' },
        token: { type: 'string' },
        recipient: { type: 'string' },
        walletAddress: { type: 'string' },
        chainId: { type: 'number' },
      },
    },
  };
  async listTools() { return [this.tool]; }
  findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
  async callTool(_name: string, args: Record<string, unknown>) {
    this.calls.push(args);
    return { content: JSON.stringify({ link: 'https://wallet.base.org/approve/send-only' }), isError: false };
  }
}

function usableSecurity() {
  executionSecurityRuntime.getProvider = () => ({
    providerName: 'goplus',
    status: 'partial',
    statusCode: 'partial',
    authMode: 'public',
    provider: {
      async getTokenSecurity({ tokenAddresses, forceFresh }) {
        assert.equal(forceFresh, true);
        return tokenAddresses.map((address) => ({
          address,
          provider: 'goplus' as const,
          status: 'ok' as const,
          flags: {},
          rawRiskLabels: [],
          summary: 'usable',
        }));
      },
    },
  });
}

async function readyRepository() {
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: 'default-user',
    chainId: 8453,
    walletAddress: WALLET,
    dailyLimit: 10,
    maxPerAction: 2,
    whitelist: [RECIPIENT],
    scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000,
    mainnetOptIn: true,
  });
  baseMcpSendRuntime.getRepository = () => repository;
  return repository;
}

test('exact USDC send intent is detected before the generic Agent', () => {
  assert.deepEqual(detectBaseMcpSendIntent(`transfer 0.25 USDC to ${RECIPIENT}`), {
    amount: 0.25,
    amountText: '0.25',
    recipient: RECIPIENT,
  });
  assert.deepEqual(detectBaseMcpSendIntent(`переведи 0,25 USDC на адрес ${RECIPIENT}`), {
    amount: 0.25,
    amountText: '0.25',
    recipient: RECIPIENT,
  });
});

test('whitelisted recipient receives Base Account CTA metadata without needing wallet ownership', async () => {
  usableSecurity();
  const repository = await readyRepository();
  const provider = new BaseSendProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.approvalUrl, 'https://wallet.base.org/approve/send-only');
  assert.equal(result?.requestId, undefined);
  assert.equal(result?.approvalState, 'approval_required');
  assert.match(result?.content || '', /Confirm in Base Account/);
  assert.equal(provider.calls[0].recipient, RECIPIENT);
  assert.equal(provider.calls[0].walletAddress, WALLET);
  assert.equal((await repository.getByUser('default-user', 8453))?.reservedToday, 0.25);
});

test('non-whitelisted recipient is blocked before Base MCP', async () => {
  usableSecurity();
  await readyRepository();
  const provider = new BaseSendProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSend({
    message: 'send 0.25 USDC to 0x2222222222222222222222222222222222222222',
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'send_recipient_not_whitelisted');
  assert.equal(provider.calls.length, 0);
});

test('send reservation settles only after Base MCP reports completed', async () => {
  usableSecurity();
  const repository = await readyRepository();
  class CompletedSendProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    private tools: ToolDef[] = [
      { name: 'send', description: 'Send USDC', inputSchema: { type: 'object' } },
      { name: 'get_request_status', description: 'Request status', inputSchema: { type: 'object' } },
    ];
    async listTools() { return this.tools; }
    findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
    async callTool(name: string) {
      return name === 'send'
        ? { content: JSON.stringify({ requestId: 'completed-send' }), isError: false }
        : { content: JSON.stringify({ requestId: 'completed-send', status: 'completed', transactionHash: `0x${'a'.repeat(64)}` }), isError: false };
    }
  }
  const tools = new ToolAggregator();
  tools.registerProvider(new CompletedSendProvider());
  const result = await runDirectBaseMcpSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: WALLET,
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.approvalState, 'completed');
  const policy = await repository.getByUser('default-user', 8453);
  assert.equal(policy?.reservedToday, 0);
  assert.equal(policy?.spentToday, 0.25);
});

test('completed status without durable proof never settles the reservation', async () => {
  usableSecurity();
  const repository = await readyRepository();
  class ProoflessSendProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    private tools: ToolDef[] = [
      { name: 'send', description: 'Send USDC', inputSchema: { type: 'object' } },
      { name: 'get_request_status', description: 'Request status', inputSchema: { type: 'object' } },
    ];
    async listTools() { return this.tools; }
    findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
    async callTool(name: string) {
      return name === 'send'
        ? { content: JSON.stringify({ requestId: 'proofless-send' }), isError: false }
        : { content: JSON.stringify({ requestId: 'proofless-send', status: 'completed' }), isError: false };
    }
  }
  const tools = new ToolAggregator();
  tools.registerProvider(new ProoflessSendProvider());
  const result = await runDirectBaseMcpSend({
    message: `send 0.25 USDC to ${RECIPIENT}`,
    walletAddress: WALLET,
    tools, userConfirmedEnabled: true, userId: 'default-user',
  });
  assert.equal(result?.approvalState, 'pending');
  assert.equal(result?.errorCode, 'base_mcp_durable_proof_missing');
  const policy = await repository.getByUser('default-user', 8453);
  assert.equal(policy?.spentToday, 0);
  assert.equal(policy?.reservedToday, 0.25);
});
