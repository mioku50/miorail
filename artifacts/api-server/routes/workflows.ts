import { Router } from 'express';
import { db, workflows } from '@mioagent/db';
import { desc, eq, and } from 'drizzle-orm';
import {
  WorkflowsListResponseSchema,
  CreateWorkflowRequestSchema,
  CreateWorkflowResponseSchema,
  DeleteWorkflowResponseSchema,
} from '@mioagent/api-zod';
import crypto from 'crypto';

export const workflowsRouter = Router();

workflowsRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';

    const userWorkflows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.userId, userId))
      .orderBy(desc(workflows.createdAt));

    const formattedWorkflows = userWorkflows.map(w => ({
      id: w.id,
      instructions: w.instructions,
      toolAllowlist: Array.isArray(w.toolAllowlist) ? w.toolAllowlist.map(String) : null,
      intervalMs: w.intervalMs,
      lastRun: w.lastRun ? w.lastRun.toISOString() : null,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    }));

    res.json(WorkflowsListResponseSchema.parse({ workflows: formattedWorkflows }));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.post('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const body = CreateWorkflowRequestSchema.parse(req.body);

    const workflowId = crypto.randomUUID();
    const now = new Date();

    const [newWorkflow] = await db.insert(workflows).values({
      id: workflowId,
      userId,
      instructions: body.instructions,
      intervalMs: body.intervalMs,
      createdAt: now,
      updatedAt: now,
    }).returning();

    res.json(CreateWorkflowResponseSchema.parse({
      success: true,
      workflow: {
        id: newWorkflow.id,
        instructions: newWorkflow.instructions,
        toolAllowlist: Array.isArray(newWorkflow.toolAllowlist) ? newWorkflow.toolAllowlist.map(String) : null,
        intervalMs: newWorkflow.intervalMs,
        lastRun: newWorkflow.lastRun ? newWorkflow.lastRun.toISOString() : null,
        createdAt: newWorkflow.createdAt.toISOString(),
        updatedAt: newWorkflow.updatedAt.toISOString(),
      }
    }));
  } catch (error) {
    next(error);
  }
});

workflowsRouter.delete('/:workflowId', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const workflowId = req.params.workflowId;

    await db.delete(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)));

    res.json(DeleteWorkflowResponseSchema.parse({ success: true }));
  } catch (error) {
    next(error);
  }
});
