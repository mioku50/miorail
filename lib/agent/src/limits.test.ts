import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryService } from '@mioagent/memory';
import type { LlmProvider, LlmResponse } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';
import { Agent, AgentRunLimitErrorV1 } from './index.js';

const call = (id: number) => ({ id: String(id), type: 'function' as const,
  function: { name: 'get_fixture', arguments: '{}' } });
const toolResponse = (count = 1): LlmResponse => ({ message: {
  role: 'assistant', content: '', tool_calls: Array.from({ length: count }, (_, index) => call(index)),
} });
async function consume(agent: Agent) {
  for await (const event of agent.chatStream('unit-fixture', 'read')) { assert.ok(event.type); }
}
function tools(read: () => Promise<{ content: string; isError: boolean }>) {
  const tools = new ToolAggregator();
  const tool = { name: 'get_fixture', description: 'Local fixture read', inputSchema: {} };
  tools.registerProvider({ id: 'fixture', listTools: async () => [tool],
    findTool: name => name === tool.name ? tool : undefined, callTool: read });
  return tools;
}

test('an endless tool loop makes at most eight LLM turns', async (t) => {
  t.mock.method(MemoryService, 'getUserSettings', async () => null);
  let generated = 0;
  let reads = 0;
  const llm: LlmProvider = { generate: async () => { generated++; return toolResponse(); } };
  await assert.rejects(consume(new Agent({ llmProvider: llm, toolAggregator: tools(async () => {
    reads++; return { content: '{}', isError: false };
  }) })), error => error instanceof AgentRunLimitErrorV1 && error.code === 'agent_turn_limit');
  assert.equal(generated, 8);
  assert.equal(reads, 8);
});

test('the eighth turn may finish normally, without a ninth paid generation', async (t) => {
  t.mock.method(MemoryService, 'getUserSettings', async () => null);
  let generated = 0;
  await consume(new Agent({ llmProvider: { generate: async () => ++generated < 8
    ? toolResponse() : { message: { role: 'assistant', content: 'done' } } },
    toolAggregator: tools(async () => ({ content: '{}', isError: false })) }));
  assert.equal(generated, 8);
});

test('one response cannot evade the limit by returning hundreds of tool calls', async (t) => {
  t.mock.method(MemoryService, 'getUserSettings', async () => null);
  let reads = 0;
  await assert.rejects(consume(new Agent({ llmProvider: { generate: async () => toolResponse(100) },
    toolAggregator: tools(async () => { reads++; return { content: '{}', isError: false }; }),
  })), error => error instanceof AgentRunLimitErrorV1 && error.code === 'agent_tool_limit');
  assert.equal(reads, 32);
});

test('cancelling a hung tool never becomes a tool error or another LLM turn', async (t) => {
  t.mock.method(MemoryService, 'getUserSettings', async () => null);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let generated = 0;
  const agent = new Agent({ signal: controller.signal,
    llmProvider: { generate: async () => { generated++; return toolResponse(); } },
    toolAggregator: tools(async () => { started(); return new Promise<never>(() => {}); }),
  });
  const run = consume(agent);
  await ready;
  const reason = new Error('unit disconnect');
  controller.abort(reason);
  await assert.rejects(run, error => error === reason);
  assert.equal(generated, 1);
});

test('cancellation cannot be swallowed by tool-result screening', async (t) => {
  t.mock.method(MemoryService, 'getUserSettings', async () => null);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let generated = 0;
  const run = consume(new Agent({ signal: controller.signal,
    llmProvider: { generate: async () => { generated++; return toolResponse(); } },
    toolAggregator: tools(async () => ({ content: '{}', isError: false })),
    toolResultGuard: async () => { started(); return new Promise<never>(() => {}); },
  }));
  await ready;
  controller.abort(new Error('unit disconnect'));
  await assert.rejects(run, /unit disconnect/);
  assert.equal(generated, 1);
});
