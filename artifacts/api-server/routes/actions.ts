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

actionsRouter.post('/:actionId/execute', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user'; // Mock auth for now
    const actionId = req.params.actionId;

    await db.update(actions)
      .set({ status: 'executed', updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), eq(actions.userId, userId)));

    res.json(ExecuteActionResponseSchema.parse({ success: true }));
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
