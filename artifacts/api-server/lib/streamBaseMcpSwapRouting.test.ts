import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { executionSecurityRuntime } from './executionSecurity.js';
import { baseMcpSwapRuntime, mapBaseMcpSwapArgs, runDirectBaseMcpSwap } from './streamBaseMcpSwapRouting.js';
import { BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE } from './baseMcpWalletReconciliation.js';

const originalGetProvider = executionSecurityRuntime.getProvider;
const originalSetHealth = executionSecurityRuntime.setHealth;
const originalGetRepository = baseMcpSwapRuntime.getRepository;

afterEach(() => {
  executionSecurityRuntime.getProvider = originalGetProvider;
  executionSecurityRuntime.setHealth = originalSetHealth;
  baseMcpSwapRuntime.getRepository = originalGetRepository;
});

class BaseSwapProvider implements ToolProvider {
  id = 'base-mcp-dynamic';
  calls: Array<Record<string, unknown>> = [];
  private swapTool: ToolDef = {
    name: 'swap',
    description: 'Base MCP user-confirmed swap',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string' },
        fromAsset: { type: 'string' },
        toAsset: { type: 'string' },
      },
      required: ['amount', 'fromAsset', 'toAsset'],
    },
  };
  private walletTool: ToolDef = { name: 'get_wallets', description: 'Wallets', inputSchema: { type: 'object' } };
  async listTools() { return [this.swapTool, this.walletTool]; }
  findTool(name: string) { return [this.swapTool, this.walletTool].find((tool) => tool.name === name); }
  async callTool(name: string, args: Record<string, unknown>) {
    if (name === 'get_wallets') return { content: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), isError: false };
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

async function readyPolicy() {
  const repository = new InMemoryAutonomyPolicyRepository();
  await repository.configure({
    userId: 'default-user', chainId: 8453,
    walletAddress: '0x1111111111111111111111111111111111111111',
    dailyLimit: 10, maxPerAction: 5, whitelist: ['0x2222222222222222222222222222222222222222'], scope: 'bounded-approval',
    expiresAt: Date.now() + 60_000, mainnetOptIn: true,
  });
  baseMcpSwapRuntime.getRepository = () => repository;
  return repository;
}

test('Base MCP swap returns an approval reference without a Uniswap provider key', async () => {
  securityProvider('ok');
  const repository = await readyPolicy();
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
    fromAsset: 'USDC',
    toAsset: 'ETH',
  });
  assert.ok(result?.reservationActionId?.startsWith('base-mcp-swap:'));
  assert.equal((await repository.getByUser('default-user', 8453))?.reservedToday, 0.1);
});

test('unknown canonical USDC verdict blocks Base MCP swap before the tool call', async () => {
  securityProvider('unknown');
  await readyPolicy();
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

test('Base MCP swap blocks before reservation when wallet verification is unavailable', async () => {
  securityProvider('ok');
  const repository = await readyPolicy();
  class UnverifiedSwapProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    calls = 0;
    private tool: ToolDef = { name: 'swap', description: 'Swap', inputSchema: { type: 'object' } };
    async listTools() { return [this.tool]; }
    findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
    async callTool() { this.calls += 1; return { content: '{}', isError: false }; }
  }
  const provider = new UnverifiedSwapProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools, userConfirmedEnabled: true, userId: 'default-user',
  });
  assert.equal(result?.errorCode, BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE);
  assert.equal(provider.calls, 0);
  assert.equal((await repository.getByUser('default-user', 8453))?.reservedToday, 0);
});

test('requestId-only swap polls Base MCP request status and stays pending until confirmed', async () => {
  securityProvider('ok');
  await readyPolicy();
  class RequestIdSwapProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    calls: string[] = [];
    private tools: ToolDef[] = [
      { name: 'swap', description: 'Swap', inputSchema: { type: 'object' } },
      { name: 'get_wallets', description: 'Wallets', inputSchema: { type: 'object' } },
      { name: 'get_request_status', description: 'Status', inputSchema: { type: 'object', properties: { requestId: {} } } },
    ];
    async listTools() { return this.tools; }
    findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
    async callTool(name: string) {
      if (name === 'get_wallets') return { content: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), isError: false };
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

test('inputSchema=null uses the canonical live fromAsset/toAsset payload without invented wallet or chain', async () => {
  securityProvider('ok');
  await readyPolicy();
  class NullSchemaSwapProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    calls: Record<string, unknown>[] = [];
    private tools = [
      { name: 'swap', description: 'Requires fromAsset, toAsset, amount', inputSchema: null as any },
      { name: 'get_wallets', description: 'Wallets', inputSchema: { type: 'object' } },
    ];
    async listTools() { return this.tools; }
    findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
    async callTool(name: string, args: Record<string, unknown>) {
      if (name === 'get_wallets') return { content: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), isError: false };
      this.calls.push(args);
      return { content: JSON.stringify({ approvalUrl: 'https://wallet.base.org/approve/null-schema', requestId: 'null-schema' }), isError: false };
    }
  }
  const provider = new NullSchemaSwapProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'обменяй 0,1 USDC на ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools, userConfirmedEnabled: true, userId: 'default-user',
  });
  assert.equal(result?.errorCode, undefined);
  assert.deepEqual(provider.calls[0], { amount: '0.1', fromAsset: 'USDC', toAsset: 'ETH' });
});

test('live schema maps connected wallet only when the tool explicitly requests it', () => {
  const mapped = mapBaseMcpSwapArgs({
    name: 'swap', description: 'Swap',
    inputSchema: {
      type: 'object',
      properties: { amount: {}, fromAsset: {}, toAsset: {}, walletAddress: {} },
      required: ['amount', 'fromAsset', 'toAsset', 'walletAddress'],
    },
  }, { amount: '0.1', tokenIn: 'USDC', tokenOut: 'ETH' }, '0x1111111111111111111111111111111111111111');
  assert.deepEqual(mapped, {
    ok: true,
    args: {
      amount: '0.1', fromAsset: 'USDC', toAsset: 'ETH',
      walletAddress: '0x1111111111111111111111111111111111111111',
    },
  });
});

test('unmappable required swap schema fails before calling Base MCP', async () => {
  securityProvider('ok');
  await readyPolicy();
  class UnsafeSchemaProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    calls = 0;
    private swapTool: ToolDef = {
      name: 'swap', description: 'Unknown schema',
      inputSchema: { type: 'object', properties: { sourceCoin: {}, targetCoin: {}, amount: {} }, required: ['sourceCoin', 'targetCoin', 'amount'] },
    };
    private walletTool: ToolDef = { name: 'get_wallets', description: 'Wallets', inputSchema: { type: 'object' } };
    async listTools() { return [this.swapTool, this.walletTool]; }
    findTool(name: string) { return [this.swapTool, this.walletTool].find((tool) => tool.name === name); }
    async callTool(name: string) {
      if (name === 'get_wallets') return { content: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), isError: false };
      this.calls += 1; return { content: '{}', isError: false };
    }
  }
  const provider = new UnsafeSchemaProvider();
  const tools = new ToolAggregator();
  tools.registerProvider(provider);
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools, userConfirmedEnabled: true, userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'base_mcp_swap_schema_unmappable');
  assert.equal(provider.calls, 0);
});

test('successful protected tool call without approval reference is released and never settled', async () => {
  securityProvider('ok');
  const repository = await readyPolicy();
  class ReferenceMissingProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    private swapTool: ToolDef = {
      name: 'swap', description: 'Swap',
      inputSchema: { type: 'object', properties: { amount: {}, fromAsset: {}, toAsset: {} }, required: ['amount', 'fromAsset', 'toAsset'] },
    };
    private walletTool: ToolDef = { name: 'get_wallets', description: 'Wallets', inputSchema: { type: 'object' } };
    async listTools() { return [this.swapTool, this.walletTool]; }
    findTool(name: string) { return [this.swapTool, this.walletTool].find((tool) => tool.name === name); }
    async callTool(name: string) {
      if (name === 'get_wallets') return { content: JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), isError: false };
      return { content: JSON.stringify({ ok: true, access_token: 'must-never-be-logged' }), isError: false };
    }
  }
  const tools = new ToolAggregator();
  tools.registerProvider(new ReferenceMissingProvider());
  const result = await runDirectBaseMcpSwap({
    message: 'swap 0.1 USDC to ETH',
    walletAddress: '0x1111111111111111111111111111111111111111',
    tools, userConfirmedEnabled: true, userId: 'default-user',
  });
  assert.equal(result?.errorCode, 'base_mcp_approval_state_unknown');
  const policy = await repository.getByUser('default-user', 8453);
  assert.equal(policy?.spentToday, 0);
  assert.equal(policy?.reservedToday, 0);
});
