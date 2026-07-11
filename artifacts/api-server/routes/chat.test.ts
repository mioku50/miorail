import test, { describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { db, actions } from '@mioagent/db';
import { eq } from 'drizzle-orm';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';
import { ToolAggregator, type ToolDef, type ToolProvider } from '@mioagent/tools';
import { chatRouteRuntime } from './chat.js';
import { executionSecurityRuntime } from '../lib/executionSecurity.js';
import { baseMcpSwapRuntime } from '../lib/streamBaseMcpSwapRouting.js';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('Chat API & Recommendation Guardrails', () => {
  test('DELETE /api/chat/history clears chat history and GET returns empty list', async () => {
    const delRes = await request(app).delete('/api/chat/history');
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);

    const getRes = await request(app).get('/api/chat/history');
    assert.strictEqual(getRes.status, 200);
    assert.deepStrictEqual(getRes.body.messages, []);
  });

  test('POST /api/chat routes simple balance reads to Base MCP without creating an inbox action', async () => {
    class BaseReadProvider implements ToolProvider {
      id = 'base-mcp-dynamic';
      calls: string[] = [];
      private tool: ToolDef = {
        name: 'get_portfolio',
        description: 'Read Base Account portfolio',
        inputSchema: { type: 'object', properties: { address: { type: 'string' }, chain: { enum: ['base'] } } },
      };
      async listTools() { return [this.tool]; }
      findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
      async callTool(name: string) {
        this.calls.push(name);
        return { content: '{"tokens":[{"symbol":"USDC","balance":"42.5"}]}', isError: false };
      }
    }

    const provider = new BaseReadProvider();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(provider);
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalCreateLlm = chatRouteRuntime.createLlmProvider;
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    chatRouteRuntime.createLlmProvider = () => { throw new Error('LLM must not run for direct Base reads'); };
    await request(app).delete('/api/chat/history');
    const beforeActions = (await db.select().from(actions)).length;

    try {
      const response = await request(app).post('/api/chat').send({
        message: 'check my balance',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.actionId, undefined);
      assert.equal(response.body.metadata.directReadKind, 'base_portfolio');
      assert.match(response.body.content, /42\.5/);
      assert.deepEqual(provider.calls, ['get_portfolio']);
      assert.deepEqual(response.body.toolCalls[0].result, { status: 'success' });
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      chatRouteRuntime.createLlmProvider = originalCreateLlm;
    }
  });

  test('POST /api/chat routes a Uniswap quote before action detection and creates no inbox action', async () => {
    class QuoteProvider implements ToolProvider {
      id = 'uniswap-quote';
      calls: string[] = [];
      private tool: ToolDef = { name: 'uniswap_quote', description: 'Read-only quote', inputSchema: { type: 'object' } };
      async listTools() { return [this.tool]; }
      findTool(name: string) { return name === this.tool.name ? this.tool : undefined; }
      async callTool(name: string) {
        this.calls.push(name);
        return {
          content: JSON.stringify({
            quoteOnly: true,
            chainId: 8453,
            amountIn: '0.1',
            amountOut: '0.000025',
            tokenIn: { symbol: 'USDC', decimals: 6 },
            tokenOut: { symbol: 'ETH', decimals: 18 },
            route: { provider: 'Uniswap', routing: 'CLASSIC', path: ['USDC', 'ETH'] },
            priceImpactPct: 0.02,
            slippagePct: 0.5,
            gasEstimate: { value: '0.003', unit: 'USD' },
            transactionPrepared: false,
          }),
          isError: false,
        };
      }
    }
    const provider = new QuoteProvider();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(provider);
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalCreateLlm = chatRouteRuntime.createLlmProvider;
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    chatRouteRuntime.createLlmProvider = () => { throw new Error('LLM must not run for direct quotes'); };
    await request(app).delete('/api/chat/history');
    const beforeActions = (await db.select().from(actions)).length;

    try {
      const response = await request(app).post('/api/chat').send({
        message: 'quote 0.1 USDC to ETH and show route/slippage/gas',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.actionId, undefined);
      assert.equal(response.body.metadata.directReadKind, 'uniswap_quote');
      assert.deepEqual(provider.calls, ['uniswap_quote']);
      assert.match(response.body.content, /Price impact/);
      assert.match(response.body.content, /No calldata, approval, or transaction was prepared/);
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      chatRouteRuntime.createLlmProvider = originalCreateLlm;
    }
  });

  test('POST /api/chat uses Base MCP-first swap approval without requiring a Uniswap key', async () => {
    class BaseSwapProvider implements ToolProvider {
      id = 'base-mcp-dynamic';
      calls: string[] = [];
      private tool: ToolDef = {
        name: 'swap',
        description: 'Base MCP swap',
        inputSchema: { type: 'object', properties: { amount: {}, fromToken: {}, toToken: {}, walletAddress: {}, chainId: {} } },
      };
      async listTools() { return [this.tool]; }
      findTool(name: string) { return name === 'swap' ? this.tool : undefined; }
      async callTool(name: string) {
        this.calls.push(name);
        return { content: JSON.stringify({ approvalUrl: 'https://wallet.base.org/approve/swap', requestId: 'swap-1' }), isError: false };
      }
    }
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const origUniswapKey = process.env.UNISWAP_API_KEY;
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalGetSecurity = executionSecurityRuntime.getProvider;
    const originalGetPolicy = baseMcpSwapRuntime.getPolicy;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    delete process.env.UNISWAP_API_KEY;
    executionSecurityRuntime.getProvider = () => ({
      providerName: 'goplus', status: 'partial', statusCode: 'partial',
      provider: { async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({ address, provider: 'goplus' as const, status: 'ok' as const, flags: {}, rawRiskLabels: [], summary: 'verified' }));
      } },
    });
    baseMcpSwapRuntime.getPolicy = async () => ({
      id: 'swap-policy', userId: 'default-user', chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
      dailyLimit: 10, maxPerAction: 5, spentToday: 0, reservedToday: 0, periodStartedAt: Date.now(),
      whitelist: [], scope: 'bounded-approval', expiresAt: Date.now() + 60_000,
      isActive: true, killSwitch: false, mainnetOptIn: true,
    });
    const provider = new BaseSwapProvider();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(provider);
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    await request(app).delete('/api/chat/history');
    const beforeActions = (await db.select().from(actions)).length;
    try {
      const response = await request(app).post('/api/chat').send({
        message: 'swap 0.1 USDC to ETH',
        walletAddress: '0x1234567890123456789012345678901234567890',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.metadata.directReadKind, 'base_mcp_swap');
      assert.equal(response.body.metadata.requestId, 'swap-1');
      assert.equal(response.body.metadata.approvalUrl, 'https://wallet.base.org/approve/swap');
      assert.deepEqual(provider.calls, ['swap']);
      assert.equal(response.body.actionId, undefined);
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      executionSecurityRuntime.getProvider = originalGetSecurity;
      baseMcpSwapRuntime.getPolicy = originalGetPolicy;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
      restoreEnv('UNISWAP_API_KEY', origUniswapKey);
    }
  });

  test('POST /api/chat blocks a transfer in mainnet-readonly without creating an inbox action', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
    const aggregator = new ToolAggregator();
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    await request(app).delete('/api/chat/history');
    const beforeActions = (await db.select().from(actions)).length;
    try {
      const response = await request(app).post('/api/chat').send({
        message: 'send 0.05 USDC to 0x1111111111111111111111111111111111111111',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.metadata.errorCode, 'mainnet_readonly');
      assert.equal(response.body.actionId, undefined);
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
  });

  test('POST /api/chat in user-confirmed mainnet creates only an unsigned limited-transfer request', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    const aggregator = new ToolAggregator();
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    await request(app).delete('/api/chat/history');
    try {
      const response = await request(app).post('/api/chat').send({
        message: 'send 0.05 USDC to 0x1111111111111111111111111111111111111111',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly',
      });
      assert.equal(response.status, 200);
      assert.ok(response.body.actionId);
      const [created] = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
      const payload = typeof created.executionPayload === 'string'
        ? JSON.parse(created.executionPayload)
        : created.executionPayload as any;
      assert.equal(payload.actionType, 'limited_transfer');
      assert.equal(payload.calls.length, 1);
      assert.equal((created.metadata as any).userConfirmable, true);
      assert.equal((created.metadata as any).executable, false);
      assert.equal(JSON.stringify(payload).includes('signature'), false);
      assert.equal(JSON.stringify(payload).includes('privateKey'), false);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
      restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurity);
    }
  });

  test('POST /api/chat with action intent in mainnet-readonly generates blocked read-only recommendation', async () => {
    clearTokenSecurityCacheForTests();
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    await request(app).delete('/api/chat/history');

    const response = await request(app)
      .post('/api/chat')
      .send({
        message: 'review my portfolio',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly'
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.role, 'assistant');
    assert.ok(response.body.actionId);
    assert.strictEqual(response.body.metadata.type, 'recommendation');

    const dbActions = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
    assert.strictEqual(dbActions.length, 1);
    const createdAction = dbActions[0];
    assert.strictEqual(createdAction.kind, 'recommendation');
    assert.strictEqual((createdAction.metadata as any).safetyState, 'blocked');
    assert.strictEqual((createdAction.metadata as any).chainMode, 'mainnet-readonly');
    assert.ok((createdAction.metadata as any).analysis);
    assert.ok((createdAction.metadata as any).analysis.securityProvider);
    assert.strictEqual((createdAction.metadata as any).analysis.portfolioSnapshot.walletAddress, '0x1234567890123456789012345678901234567890');
    assert.ok((createdAction.metadata as any).analysis.portfolioSnapshot.dataFreshness !== undefined);
    assert.ok((createdAction.metadata as any).analysis.portfolioSnapshot.snapshotTimestamp !== undefined);
    assert.ok(Array.isArray(createdAction.tokens));

    const payload = typeof createdAction.executionPayload === 'string'
      ? JSON.parse(createdAction.executionPayload)
      : createdAction.executionPayload;
    assert.strictEqual(payload.readOnly, true);
    assert.deepStrictEqual(payload.calls, []);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalancesProvider);
    restoreEnv('PRICE_PROVIDER', origPriceProvider);
    restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
  });

  test('POST /api/actions/recommend with portfolio intent generates analysis metadata', async () => {
    clearTokenSecurityCacheForTests();
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    const response = await request(app)
      .post('/api/actions/recommend')
      .send({
        instruction: 'analyze my wallet tokens for risk',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly'
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId);

    const dbActions = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
    assert.strictEqual(dbActions.length, 1);
    const createdAction = dbActions[0];
    assert.ok((createdAction.metadata as any).analysis);
    assert.ok((createdAction.metadata as any).analysis.securityProvider);
    assert.ok((createdAction.metadata as any).analysis.portfolioSnapshot.tokenCount >= 1);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
    restoreEnv('TOKEN_BALANCES_PROVIDER', origBalancesProvider);
    restoreEnv('PRICE_PROVIDER', origPriceProvider);
    restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
  });
});
