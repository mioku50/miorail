import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { executionSecurityRuntime } from './executionSecurity.js';
import { baseMcpSwapRuntime, runDirectBaseMcpSwap } from './streamBaseMcpSwapRouting.js';

const originalGetProvider = executionSecurityRuntime.getProvider;
const originalSetHealth = executionSecurityRuntime.setHealth;
const originalGetPolicy = baseMcpSwapRuntime.getPolicy;

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  executionSecurityRuntime.setHealth = originalSetHealth;
  baseMcpSwapRuntime.getPolicy = originalGetPolicy;
});

class BaseSwapProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls: Array<Record<string, unknown>> = [];
  private tool: ToolDef = {
    name: 'swap',
    description: 'Base MCP user-confirmed swap',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string' },
        fromToken: { type: 'string' },
        toToken: { type: 'string' },
        walletAddress: { type: 'string' },
        chainId: { type: 'number' },
      },
    },
  };
  async listTools() { return [this.tool]; }
  findTool(name: string) { return name === 'swap' ? this.tool : undefined; }
  async callTool(_name: string, args: Record<string, unknown>) {
    this.calls.push(args);
    return {
      content: JSON.stringify({ approvalUrl: 'https://wallet.base.org/approve/test', requestId: 'swap-request-1' }),
      isError: false,
    };
  }
}

function securityProvider(status: 'ok' | 'unknown') {
  executionSecurityRuntime.getProvider = () => ({
    providerName: 'goplus',
    status: 'partial',
    statusCode: 'partial',
    provider: {
      async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({
          address,
          provider: 'goplus' as const,
          status,
          flags: {},
          rawRiskLabels: [],
          summary: status,
        }));
      },
    },
  });
}

function readyPolicy() {
  baseMcpSwapRuntime.getPolicy = async () => ({
    id: 'policy-1', userId: 'default-user', chainId: 8453,
    walletAddress: '0x1111111111111111111111111111111111111111',
    dailyLimit: 10, maxPerAction: 5, spentToday: 0, reservedToday: 0, periodStartedAt: Date.now(),
    whitelist: [], scope: 'bounded-approval', expiresAt: Date.now() + 60_000,
    isActive: true, killSwitch: false, mainnetOptIn: true,
  });
}

test('Base MCP swap returns an approval reference without a Uniswap provider key', async () => {
  securityProvider('ok');
  readyPolicy();
  const provider = new BaseSwapProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, undefined);
  assert.equal(result?.approvalUrl, 'https://wallet.base.org/approve/test');
  assert.equal(result?.requestId, 'swap-request-1');
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0], {
    amount: '0.1',
    fromToken: 'USDC',
    toToken: 'ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    chainId: 8453,
  });
});

test('unknown canonical USDC verdict blocks Base MCP swap before the tool call', async () => {
  securityProvider('unknown');
  readyPolicy();
  const provider = new BaseSwapProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'swap_token_security_unavailable');
  assert.equal(provider.calls.length, 0);
});

test('requestId-only swap polls Base MCP request status and stays pending until confirmed', async () => {
  securityProvider('ok');
  readyPolicy();
  class RequestIdSwapProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    calls: string[] = [];
    private tools: ToolDef[] = [
      { name: 'swap', description: 'Swap', inputSchema: { type: 'object' } },
      { name: 'get_request_status', description: 'Status', inputSchema: { type: 'object', properties: { requestId: {} } } },
    ];
    async listTools() { return this.tools; }
    findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
    async callTool(name: string) {
      this.calls.push(name);
      return name === 'swap'
        ? { content: JSON.stringify({ request_id: 'swap-request-only' }), isError: false }
        : { content: JSON.stringify({ status: 'pending', nested: { approval_url: 'https://wallet.base.org/approve/request-only' } }), isError: false };
    }
  }
  const provider = new RequestIdSwapProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools,
    userConfirmedEnabled: true,
    userId: 'default-user',
  });
  assert.deepEqual(provider.calls, ['swap', 'get_request_status']);
  assert.equal(result?.requestId, 'swap-request-only');
  assert.equal(result?.approvalUrl, 'https://wallet.base.org/approve/request-only');
  assert.equal(result?.approvalState, 'pending');
  assert.doesNotMatch(result?.content || '', /completed|settled/i);
});
