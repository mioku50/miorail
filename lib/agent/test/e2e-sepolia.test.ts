import test from 'node:test';
import assert from 'node:assert';
import { Agent } from '../src/index.js';
import { MockLlmProvider, LlmRequest } from '@mioagent/llm';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, actions, users } from '@mioagent/db';
import { AutonomyEngine } from '@mioagent/autonomy';
import { SepoliaToolProvider } from '@mioagent/tools/src/sepolia.js';
import { McpSendCallsClient } from '@mioagent/mcp/src/send_calls.js';
import { BaseMcpClient } from '@mioagent/mcp/src/client.js';

test('T7.7 E2E on Sepolia: chat -> execute', async () => {
    const userId = 'e2e-sepolia-user-1';
    await db.insert(users).values({ id: userId }).onConflictDoNothing();

    const llm = new MockLlmProvider((req: LlmRequest) => {
        const lastMsg = req.messages[req.messages.length - 1].content;
        if (typeof lastMsg === 'string' && lastMsg.includes('Help me')) {
            return 'TOOL:emit_recommendation|{"message":"Execute a test transaction"}';
        }
        if (typeof lastMsg === 'string' && lastMsg.includes('Execute a test transaction')) {
            return 'TOOL:sepolia_send_calls|{"chain":"84532","calls":[{"to":"0x036cbd53842c5426634e7929541ec2318f3dcf7e"}]}';
        }
        return 'Done';
    });

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

    class TestBaseClient extends BaseMcpClient {
      async connect() {}
      getClient() {
        return {
          callTool: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ approvalUrl: 'https://mock.base.org/approve/sepolia', requestId: 'sepolia-req' }) }]
          })
        } as any;
      }
    }
    const testMcpClient = new McpSendCallsClient(new TestBaseClient());
    const sepoliaProvider = new SepoliaToolProvider(testMcpClient);

    const originalFetch = global.fetch;
    global.fetch = async (url: string | URL | globalThis.Request, init?: RequestInit) => {
       if (url.toString().includes('sepolia.base.org')) {
           return {
               json: async () => ({ result: '0x5208' }) // 21000 gas
           } as Response;
       }
       return originalFetch(url, init);
    };

    tools.registerProvider(new E2EPseudoTools());
    tools.registerProvider(sepoliaProvider);

    const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

    const { MemoryService } = await import('@mioagent/memory');
    const originalGetUserSettings = MemoryService.getUserSettings;
    MemoryService.getUserSettings = async () => null;

    try {
        const events1 = [];
        for await (const ev of agent.chatStream(userId, 'Help me')) {
            events1.push(ev);
        }
        const emitToolResult = events1.find(e => e.type === 'tool_result' && e.toolName === 'emit_recommendation');
        assert.ok(emitToolResult);

        const actionRows = await db.select().from(actions).where(eq(actions.userId, userId));
        assert.ok(actionRows.length > 0);
        const recommendation = actionRows[actionRows.length - 1];
        assert.strictEqual(recommendation.kind, 'recommendation');
        assert.strictEqual(recommendation.status, 'pending');

        const events2 = [];
        for await (const ev of agent.chatStream(userId, recommendation.suggestedPrompt!)) {
            events2.push(ev);
        }
        const sendCallsResult = events2.find(e => e.type === 'tool_result' && e.toolName === 'sepolia_send_calls') as any;
        assert.ok(sendCallsResult);
        assert.strictEqual(sendCallsResult.approvalUrl, 'https://mock.base.org/approve/sepolia');
        assert.strictEqual(sendCallsResult.requestId, 'sepolia-req');

    } finally {
        global.fetch = originalFetch;
        MemoryService.getUserSettings = originalGetUserSettings;
        await db.delete(actions).where(eq(actions.userId, userId));
    }
});

test('Clean up DB connection', async () => {
    const { client } = await import('@mioagent/db');
    await client.end();
});
