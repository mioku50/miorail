import test from 'node:test';
import assert from 'node:assert';
import { Agent } from './index.js';
import { MockLlmProvider, LlmRequest } from '@mioagent/llm';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';


test('Integration: Agent uses MockLlm + MockMcp + mock-chain', async () => {
  const llm = new MockLlmProvider((req: LlmRequest) => {
    if (req.messages.length <= 2) {
      return 'TOOL:send_calls|{"chain":"base","calls":[{"to":"0x123"}]}';
    }
    return 'Transaction simulated via mock chain';
  });

  const tools = new ToolAggregator();

  class IntegratedMcpProvider implements ToolProvider {
    id = 'integrated-mcp';
    // We mock the client/transport fully to avoid actual MCP protocol timeouts
    // when using the MockMcpTransport without a proper server sending initialized messages back

    constructor() {}

    async start() {}

    async close() {}

    async listTools(): Promise<ToolDef[]> {
      return [{ name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } }];
    }

    findTool(name: string) {
      return name === 'send_calls' ? { name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } } : undefined;
    }

    async callTool(_name: string, _args: Record<string, unknown>) {
      // Simulate the MCP transport call resolving into a mock chain response
      // with approvalUrl and requestId representing EIP-5792 send_calls response.
      return { content: JSON.stringify({ approvalUrl: 'https://mock.chain.org/approve/999', requestId: '999' }), isError: false };
    }
  }

  const mcpProvider = new IntegratedMcpProvider();
  await mcpProvider.start();
  tools.registerProvider(mcpProvider);

  const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

  const events = [];

  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;

  try {
    for await (const ev of agent.chatStream('test-user', 'Execute send_calls to mock-chain')) {
      events.push(ev);
    }

    const toolResultEvent = events.find(e => e.type === 'tool_result') as { type: 'tool_result'; approvalUrl?: string; requestId?: string } | undefined;
    assert.ok(toolResultEvent);
    assert.strictEqual(toolResultEvent.approvalUrl, 'https://mock.chain.org/approve/999');
    assert.strictEqual(toolResultEvent.requestId, '999');

    const finalMessage = events.find(e => e.type === 'message' && e.content === 'Transaction simulated via mock chain');
    assert.ok(finalMessage);

  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { client } = await import('@mioagent/db');
    await client.end();
    await mcpProvider.close();
  }
});
