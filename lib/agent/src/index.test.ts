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

test('Agent prompt receives user-scoped Base inventory and read-only Base runtime context', async () => {
  let systemPrompt = '';
  let exposedTools: string[] = [];
  const llm = new MockLlmProvider((req: LlmRequest) => {
    systemPrompt = req.messages[0].content;
    exposedTools = (req.tools || []).map((tool) => tool.function.name);
    return 'Ready for read-only wallet questions.';
  });
  const tools = new ToolAggregator();
  class BaseReadProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    async listTools(): Promise<ToolDef[]> {
      return [
        { name: 'get_portfolio', description: 'Read portfolio', inputSchema: { type: 'object' } },
        { name: 'send', description: 'Send token', inputSchema: { type: 'object' } },
        { name: 'swap', description: 'Swap token', inputSchema: { type: 'object' } },
        { name: 'sign', description: 'Sign payload', inputSchema: { type: 'object' } },
      ];
    }
    findTool() { return undefined; }
    async callTool() { return { content: '{}', isError: false }; }
  }
  tools.registerProvider(new BaseReadProvider());
  const agent = new Agent({
    llmProvider: llm,
    toolAggregator: tools,
    runtimeContext: {
      walletAddress: '0x1111111111111111111111111111111111111111',
      chain: 'base',
      chainId: 8453,
      executionMode: 'read-only',
    },
  });
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;
  try {
    for await (const event of agent.chatStream('test-user', 'what can you read?')) { void event; }
    assert.match(systemPrompt, /chain=base, chainId=8453, executionMode=read-only/);
    assert.match(systemPrompt, /Enabled Base MCP read tools: get_portfolio/);
    assert.match(systemPrompt, /before claiming.*unavailable/i);
    assert.match(systemPrompt, /Never claim you read or loaded plugin instructions/i);
    assert.deepEqual(exposedTools, ['get_portfolio']);
    assert.doesNotMatch(systemPrompt, /private key value/i);
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});

test('read-only Agent without an explicit provider cannot call partner tools', async () => {
  const calls: string[] = [];
  let exposedTools: string[] = [];
  const llm = new MockLlmProvider((req: LlmRequest) => {
    exposedTools = (req.tools || []).map((tool) => tool.function.name);
    if (req.messages.length <= 2) return 'TOOL:morpho_query_markets|{"chain":"base"}';
    return 'A provider must be specified.';
  });
  const tools = new ToolAggregator();
  class MixedReadProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    async listTools(): Promise<ToolDef[]> {
      return [
        { name: 'get_portfolio', description: 'Portfolio', inputSchema: { type: 'object' } },
        { name: 'morpho_query_markets', description: 'Morpho markets', inputSchema: { type: 'object' } },
      ];
    }
    findTool(name: string) { return { name, description: name, inputSchema: { type: 'object' } }; }
    async callTool(name: string) { calls.push(name); return { content: '{}', isError: false }; }
  }
  tools.registerProvider(new MixedReadProvider());
  const agent = new Agent({
    llmProvider: llm,
    toolAggregator: tools,
    runtimeContext: { chain: 'base', chainId: 8453, executionMode: 'read-only' },
  });
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;
  try {
    const events = [];
    for await (const event of agent.chatStream('test-user', 'Show available USDC supply markets on Base')) events.push(event);
    assert.deepEqual(exposedTools, ['get_portfolio']);
    assert.deepEqual(calls, []);
    const blocked = events.find((event) => event.type === 'tool_result') as any;
    assert.match(blocked?.result || '', /tool_not_available_in_runtime/);
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});

test('LLM tool list never contains send_calls, swap, moonwell_prepare_* or web_request', async () => {
  let exposedTools: string[] = [];
  const makeLlm = () => new MockLlmProvider((req: LlmRequest) => {
    exposedTools = (req.tools || []).map((tool) => tool.function.name);
    return 'Read-only inventory acknowledged.';
  });
  const tools = new ToolAggregator();
  class WriteHeavyProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    async listTools(): Promise<ToolDef[]> {
      return [
        { name: 'get_portfolio', description: 'Read portfolio', inputSchema: { type: 'object' } },
        { name: 'send_calls', description: 'Send batched calls', inputSchema: { type: 'object' } },
        { name: 'swap', description: 'Swap tokens', inputSchema: { type: 'object' } },
        { name: 'moonwell_get_markets', description: 'Moonwell markets', inputSchema: { type: 'object' } },
        { name: 'moonwell_prepare_supply', description: 'Prepare supply', inputSchema: { type: 'object' } },
        { name: 'moonwell_prepare_borrow', description: 'Prepare borrow', inputSchema: { type: 'object' } },
        { name: 'web_request', description: 'Arbitrary HTTP request', inputSchema: { type: 'object' } },
      ];
    }
    findTool() { return undefined; }
    async callTool() { return { content: '{}', isError: false }; }
  }
  tools.registerProvider(new WriteHeavyProvider());
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;
  try {
    // Unscoped user-confirmed runtime: reads only.
    const agent = new Agent({
      llmProvider: makeLlm(),
      toolAggregator: tools,
      runtimeContext: { chain: 'base', chainId: 8453, executionMode: 'user-confirmed' },
    });
    for await (const event of agent.chatStream('test-user', 'what can you read?')) { void event; }
    assert.ok(exposedTools.includes('get_portfolio'));
    assert.ok(exposedTools.includes('moonwell_get_markets'));
    for (const forbidden of ['send_calls', 'swap', 'moonwell_prepare_supply', 'moonwell_prepare_borrow', 'web_request']) {
      assert.strictEqual(exposedTools.includes(forbidden), false, `${forbidden} must never reach the LLM`);
    }

    // Moonwell-scoped runtime: only the moonwell read survives.
    const scoped = new Agent({
      llmProvider: makeLlm(),
      toolAggregator: tools,
      runtimeContext: { chain: 'base', chainId: 8453, executionMode: 'user-confirmed', providerNamespace: 'moonwell' },
    });
    for await (const event of scoped.chatStream('test-user', 'what moonwell data can you read?')) { void event; }
    assert.deepStrictEqual(exposedTools, ['moonwell_get_markets']);

    // Read-only runtime keeps the same invariant.
    const readOnly = new Agent({
      llmProvider: makeLlm(),
      toolAggregator: tools,
      runtimeContext: { chain: 'base', chainId: 8453, executionMode: 'read-only' },
    });
    for await (const event of readOnly.chatStream('test-user', 'what can you read?')) { void event; }
    for (const forbidden of ['send_calls', 'swap', 'moonwell_prepare_supply', 'moonwell_prepare_borrow', 'web_request']) {
      assert.strictEqual(exposedTools.includes(forbidden), false, `${forbidden} must never reach the LLM in read-only mode`);
    }
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});

test('Agent provider scope exposes only matching tools and blocks a cross-provider hallucination', async () => {
  let exposedTools: string[] = [];
  let systemPrompt = '';
  const calls: string[] = [];
  const llm = new MockLlmProvider((req: LlmRequest) => {
    systemPrompt = req.messages[0].content;
    exposedTools = (req.tools || []).map((tool) => tool.function.name);
    if (req.messages.length <= 2) return 'TOOL:morpho_query_vaults|{"chain":"base"}';
    return 'Moonwell data is unavailable.';
  });
  const tools = new ToolAggregator();
  class PartnerProvider implements ToolProvider {
    id = 'base-mcp-dynamic';
    async listTools(): Promise<ToolDef[]> {
      return [
        { name: 'moonwell_get_markets', description: 'Moonwell markets', inputSchema: { type: 'object' } },
        { name: 'morpho_query_vaults', description: 'Morpho vaults', inputSchema: { type: 'object' } },
      ];
    }
    findTool(name: string) { return (name === 'moonwell_get_markets' || name === 'morpho_query_vaults')
      ? { name, description: name, inputSchema: { type: 'object' } }
      : undefined; }
    async callTool(name: string) { calls.push(name); return { content: '{}', isError: false }; }
  }
  tools.registerProvider(new PartnerProvider());
  const agent = new Agent({
    llmProvider: llm,
    toolAggregator: tools,
    runtimeContext: {
      chain: 'base',
      chainId: 8453,
      executionMode: 'read-only',
      providerNamespace: 'moonwell',
      skillNamespace: 'moonwell',
      skillInstructions: ['Use only Moonwell tools.', 'Supply markets are read-only.'],
      skillLoaded: true,
    },
  });
  const { MemoryService } = await import('@mioagent/memory');
  const originalGetUserSettings = MemoryService.getUserSettings;
  MemoryService.getUserSettings = async () => null;
  try {
    const events = [];
    for await (const event of agent.chatStream('test-user', 'Show Moonwell markets')) events.push(event);
    assert.deepEqual(exposedTools, ['moonwell_get_markets']);
    assert.deepEqual(calls, []);
    assert.match(systemPrompt, /Runtime skill moonwell is loaded from the packaged registry/);
    assert.doesNotMatch(systemPrompt, /Never claim you read or loaded plugin instructions/);
    const blocked = events.find((event) => event.type === 'tool_result') as any;
    assert.equal(blocked?.isError, true);
    assert.match(blocked?.result || '', /provider_tool_scope_violation/);
  } finally {
    MemoryService.getUserSettings = originalGetUserSettings;
    const { closeDb } = await import('@mioagent/db');
    await closeDb();
  }
});
