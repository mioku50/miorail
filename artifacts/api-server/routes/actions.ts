import { Router } from 'express';
import { db, actions } from '@mioagent/db';
import { desc, eq, and } from 'drizzle-orm';
import {
  ActionsFeedResponseSchema,
  ExecuteActionResponseSchema,
  DismissActionResponseSchema,
} from '@mioagent/api-zod';

export const actionsRouter = Router();

actionsRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now

    const userActions = await db
      .select()
      .from(actions)
      .where(eq(actions.userId, userId))
      .orderBy(desc(actions.createdAt))
      .limit(50); // Basic limit

    const formattedActions = userActions.map(a => ({
      id: a.id,
      kind: a.kind,
      status: a.status as 'pending' | 'executed' | 'dismissed' | 'failed',
      suggestedPrompt: a.suggestedPrompt,
      tokens: Array.isArray(a.tokens) ? a.tokens.map(String) : undefined,
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
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
    const actionId = req.params.actionId;

    const [actionToExecute] = await db.select().from(actions).where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

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

    // We assume the action has the needed information in its tokens
    let payload = { chain: 'base', calls: [] };
    if (Array.isArray(actionToExecute.tokens) && actionToExecute.tokens.length > 0) {
      try {
        const parsed = JSON.parse(actionToExecute.tokens[0]);
        if (parsed.chain && Array.isArray(parsed.calls)) {
          payload = parsed;
        }
      } catch {
        // use default empty payload
      }
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

         if (!approvalUrl) {
           return res.json({ success: false, error: 'MCP returned no approval URL' });
         }

         await db.update(actions)
          .set({ status: 'executed', updatedAt: new Date() })
          .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

         return res.json(ExecuteActionResponseSchema.parse({ success: true, approvalUrl, txHash: requestId }));
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
