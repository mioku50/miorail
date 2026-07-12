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
import { baseMcpSendRuntime } from '../lib/streamBaseMcpSendRouting.js';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';

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
        inputSchema: { type: 'object', properties: { amount: {}, fromAsset: {}, toAsset: {} }, required: ['amount', 'fromAsset', 'toAsset'] },
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
    const originalGetRepository = baseMcpSwapRuntime.getRepository;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    delete process.env.UNISWAP_API_KEY;
    executionSecurityRuntime.getProvider = () => ({
      providerName: 'goplus', status: 'partial', statusCode: 'partial',
      provider: { async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({ address, provider: 'goplus' as const, status: 'ok' as const, flags: {}, rawRiskLabels: [], summary: 'verified' }));
      } },
    });
    const swapRepository = new InMemoryAutonomyPolicyRepository();
    await swapRepository.configure({
      userId: 'default-user', chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
      dailyLimit: 10, maxPerAction: 5, whitelist: ['0x2222222222222222222222222222222222222222'], scope: 'bounded-approval',
      expiresAt: Date.now() + 60_000, mainnetOptIn: true,
    });
    baseMcpSwapRuntime.getRepository = () => swapRepository;
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
      assert.ok(response.body.metadata.reservationActionId.startsWith('base-mcp-swap:'));
      assert.deepEqual(provider.calls, ['swap']);
      assert.equal(response.body.actionId, undefined);
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      executionSecurityRuntime.getProvider = originalGetSecurity;
      baseMcpSwapRuntime.getRepository = originalGetRepository;
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

  test('unmappable RU/EN transaction commands never fall through to the generic LLM', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalCreateLlm = chatRouteRuntime.createLlmProvider;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    chatRouteRuntime.createApiToolAggregatorForUser = async () => new ToolAggregator();
    chatRouteRuntime.createLlmProvider = () => { throw new Error('Generic LLM must not receive transaction commands'); };
    await request(app).delete('/api/chat/history');
    try {
      for (const message of ['обменяй USDC на ETH', 'send USDC to 0x1111111111111111111111111111111111111111']) {
        const response = await request(app).post('/api/chat').send({
          message,
          walletAddress: '0x1234567890123456789012345678901234567890',
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.metadata.errorCode, 'transaction_intent_unrecognized');
        assert.equal(response.body.actionId, undefined);
      }
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      chatRouteRuntime.createLlmProvider = originalCreateLlm;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
  });

  test('POST /api/chat routes a whitelisted send to Base MCP and returns confirmation metadata', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalGetSecurity = executionSecurityRuntime.getProvider;
    const originalGetRepository = baseMcpSendRuntime.getRepository;
    class BaseSendProvider implements ToolProvider {
      id = 'base-mcp-dynamic';
      calls: string[] = [];
      private tool: ToolDef = {
        name: 'send', description: 'Send USDC',
        inputSchema: { type: 'object', properties: { amount: {}, token: {}, recipient: {}, walletAddress: {}, chainId: {} } },
      };
      async listTools() { return [this.tool]; }
      findTool(name: string) { return name === 'send' ? this.tool : undefined; }
      async callTool(name: string) {
        this.calls.push(name);
        return { content: JSON.stringify({ approval_url: 'https://wallet.base.org/approve/send' }), isError: false };
      }
    }
    const provider = new BaseSendProvider();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(provider);
    const repository = new InMemoryAutonomyPolicyRepository();
    await repository.configure({
      userId: 'default-user', chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
      dailyLimit: 10, maxPerAction: 2,
      whitelist: ['0x1111111111111111111111111111111111111111'],
      scope: 'bounded-approval', expiresAt: Date.now() + 60_000, mainnetOptIn: true,
    });
    baseMcpSendRuntime.getRepository = () => repository;
    executionSecurityRuntime.getProvider = () => ({
      providerName: 'goplus', status: 'connected', statusCode: 'connected', authMode: 'public',
      provider: { async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({ address, provider: 'goplus' as const, status: 'ok' as const, flags: {}, rawRiskLabels: [], summary: 'verified' }));
      } },
    });
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    await request(app).delete('/api/chat/history');
    const beforeActions = (await db.select().from(actions)).length;
    try {
      const response = await request(app).post('/api/chat').send({
        message: 'send 0.05 USDC to 0x1111111111111111111111111111111111111111',
        walletAddress: '0x1234567890123456789012345678901234567890',
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.actionId, undefined);
      assert.equal(response.body.metadata.directReadKind, 'base_mcp_send');
      assert.equal(response.body.metadata.approvalUrl, 'https://wallet.base.org/approve/send');
      assert.equal(response.body.metadata.approvalState, 'approval_required');
      assert.ok(response.body.metadata.reservationActionId.startsWith('base-mcp-send:'));
      assert.deepEqual(provider.calls, ['send']);
      assert.equal((await db.select().from(actions)).length, beforeActions);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      executionSecurityRuntime.getProvider = originalGetSecurity;
      baseMcpSendRuntime.getRepository = originalGetRepository;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
  });

  test('POST /api/chat/reconcile settles an externally approved send and updates the existing message', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    const originalGetChatRepository = chatRouteRuntime.getAutonomyPolicyRepository;
    const originalGetSendRepository = baseMcpSendRuntime.getRepository;
    const originalGetSecurity = executionSecurityRuntime.getProvider;
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';

    const repository = new InMemoryAutonomyPolicyRepository();
    await repository.configure({
      userId: 'default-user', chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
      dailyLimit: 10, maxPerAction: 2,
      whitelist: ['0x1111111111111111111111111111111111111111'],
      scope: 'bounded-approval', expiresAt: Date.now() + 60_000, mainnetOptIn: true,
    });
    baseMcpSendRuntime.getRepository = () => repository;
    chatRouteRuntime.getAutonomyPolicyRepository = () => repository;
    executionSecurityRuntime.getProvider = () => ({
      providerName: 'goplus', status: 'connected', statusCode: 'connected', authMode: 'public',
      provider: { async getTokenSecurity({ tokenAddresses }) {
        return tokenAddresses.map((address) => ({ address, provider: 'goplus' as const, status: 'ok' as const, flags: {}, rawRiskLabels: [], summary: 'verified' }));
      } },
    });

    class LifecycleProvider implements ToolProvider {
      id = 'base-mcp-dynamic';
      statusCalls = 0;
      private tools: ToolDef[] = [
        { name: 'send', description: 'Send USDC', inputSchema: { type: 'object', properties: { amount: {}, token: {}, recipient: {} } } },
        { name: 'get_request_status', description: 'Status', inputSchema: { type: 'object', properties: { requestId: {} } } },
      ];
      async listTools() { return this.tools; }
      findTool(name: string) { return this.tools.find((tool) => tool.name === name); }
      async callTool(name: string) {
        if (name === 'send') return { content: JSON.stringify({ approvalUrl: 'https://wallet.base.org/approve/live', requestId: 'live-request' }), isError: false };
        this.statusCalls += 1;
        return this.statusCalls === 1
          ? { content: JSON.stringify({ status: 'pending', requestId: 'live-request' }), isError: false }
          : { content: JSON.stringify({ status: 'completed', requestId: 'live-request', txHash: `0x${'d'.repeat(64)}` }), isError: false };
      }
    }
    const provider = new LifecycleProvider();
    const aggregator = new ToolAggregator();
    aggregator.registerProvider(provider);
    chatRouteRuntime.createApiToolAggregatorForUser = async () => aggregator;
    await request(app).delete('/api/chat/history');

    try {
      const created = await request(app).post('/api/chat').send({
        message: 'send 0.05 USDC to 0x1111111111111111111111111111111111111111',
        walletAddress: '0x1234567890123456789012345678901234567890',
      });
      assert.equal(created.body.metadata.approvalState, 'pending');
      assert.equal((await repository.getByUser('default-user', 8453))?.reservedToday, 0.05);

      const reconciled = await request(app).post('/api/chat/reconcile').send({});
      assert.equal(reconciled.status, 200);
      assert.equal(reconciled.body.updatedCount, 1);
      assert.equal(reconciled.body.messages.at(-1).metadata.approvalState, 'completed');
      assert.equal(reconciled.body.autonomy.spentTodayUsdc, '0.05');
      assert.equal(reconciled.body.autonomy.reservedTodayUsdc, '0');
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      chatRouteRuntime.getAutonomyPolicyRepository = originalGetChatRepository;
      baseMcpSendRuntime.getRepository = originalGetSendRepository;
      executionSecurityRuntime.getProvider = originalGetSecurity;
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
  });

  test('POST /api/chat with action intent in mainnet-readonly generates blocked read-only recommendation', async () => {
    clearTokenSecurityCacheForTests();
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
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
    restoreEnv('CHAIN_ENV', origChain);
    restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
  });

  test('POST /api/chat revoke request fails closed (not "safe") when the approval scanner throws', async () => {
    clearTokenSecurityCacheForTests();
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    const originalFetchInternalApprovals = chatRouteRuntime.fetchInternalApprovals;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
    chatRouteRuntime.fetchInternalApprovals = async () => {
      throw new Error('approval scanner exploded');
    };
    await request(app).delete('/api/chat/history');

    try {
      // Uses the real word "revoke": after the T42.3 gate regression fix,
      // explicit revoke requests bypass the EXPLICIT_TRANSACTION_REQUEST
      // early-return gate and reach the approval-scanner code path below.
      const response = await request(app)
        .post('/api/chat')
        .send({
          message: 'revoke USDC approval for 0x1111111111111111111111111111111111111111',
          walletAddress: '0x1234567890123456789012345678901234567890',
          chainEnv: 'mainnet-readonly',
        });

      assert.strictEqual(response.status, 200);
      assert.ok(response.body.actionId);
      assert.match(response.body.content, /unavailable/i);

      const dbActions = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
      assert.strictEqual(dbActions.length, 1);
      const meta = dbActions[0].metadata as any;
      assert.notStrictEqual(meta.safetyState, 'safe');
      assert.strictEqual(meta.userConfirmable, false);
      assert.strictEqual(meta.executable, false);
    } finally {
      chatRouteRuntime.fetchInternalApprovals = originalFetchInternalApprovals;
      restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
      restoreEnv('TOKEN_BALANCES_PROVIDER', origBalancesProvider);
      restoreEnv('PRICE_PROVIDER', origPriceProvider);
      restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
  });

  test('POST /api/chat transaction gate still blocks swap/send phrases but no longer swallows revoke requests', async () => {
    clearTokenSecurityCacheForTests();
    const origChain = process.env.CHAIN_ENV;
    const origExecution = process.env.MAINNET_EXECUTION_ENABLED;
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    const origBalancesProvider = process.env.TOKEN_BALANCES_PROVIDER;
    const origPriceProvider = process.env.PRICE_PROVIDER;
    const origApprovalProvider = process.env.APPROVAL_PROVIDER;
    const originalFetchInternalApprovals = chatRouteRuntime.fetchInternalApprovals;
    const originalCreateTools = chatRouteRuntime.createApiToolAggregatorForUser;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.APPROVAL_PROVIDER = 'none';
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
    chatRouteRuntime.fetchInternalApprovals = async () => ({
      approvals: [],
      status: 'connected' as const,
      provider: 'mock' as const,
      tokenCount: 0,
      unlimitedCount: 0,
      riskySpenderCount: 0,
    });
    // Empty aggregator so direct Base MCP/quote routers cannot intercept the
    // messages before they reach the transaction gate under test.
    chatRouteRuntime.createApiToolAggregatorForUser = async () => new ToolAggregator();
    await request(app).delete('/api/chat/history');

    try {
      // Swap phrase: still blocked in read-only mode (direct swap router), no action created.
      const swapRes = await request(app)
        .post('/api/chat')
        .send({
          message: 'swap 1 USDC to ETH',
          walletAddress: '0x1234567890123456789012345678901234567890',
          chainEnv: 'mainnet-readonly',
        });
      assert.strictEqual(swapRes.status, 200);
      assert.strictEqual(swapRes.body.metadata.errorCode, 'mainnet_readonly');
      assert.strictEqual(swapRes.body.actionId, undefined);

      // Send phrase: same blocked behavior as before, no action created.
      const sendRes = await request(app)
        .post('/api/chat')
        .send({
          message: 'send 5 USDC to 0x2222222222222222222222222222222222222222',
          walletAddress: '0x1234567890123456789012345678901234567890',
          chainEnv: 'mainnet-readonly',
        });
      assert.strictEqual(sendRes.status, 200);
      assert.strictEqual(sendRes.body.metadata.errorCode, 'mainnet_readonly');
      assert.strictEqual(sendRes.body.actionId, undefined);

      // Sell phrase: not handled by any direct router, so this exercises the
      // EXPLICIT_TRANSACTION_REQUEST gate itself — still intercepts as before.
      const sellRes = await request(app)
        .post('/api/chat')
        .send({
          message: 'sell all my USDC tokens',
          walletAddress: '0x1234567890123456789012345678901234567890',
          chainEnv: 'mainnet-readonly',
        });
      assert.strictEqual(sellRes.status, 200);
      assert.strictEqual(sellRes.body.metadata.blocked, true);
      assert.strictEqual(sellRes.body.metadata.errorCode, 'mainnet_readonly');
      assert.strictEqual(sellRes.body.actionId, undefined);

      // Revoke request: NOT swallowed by the gate anymore — reaches the
      // approval-scanner branch and produces a read-only "nothing to revoke" answer.
      const revokeRes = await request(app)
        .post('/api/chat')
        .send({
          message: 'revoke USDC approval for 0x1111111111111111111111111111111111111111',
          walletAddress: '0x1234567890123456789012345678901234567890',
          chainEnv: 'mainnet-readonly',
        });
      assert.strictEqual(revokeRes.status, 200);
      assert.notStrictEqual(revokeRes.body.metadata?.errorCode, 'mainnet_readonly');
      assert.ok(revokeRes.body.actionId, 'revoke request must reach the action branch, not the transaction gate');
      assert.match(revokeRes.body.content, /no active approval found/i);
    } finally {
      chatRouteRuntime.createApiToolAggregatorForUser = originalCreateTools;
      chatRouteRuntime.fetchInternalApprovals = originalFetchInternalApprovals;
      restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
      restoreEnv('TOKEN_BALANCES_PROVIDER', origBalancesProvider);
      restoreEnv('PRICE_PROVIDER', origPriceProvider);
      restoreEnv('APPROVAL_PROVIDER', origApprovalProvider);
      restoreEnv('CHAIN_ENV', origChain);
      restoreEnv('MAINNET_EXECUTION_ENABLED', origExecution);
    }
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
