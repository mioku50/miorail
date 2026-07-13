import test, { after } from 'node:test';
import assert from 'node:assert';
import { WorkflowRunner } from './index.js';
import { MockLlmProvider } from '@mioagent/llm/testing';
import { ToolAggregator } from '@mioagent/tools';
import { closeDb, db, testFixtureId, workflows, users } from '@mioagent/db';
import { eq } from 'drizzle-orm';

after(async () => {
  await closeDb();
});

test('WorkflowRunner load test: processes multiple workflows efficiently', async () => {
  const userId = testFixtureId('scheduler-load-user');
  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  const numWorkflows = 20;
  const workflowIds: string[] = [];

  try {
    for (let i = 0; i < numWorkflows; i++) {
      const id = testFixtureId(`scheduler-load-workflow-${i}`);
      workflowIds.push(id);
      await db.insert(workflows).values({
        id,
        userId,
        instructions: 'Load test instructions',
        intervalMs: 60000,
        toolAllowlist: []
      }).onConflictDoNothing();
      await db.update(workflows).set({ lastRun: null }).where(eq(workflows.id, id));
    }

    const llm = new MockLlmProvider(() => 'Workflow executed');
    const tools = new ToolAggregator();
    const runner = new WorkflowRunner({ llmProvider: llm, toolAggregator: tools });

    const startTime = performance.now();
    await runner.tick();
    const endTime = performance.now();
    const durationMs = endTime - startTime;

    console.log(`Load test for ${numWorkflows} workflows took ${durationMs}ms`);

    // Assert that all workflows were updated
    for (const id of workflowIds) {
      const updatedWf = await db.select().from(workflows).where(eq(workflows.id, id));
      assert.ok(updatedWf[0].lastRun !== null, `Workflow ${id} was not run`);
    }

    // Reasonable threshold for 20 mock LLM executions sequentially
    assert.ok(durationMs < 5000, `Execution took too long: ${durationMs}ms`);
  } finally {
    // Cleanup
    for (const id of workflowIds) {
      await db.delete(workflows).where(eq(workflows.id, id));
    }
  }
});
