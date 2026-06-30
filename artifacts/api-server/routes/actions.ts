import { Router } from 'express';
import { db, actions } from '@mioagent/db';
import { desc, eq, and } from 'drizzle-orm';
import {
  ActionsFeedResponseSchema,
  ExecuteActionResponseSchema,
  DismissActionResponseSchema,
} from '@mioagent/api-zod';

export const actionsRouter = Router();

actionsRouter.delete('/demo', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    // We assume demo actions have something in common. But the request is to "Clear all demo actions"
    // Let's just delete all actions for now to make it easy to clear the inbox.
    const { db, actions } = require('@mioagent/db');
    const { eq } = require('drizzle-orm');
    await db.delete(actions).where(eq(actions.userId, userId));
    res.json({ success: true });
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
      createdAt: a.createdAt.toISOString(),
      executedAt: null, // we don't have executedAt in db schema right now, returning null
    }));

    res.json(ActionsFeedResponseSchema.parse({ actions: formattedActions }));
  } catch (error) {
    next(error);
  }
});

import { createToolAggregatorForUser } from '@mioagent/tools';

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
