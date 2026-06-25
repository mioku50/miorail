import test from 'node:test';
import assert from 'node:assert';
import { Agent } from '../src/index.js';
import { MockLlmProvider, LlmRequest } from '@mioagent/llm';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, actions, users, workflows } from '@mioagent/db';

test('T6.3 E2E mock happy-path: chat -> recommendation -> execute approval URL', async () => {
    const userId = 'e2e-user-1';
    await db.insert(users).values({ id: userId }).onConflictDoNothing();

    // 1. Mock LLM that generates a recommendation when chatting
    const llm = new MockLlmProvider((req: LlmRequest) => {
        const lastMsg = req.messages[req.messages.length - 1].content;
        if (typeof lastMsg === 'string' && lastMsg.includes('Help me')) {
            return 'TOOL:emit_recommendation|{"message":"Execute a test transaction"}';
        }
        if (typeof lastMsg === 'string' && lastMsg.includes('Execute a test transaction')) {
            return 'TOOL:send_calls|{"chain":"base","calls":[{"to":"0x0"}]}';
        }
        return 'Done';
    });

    // 2. Setup tools: emit_recommendation pseudo-tool and mock-mcp for send_calls
    const tools = new ToolAggregator();
    class E2EPseudoTools implements ToolProvider {
        id = 'pseudo';
        async listTools(): Promise<ToolDef[]> {
            return [
                { name: 'emit_recommendation', description: 'Emit a recommendation', inputSchema: { type: 'object' } }
            ];
        }
        findTool(name: string) {
            if (name === 'emit_recommendation') return { name, description: 'Emit a recommendation', inputSchema: { type: 'object' } };
            return undefined;
        }
        async callTool(name: string, _args: Record<string, unknown>) {
            if (name === 'emit_recommendation') {
                const message = typeof _args.message === 'string' ? _args.message : 'Recommendation';
                await db.insert(actions).values({
                    id: randomUUID(),
                    userId,
                    kind: 'recommendation',
                    status: 'pending',
                    suggestedPrompt: message
                });
                return { content: 'Emitted recommendation', isError: false };
            }
            throw new Error('Not found');
        }
    }
    class E2EMcpProvider implements ToolProvider {
        id = 'mock-mcp';
        async listTools(): Promise<ToolDef[]> {
            return [{ name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } }];
        }
        findTool(name: string) {
            if (name === 'send_calls') return { name, description: 'Sends calls', inputSchema: { type: 'object' } };
            return undefined;
        }
        async callTool(name: string, _args: Record<string, unknown>) {
            if (name === 'send_calls') {
                return { content: JSON.stringify({ approvalUrl: 'https://mock.base.org/approve/e2e', requestId: 'e2e-req' }), isError: false };
            }
            throw new Error('Not found');
        }
    }
    tools.registerProvider(new E2EPseudoTools());
    tools.registerProvider(new E2EMcpProvider());

    const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

    const { MemoryService } = await import('@mioagent/memory');
    const originalGetUserSettings = MemoryService.getUserSettings;
    MemoryService.getUserSettings = async () => null;

    try {
        // Step 1: User chats, agent emits recommendation
        const events1 = [];
        for await (const ev of agent.chatStream(userId, 'Help me')) {
            events1.push(ev);
        }
        const emitToolResult = events1.find(e => e.type === 'tool_result' && e.toolName === 'emit_recommendation');
        assert.ok(emitToolResult);

        // Step 2: Feed has recommendation
        const actionRows = await db.select().from(actions).where(eq(actions.userId, userId));
        assert.ok(actionRows.length > 0);
        const recommendation = actionRows[actionRows.length - 1]; // pick the most recent one to avoid conflict with other tests
        assert.strictEqual(recommendation.kind, 'recommendation');
        assert.strictEqual(recommendation.status, 'pending');

        // Step 3: Execute recommendation
        const events2 = [];
        for await (const ev of agent.chatStream(userId, recommendation.suggestedPrompt!)) {
            events2.push(ev);
        }
        const sendCallsResult = events2.find(e => e.type === 'tool_result' && e.toolName === 'send_calls') as { type: 'tool_result'; approvalUrl?: string; requestId?: string } | undefined;
        assert.ok(sendCallsResult);
        assert.strictEqual(sendCallsResult.approvalUrl, 'https://mock.base.org/approve/e2e');
        assert.strictEqual(sendCallsResult.requestId, 'e2e-req');

    } finally {
        MemoryService.getUserSettings = originalGetUserSettings;
        await db.delete(actions).where(eq(actions.userId, userId));
    }
});

test('T6.4 E2E scanner test: scanner tick -> emit -> feed -> execute', async () => {
    const userId = 'e2e-scanner-user';
    await db.insert(users).values({ id: userId }).onConflictDoNothing();

    // 1. Mock LLM for the scanner that emits an alert/recommendation
    const llm = new MockLlmProvider((req: LlmRequest) => {
                const lastMsg = req.messages[req.messages.length - 1].content;

        // This is what agent.chatStream() sends as userMessage.
        // In WorkflowRunner, it sends "Run workflow" or instructions.
        if (typeof lastMsg === 'string' && lastMsg.includes('Run workflow')) {
            return 'TOOL:emit_recommendation|{"message":"Auto-detected a need to execute"}';
        }
        if (typeof lastMsg === 'string' && lastMsg.includes('Auto-detected a need to execute')) {
            return 'TOOL:send_calls|{"chain":"base","calls":[{"to":"0x0"}]}';
        }
        return 'Done';
    });

    // 2. Insert workflow
    const workflowId = 'e2e-scanner-wf';
    await db.insert(workflows).values({
        id: workflowId,
        userId,
        instructions: 'Run workflow',
        intervalMs: 60000,
        toolAllowlist: [] // Pseudo-tools are always added by WorkflowRunner
    }).onConflictDoUpdate({
        target: workflows.id,
        set: { lastRun: null }
    });

    // 3. Setup tools for execution
    const tools = new ToolAggregator();
    class E2EMcpProvider implements ToolProvider {
        id = 'mock-mcp';
        async listTools(): Promise<ToolDef[]> {
            return [{ name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } }];
        }
        findTool(name: string) {
            if (name === 'send_calls') return { name, description: 'Sends calls', inputSchema: { type: 'object' } };
            return undefined;
        }
        async callTool(name: string, _args: Record<string, unknown>) {
            if (name === 'send_calls') {
                return { content: JSON.stringify({ approvalUrl: 'https://mock.base.org/approve/scanner', requestId: 'scanner-req' }), isError: false };
            }
            throw new Error('Not found');
        }
    }
    tools.registerProvider(new E2EMcpProvider());

    const { MemoryService } = await import('@mioagent/memory');
    const originalGetUserSettings = MemoryService.getUserSettings;
    MemoryService.getUserSettings = async () => null;

    try {
        // Step 1: Scanner tick -> emit
        const runnerTools = new ToolAggregator(); // The runner creates its own internal aggregator with the filtered ones, we just need the parent to pass to config. The runner will register pseudo tools itself.
        const runnerConfig = { llmProvider: llm, toolAggregator: runnerTools };
        const { WorkflowRunner } = await import('../src/scheduler/index.js');
        const runner = new WorkflowRunner(runnerConfig);
        await runner.tick();

        // Step 2: Check feed
        const actionRows = await db.select().from(actions).where(eq(actions.userId, userId));
        assert.ok(actionRows.length > 0);
        const recommendation = actionRows[actionRows.length - 1]; // pick the most recent one
        assert.strictEqual(recommendation.kind, 'recommendation');
        assert.strictEqual(recommendation.status, 'pending');
        assert.strictEqual(recommendation.suggestedPrompt, 'Auto-detected a need to execute');

        // Step 3: Execute recommendation
        const execAgent = new Agent({ llmProvider: llm, toolAggregator: tools });
        const events = [];
        for await (const ev of execAgent.chatStream(userId, recommendation.suggestedPrompt!)) {
            events.push(ev);
        }

        const sendCallsResult = events.find(e => e.type === 'tool_result' && e.toolName === 'send_calls') as { type: 'tool_result'; approvalUrl?: string; requestId?: string } | undefined;
        assert.ok(sendCallsResult);
        assert.strictEqual(sendCallsResult.approvalUrl, 'https://mock.base.org/approve/scanner');
        assert.strictEqual(sendCallsResult.requestId, 'scanner-req');

    } finally {
        MemoryService.getUserSettings = originalGetUserSettings;
        await db.delete(actions).where(eq(actions.userId, userId));
        await db.delete(workflows).where(eq(workflows.id, workflowId));
    }
});

test('Clean up DB connection', async () => {
    const { client } = await import('@mioagent/db');
    await client.end();
});
