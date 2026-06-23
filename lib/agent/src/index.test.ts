import test from 'node:test';
import assert from 'node:assert';
import { Agent } from './index.js';
import { MockLlmProvider, LlmRequest } from '@mioagent/llm';
import { ToolAggregator, ToolProvider, ToolDef } from '@mioagent/tools';
import { db, userSettings } from '@mioagent/db';

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
    const { client } = await import('@mioagent/db');
    await client.end();
  }
});
