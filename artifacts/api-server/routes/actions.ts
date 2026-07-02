import { Router } from 'express';
import { db, actions } from '@mioagent/db';
import { desc, eq, and, ne, inArray } from 'drizzle-orm';
import {
  ActionsFeedResponseSchema,
  ExecuteActionResponseSchema,
  DismissActionResponseSchema,
  DismissAllRecommendationsResponseSchema,
  DeleteRecommendationsResponseSchema,
  DeleteSingleActionResponseSchema,
  RegenerateRecommendationResponseSchema,
} from '@mioagent/api-zod';
import { detectActionIntent } from '../lib/intent.js';
import { fetchInternalPortfolio, analyzePortfolioForRisk, buildRecommendationMetadataFromAnalysis } from '../lib/portfolioAnalysis.js';

export const actionsRouter = Router();

actionsRouter.delete('/demo', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const userActions = await db.select().from(actions).where(eq(actions.userId, userId));
    const demoIds = userActions
      .filter(a => {
        const meta = (a.metadata || {}) as any;
        if (a.suggestedPrompt?.includes('Test transfer of Sepolia USDC')) return true;
        if (meta.demo === true || meta.source === 'demo' || meta.createdBy === 'seed' || meta.source === 'seed') return true;
        if (a.kind !== 'recommendation') return true;
        return false;
      })
      .map(a => a.id);

    if (demoIds.length > 0) {
      await db.delete(actions).where(and(eq(actions.userId, userId), inArray(actions.id, demoIds)));
    }
    res.json({ success: true, count: demoIds.length });
  } catch (error) {
    next(error);
  }
});

actionsRouter.patch('/recommendations/dismiss-all', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const userActions = await db.select().from(actions).where(and(eq(actions.userId, userId), eq(actions.kind, 'recommendation'), eq(actions.status, 'pending')));
    const targetIds = userActions.map(a => a.id);

    if (targetIds.length > 0) {
      await db.update(actions)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(and(eq(actions.userId, userId), inArray(actions.id, targetIds)));
    }
    res.json(DismissAllRecommendationsResponseSchema.parse({ success: true, count: targetIds.length }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.delete('/recommendations', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const confirm = req.query.confirm === 'true' || req.body?.confirm === true || req.body?.confirm === 'true';
    if (!confirm) {
      return res.status(400).json({ success: false, error: 'Confirmation required' });
    }
    const userActions = await db.select().from(actions).where(and(eq(actions.userId, userId), eq(actions.kind, 'recommendation')));
    const targetIds = userActions.map(a => a.id);

    if (targetIds.length > 0) {
      await db.delete(actions).where(and(eq(actions.userId, userId), inArray(actions.id, targetIds)));
    }
    res.json(DeleteRecommendationsResponseSchema.parse({ success: true, count: targetIds.length }));
  } catch (error) {
    next(error);
  }
});


actionsRouter.get('/', async (req, res, next) => {
  try {
    console.log("TRACE: actions GET start");
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now

    console.log("TRACE: actions GET querying db");
    const userActions = await db
      .select()
      .from(actions)
      .where(eq(actions.userId, userId))
      .orderBy(desc(actions.createdAt))
      .limit(50); // Basic limit
    console.log(`TRACE: actions GET query done, found ${userActions.length}`);

    const formattedActions = userActions.map(a => ({
      id: a.id,
      kind: a.kind,
      status: a.status as 'pending' | 'executed' | 'dismissed' | 'failed',
      suggestedPrompt: a.suggestedPrompt,
      tokens: Array.isArray(a.tokens) ? a.tokens.map(String) : undefined,
      executionPayload: a.executionPayload,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
      executedAt: null, // we don't have executedAt in db schema right now, returning null
    }));

    res.json(ActionsFeedResponseSchema.parse({ actions: formattedActions }));
  } catch (error) {
    next(error);
  }
});

import { createToolAggregatorForUser } from '@mioagent/tools';


actionsRouter.post('/recommend', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const { instruction, walletAddress: reqWallet, chainEnv: reqChainEnv } = req.body;
    const walletAddress = reqWallet || (req as { session?: { user?: { address?: string } } }).session?.user?.address;
    
    if (!instruction) {
      return res.status(400).json({ success: false, error: 'Instruction required' });
    }

    const { db, actions } = require('@mioagent/db');
    const crypto = require('node:crypto');

    const chainEnv = reqChainEnv || process.env.CHAIN_ENV || 'sepolia';
    const chainId = chainEnv === 'sepolia' ? 'eip155:84532' : 'eip155:8453';
    const isReadonly = chainEnv === 'mainnet-readonly';
    const isMainnetExecEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
    const canExecute = !isReadonly && (chainEnv !== 'mainnet' || isMainnetExecEnabled);
    
    const actionId = crypto.randomUUID();
    const payload = isReadonly ? {
      chain: chainId,
      readOnly: true,
      calls: []
    } : {
      chain: chainId,
      calls: [
        {
          to: '0x0000000000000000000000000000000000000000',
          value: '0',
          data: '0x'
        }
      ]
    };

    const intent = detectActionIntent(instruction);
    let metadata: any = {
      type: "recommendation",
      title: intent.title || "Action Recommendation",
      instruction: instruction,
      reason: intent.reason || `Automated recommendation for: "${instruction}"`,
      risk: isReadonly ? 'unknown' : 'low',
      expectedEffect: intent.expectedEffect || `Simulate action execution on ${chainEnv}`,
      chainMode: chainEnv,
      safetyState: isReadonly ? 'blocked' : (canExecute ? 'executable' : 'blocked'),
      executable: canExecute,
      executionStatus: isReadonly ? 'read-only' : (canExecute ? 'executable' : 'blocked'),
      createdBy: 'actions-builder',
      walletAddress
    };

    let tokensList: string[] | undefined;

    if (walletAddress && ['portfolio', 'risk', 'rebalance', 'security', 'yield'].includes(intent.intentType || '')) {
      try {
        const portfolio = await fetchInternalPortfolio(walletAddress, chainEnv);
        const analysis = analyzePortfolioForRisk(portfolio, walletAddress, chainEnv);
        metadata = buildRecommendationMetadataFromAnalysis({
          intent: { ...intent, createdBy: 'actions-builder' },
          message: instruction,
          walletAddress,
          chainEnv,
          analysis,
          providerContext: {
            tokenBalances: portfolio.providers.tokenBalancesProvider,
            prices: portfolio.providers.prices,
            risk: portfolio.providers.risk
          }
        });
        tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
      } catch (err) {
        console.error("Failed portfolio analysis in action builder:", err);
      }
    }

    await db.insert(actions).values({
      id: actionId,
      userId,
      kind: 'recommendation',
      status: 'pending',
      suggestedPrompt: 'Builder: ' + instruction,
      tokens: tokensList,
      executionPayload: JSON.stringify(payload),
      metadata,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ success: true, actionId });

  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/execute', async (req, res, next) => {
  try {
    console.log("TRACE: execute start");
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
    const actionId = req.params.actionId;

    const [actionToExecute] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    console.log("TRACE: execute db.select done");

    if (!actionToExecute) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }

    if (actionToExecute.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Action is not pending' });
    }

    // Try to get tools
    let aggregator;
    try {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        return res.status(500).json({ success: false, error: 'Missing SESSION_SECRET configuration' });
      }
      aggregator = await createToolAggregatorForUser(userId, sessionSecret);
    } catch {
      return res.json({ success: false, error: 'Failed to initialize tool aggregator' });
    }

    function extractExecutionPayload(action: typeof actionToExecute): { chain: string; calls: { to: string; value?: string; data?: string }[] } {
      if (action.executionPayload) {
        try {
          const parsed = typeof action.executionPayload === 'string' ? JSON.parse(action.executionPayload) : action.executionPayload;
          if (parsed && parsed.chain && Array.isArray(parsed.calls)) {
             return parsed;
          }
        } catch {
          // ignore
        }
      }
      
      // Fallback to old tokens[0]
      if (Array.isArray(action.tokens) && action.tokens.length > 0) {
        try {
          const parsed = JSON.parse(String(action.tokens[0]));
          if (parsed && parsed.chain && Array.isArray(parsed.calls)) {
            return parsed;
          }
        } catch {
          // ignore
        }
      }
      throw new Error('Malformed or missing execution payload');
    }

    let payload;
    try {
      payload = extractExecutionPayload(actionToExecute);
    } catch (e) {
      return res.status(400).json({ success: false, error: e instanceof Error ? e.message : 'Invalid payload' });
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    if (chainEnv === 'mainnet-readonly') {
      return res.json({ success: false, error: 'Mainnet execution is disabled in read-only mode.' });
    }

    if (payload.chain === 'eip155:8453' && process.env.MAINNET_EXECUTION_ENABLED !== 'true') {
      return res.json({ success: false, error: 'Mainnet execution is not enabled.' });
    }

    // If we have calls, execute them using the tool
    let toolResult;
    try {
      const isSepolia = process.env.CHAIN_ENV === 'sepolia';
      const toolName = isSepolia ? 'sepolia_send_calls' : 'send_calls';

      const tool = aggregator.findTool(toolName);
      if (!tool) {
        return res.json({ success: false, error: `MCP tool ${toolName} is not configured or available` });
      }

      toolResult = await aggregator.callTool(toolName, payload);

      // Parse the output
      if (toolResult && toolResult.content) {
         let parsedContent;
         try {
           parsedContent = JSON.parse(toolResult.content);
         } catch {
           parsedContent = {};
         }

         const approvalUrl = parsedContent.approvalUrl;
         const requestId = parsedContent.requestId;

         if (!approvalUrl || !requestId) {
           return res.json({ success: false, error: 'Backend failed to produce approvalUrl/requestId' });
         }

         await db.update(actions)
          .set({ status: 'executed', updatedAt: new Date() })
          .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

         return res.json(ExecuteActionResponseSchema.parse({ success: true, approvalUrl, requestId }));
      }
    } catch (e) {
      return res.json({ success: false, error: e instanceof Error ? e.message : 'Tool execution failed' });
    }

    return res.json({ success: false, error: 'Failed to execute action' });
  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/dismiss', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
    const actionId = req.params.actionId;

    await db.update(actions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

    res.json(DismissActionResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.delete('/:actionId', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const actionId = req.params.actionId;

    await db.delete(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    res.json(DeleteSingleActionResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});

actionsRouter.post('/:actionId/regenerate', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const actionId = req.params.actionId;

    const existing = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));
    if (existing.length === 0) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    const oldAction = existing[0];
    const oldMeta = (oldAction.metadata || {}) as any;

    const walletAddress = req.body?.walletAddress || oldMeta.analysis?.portfolioSnapshot?.walletAddress || '0x0000000000000000000000000000000000000000';
    const chainEnv = req.body?.chainEnv || oldMeta.chainMode || 'mainnet-readonly';

    const portfolioData = await fetchInternalPortfolio(walletAddress, chainEnv);
    const analysis = analyzePortfolioForRisk(portfolioData, walletAddress, chainEnv);
    const baseMeta = buildRecommendationMetadataFromAnalysis({
      intent: {
        intentType: 'risk',
        confidence: 0.9,
        actionKind: 'recommendation',
        title: 'Regenerated Risk Analysis',
        reason: 'Regenerating portfolio risk evaluation',
        expectedEffect: 'Fresh read-only token analysis',
        tokens: [],
        createdBy: oldMeta.createdBy || 'agent-stream'
      },
      message: oldAction.suggestedPrompt || 'Regenerate portfolio analysis',
      walletAddress,
      chainEnv,
      analysis,
      providerContext: {
        tokenBalances: portfolioData.providers.tokenBalancesProvider,
        prices: portfolioData.providers.prices,
        risk: portfolioData.providers.risk
      }
    });
    const newMeta = {
      ...baseMeta,
      source: oldMeta.source || oldMeta.createdBy || 'regenerated',
      createdBy: oldMeta.createdBy || 'agent-stream',
      regeneratedFrom: oldAction.id,
      chainMode: chainEnv,
      safetyState: chainEnv === 'mainnet-readonly' ? 'blocked' : 'safe',
    };

    const tokensList = analysis.tokenFindings.map(f => `${f.balanceFormatted || ''} ${f.symbol}`.trim()).slice(0, 5);
    const payload = chainEnv === 'mainnet-readonly' ? {
      chain: 'eip155:8453',
      readOnly: true,
      calls: []
    } : {
      chain: chainEnv === 'mainnet' ? 'eip155:8453' : 'eip155:84532',
      calls: []
    };

    const newActionId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await db.insert(actions).values({
      id: newActionId,
      userId,
      kind: 'recommendation',
      status: 'pending',
      suggestedPrompt: oldAction.suggestedPrompt || 'Portfolio Risk Analysis',
      tokens: tokensList,
      executionPayload: JSON.stringify(payload),
      metadata: newMeta,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await db.update(actions)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

    res.json(RegenerateRecommendationResponseSchema.parse({ success: true, actionId: newActionId }));
  } catch (error) {
    next(error);
  }
});

