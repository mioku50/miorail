import test from 'node:test';
import assert from 'node:assert';
import { Agent } from './index.js';
import { MockLlmProvider, LlmRequest } from '@mioagent/llm';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';

class DummyToolProvider implements ToolProvider {
  id = 'dummy';
  async listTools(): Promise<ToolDef[]> {
    return [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object' } }];
  }
  findTool(name: string) {
    return name === 'get_weather' ? { name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object' } } : undefined;
  }
  async callTool(_name: string, _args: Record<string, unknown>) {
    return { content: 'Sunny', isError: false };
  }
}

test('Agent loop runs correctly', async () => {
  const llm = new MockLlmProvider((req: LlmRequest) => {
      if (req.messages.length <= 2) {
        return 'TOOL:get_weather|{}';
      }
      return 'The weather is Sunny';
  });

  const tools = new ToolAggregator();
  tools.registerProvider(new DummyToolProvider());

  const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

  const events = [];
  // Clean DB settings for test
  // we do not need to call the database locally in tests if possible
  // await db.delete(userSettings);

  // mock getUserSettings so we don't connect to db
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;

  try {
    for await (const ev of agent.chatStream('test-user', 'What is the weather?')) {
      events.push(ev);
    }

    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, 'tool_call');
    assert.strictEqual(events[1].type, 'tool_result');
    assert.strictEqual(events[2].type, 'message');
    assert.strictEqual((events[2] as { content?: string }).content, 'The weather is Sunny');
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;

    // Explicitly disconnect from the database to unblock test exit
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});

test('Agent loop extracts approvalUrl and requestId from tool results', async () => {
  const llm = new MockLlmProvider((req: LlmRequest) => {
    if (req.messages.length <= 2) {
      return 'TOOL:send_calls|{"chain":"base","calls":[{"to":"0x123"}]}';
    }
    return 'Transaction approved';
  });

  const tools = new ToolAggregator();
  class DummyMcpProvider implements ToolProvider {
    id = 'mock-mcp';
    async listTools(): Promise<ToolDef[]> {
      return [{ name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } }];
    }
    findTool(name: string) {
      return name === 'send_calls' ? { name: 'send_calls', description: 'Sends calls', inputSchema: { type: 'object' } } : undefined;
    }
    async callTool(_name: string, _args: Record<string, unknown>) {
      return { content: JSON.stringify({ approvalUrl: 'https://mock.base.org/approve/123', requestId: '123' }), isError: false };
    }
  }
  tools.registerProvider(new DummyMcpProvider());

  const agent = new Agent({ llmProvider: llm, toolAggregator: tools });

  const events = [];
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;

  try {
    for await (const ev of agent.chatStream('test-user', 'Send 1 ETH to 0x123')) {
      events.push(ev);
    }

    const toolResultEvent = events.find(e => e.type === 'tool_result') as { type: 'tool_result'; approvalUrl?: string; requestId?: string } | undefined;
    assert.ok(toolResultEvent);
    assert.strictEqual(toolResultEvent.approvalUrl, 'https://mock.base.org/approve/123');
    assert.strictEqual(toolResultEvent.requestId, '123');
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});
