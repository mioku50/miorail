import { test } from 'node:test';
import * as assert from 'node:assert';
import { ToolAggregator } from '../src/aggregator.js';
import { ToolProvider, ToolDef } from '../src/provider.js';

class MockProvider implements ToolProvider {
  id = 'mock-provider';
  tools: ToolDef[] = [
    { name: 'mock-tool', description: 'mock desc', inputSchema: {} }
  ];

  async listTools() { return this.tools; }
  findTool(name: string) { return this.tools.find(t => t.name === name); }
  async callTool(name: string, _args: Record<string, unknown>) {
    if (name === 'mock-tool') return { content: 'mock success', isError: false };
    throw new Error('Not found');
  }
}

test('ToolAggregator registers providers and lists tools', async () => {
  const aggregator = new ToolAggregator();
  const provider = new MockProvider();
  aggregator.registerProvider(provider);

  const tools = await aggregator.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'mock-tool');
});

test('ToolAggregator finds tool by name', () => {
  const aggregator = new ToolAggregator();
  const provider = new MockProvider();
  aggregator.registerProvider(provider);

  const tool = aggregator.findTool('mock-tool');
  assert.ok(tool);
  assert.strictEqual(tool?.name, 'mock-tool');
});

test('ToolAggregator calls tool', async () => {
  const aggregator = new ToolAggregator();
  const provider = new MockProvider();
  aggregator.registerProvider(provider);

  const result = await aggregator.callTool('mock-tool', {});
  assert.strictEqual(result.content, 'mock success');
  assert.strictEqual(result.isError, false);
});

test('ToolAggregator throws on unknown tool call', async () => {
  const aggregator = new ToolAggregator();
  await assert.rejects(
    async () => { await aggregator.callTool('unknown', {}); },
    /Tool 'unknown' not found/
  );
});

test('a bound request signal stops hung tools and prevents later calls', async () => {
  const aggregator = new ToolAggregator();
  const controller = new AbortController();
  aggregator.setAbortSignal(controller.signal);
  const provider = new MockProvider();
  let seen: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  provider.callTool = async (_name, _args, context?: { signal?: AbortSignal }) => {
    calls++;
    seen = context?.signal;
    started();
    return new Promise<never>(() => {});
  };
  aggregator.registerProvider(provider);
  const pending = aggregator.callTool('mock-tool', {});
  await ready;
  controller.abort(new Error('unit request left'));
  await assert.rejects(pending, /unit request left/);
  assert.strictEqual(seen, controller.signal);
  await assert.rejects(aggregator.callTool('mock-tool', {}), /unit request left/);
  assert.strictEqual(calls, 1);
});
