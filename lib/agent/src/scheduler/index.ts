import { AgentConfig, Agent } from '../index.js';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';
import { db, workflows, actions } from '@mioagent/db';
import { eq, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

class PseudoToolProvider implements ToolProvider {
  id = 'pseudo';
  constructor(private userId: string) {}

  async listTools(): Promise<ToolDef[]> {
    return [
      {
        name: 'emit_alert',
        description: 'Emit an alert for the user',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
      },
      {
        name: 'emit_recommendation',
        description: 'Emit a recommendation for the user',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
      }
    ];
  }

  findTool(name: string): ToolDef | undefined {
    if (name === 'emit_alert' || name === 'emit_recommendation') {
      return {
        name,
        description: `Emit ${name}`,
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
      };
    }
    return undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const message = typeof args.message === 'string' ? args.message : JSON.stringify(args);
    const kind = name === 'emit_alert' ? 'alert' : 'recommendation';
    await db.insert(actions).values({
      id: randomUUID(),
      userId: this.userId,
      kind,
      status: 'pending',
      suggestedPrompt: message,
      metadata: { createdBy: 'scanner' }
    });
    return { content: `Successfully emitted ${kind}`, isError: false };
  }
}

class FilteredProvider implements ToolProvider {
  id = 'filtered';
  constructor(private config: AgentConfig, private allowlist: string[]) {}
  async listTools() {
    const all = await this.config.toolAggregator.listTools();
    return all.filter(t => this.allowlist.includes(t.name));
  }
  findTool(name: string) {
    if (!this.allowlist.includes(name)) return undefined;
    return this.config.toolAggregator.findTool(name);
  }
  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.allowlist.includes(name)) throw new Error(`Tool ${name} not allowed`);
    return this.config.toolAggregator.callTool(name, args);
  }
}

export class WorkflowRunner {
  constructor(private config: AgentConfig) {}

  async tick(): Promise<void> {
    const workflowsToRun = await db.select().from(workflows).where(
      or(
        isNull(workflows.lastRun),
        sql`last_run + (interval_ms * interval '1 millisecond') <= now()`
      )
    );

    for (const workflow of workflowsToRun) {
      try {
        await this.runWorkflow(workflow);
        await db.update(workflows)
          .set({ lastRun: sql`now()` })
          .where(eq(workflows.id, workflow.id));
      } catch (e) {
        console.error(`Failed to run workflow ${workflow.id}`, e);
      }
    }
  }

  private async runWorkflow(workflow: typeof workflows.$inferSelect): Promise<void> {
    const allowlist = Array.isArray(workflow.toolAllowlist) ? workflow.toolAllowlist as string[] : [];

    const restrictedAggregator = new ToolAggregator();
    restrictedAggregator.registerProvider(new FilteredProvider(this.config, allowlist));
    restrictedAggregator.registerProvider(new PseudoToolProvider(workflow.userId));

    const agent = new Agent({
      llmProvider: this.config.llmProvider,
      toolAggregator: restrictedAggregator
    });

    const prompt = workflow.instructions || 'Run workflow';
    console.log(`Running workflow ${workflow.id} for user ${workflow.userId} with prompt ${prompt}`);
    for await (const ev of agent.chatStream(workflow.userId, prompt)) {
        console.log(`Workflow runner event: ${ev.type}`, ev);
      // Drain the stream
    }
  }
}
