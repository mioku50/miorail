import test from 'node:test';
import assert from 'node:assert';
import { WorkflowRunner } from './index.js';
import { MockLlmProvider } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';
import { db, workflows, actions, users } from '@mioagent/db';
import { eq } from 'drizzle-orm';

test('WorkflowRunner executes and updates lastRun', async () => {
  // setup mock user and workflow in db
  const userId = 'test-user-wf';
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  const workflowId = 'test-wf-1';
  await db.insert(workflows).values({
    id: workflowId,
    userId,
    instructions: 'Test instructions',
    intervalMs: 60000,
    toolAllowlist: []
  }).onConflictDoUpdate({
    target: workflows.id,
    set: { lastRun: null }
  });

  const llm = new MockLlmProvider(() => 'Workflow executed');
  const tools = new ToolAggregator();
  const runner = new WorkflowRunner({ llmProvider: llm, toolAggregator: tools });

  await runner.tick();

  const updatedWf = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  assert.ok(updatedWf[0].lastRun !== null);

  // cleanup
  await db.delete(workflows).where(eq(workflows.id, workflowId));
});

test('WorkflowRunner emit pseudo-tools', async () => {
  const userId = 'test-user-emit';
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  const workflowId = 'test-wf-2';
  await db.insert(workflows).values({
    id: workflowId,
    userId,
    instructions: 'Emit an alert',
    intervalMs: 60000,
    toolAllowlist: []
  }).onConflictDoUpdate({
    target: workflows.id,
    set: { lastRun: null }
  });

  const llm = new MockLlmProvider((req) => {
    if (req.messages.length <= 2) {
      return 'TOOL:emit_alert|{"message": "alert!"}';
    }
    return 'Done';
  });

  const tools = new ToolAggregator();
  const runner = new WorkflowRunner({ llmProvider: llm, toolAggregator: tools });

  await runner.tick();

  const actionRows = await db.select().from(actions).where(eq(actions.userId, userId));
  assert.ok(actionRows.length > 0);
  assert.strictEqual(actionRows[actionRows.length - 1].kind, 'alert');
  assert.strictEqual(actionRows[actionRows.length - 1].suggestedPrompt, 'alert!');

  // cleanup
  await db.delete(actions).where(eq(actions.userId, userId));
  await db.delete(workflows).where(eq(workflows.id, workflowId));

  const { client } = await import('@mioagent/db');
  await client.end();
});