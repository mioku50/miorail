import assert from 'node:assert/strict';
import test, { describe, afterEach } from 'node:test';
import type { Request } from 'express';

import {
  baseMcpConsoleArgsV1,
  baseMcpConsoleResultTextV1,
  baseMcpConsoleRuntimeV1,
  runBaseMcpConsoleV1,
} from './baseMcpConsole.js';

type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; toolName: string; args: string }
  | { type: 'tool_result'; toolName: string; result: string; isError: boolean };

const original = {
  createApiToolAggregatorForUser: baseMcpConsoleRuntimeV1.createApiToolAggregatorForUser,
  createLlmProvider: baseMcpConsoleRuntimeV1.createLlmProvider,
  createAgent: baseMcpConsoleRuntimeV1.createAgent,
};

afterEach(() => {
  Object.assign(baseMcpConsoleRuntimeV1, original);
});

/** A fake aggregator that reports whatever inventory a test wants. */
function fakeAggregator(inventory: { providerId: string; tools: { name: string }[] }[]) {
  let closed = false;
  const aggregator = {
    listProviderTools: async () => inventory,
    close: async () => {
      closed = true;
    },
  };
  return { aggregator, wasClosed: () => closed };
}

function stubTools(
  inventory: { providerId: string; tools: { name: string }[] }[],
  capture?: (options: Record<string, unknown>) => void,
) {
  const { aggregator, wasClosed } = fakeAggregator(inventory);
  baseMcpConsoleRuntimeV1.createApiToolAggregatorForUser = (async (
    _req: unknown,
    _userId: unknown,
    _secret: unknown,
    options: Record<string, unknown>,
  ) => {
    capture?.(options);
    return aggregator;
  }) as unknown as typeof baseMcpConsoleRuntimeV1.createApiToolAggregatorForUser;
  return { wasClosed };
}

function stubAgent(events: AgentEvent[], capture?: (config: Record<string, unknown>) => void) {
  baseMcpConsoleRuntimeV1.createLlmProvider = (() => ({})) as typeof baseMcpConsoleRuntimeV1.createLlmProvider;
  baseMcpConsoleRuntimeV1.createAgent = ((config: Record<string, unknown>) => {
    capture?.(config);
    return {
      async *chatStream() {
        for (const event of events) yield event;
      },
    };
  }) as unknown as typeof baseMcpConsoleRuntimeV1.createAgent;
}

const req = {} as Request;
const ask = (message = 'what can you read?') =>
  runBaseMcpConsoleV1({ req, userId: 'u1', sessionSecret: 's', message, enabled: true });

const BASE_MCP_INVENTORY = [{ providerId: 'base-mcp-dynamic', tools: [{ name: 'get_portfolio' }] }];

describe('the console is Base MCP and nothing else', () => {
  test('it asks the factory for a Base-MCP-only aggregator', async () => {
    // The separation has to be structural. Passing readOnlyOnly plus three
    // `include: false` flags would work today and break the first time someone
    // adds a provider to the factory — the new one would silently join a
    // surface whose whole promise is that it contains no such thing.
    let options: Record<string, unknown> = {};
    stubTools(BASE_MCP_INVENTORY, (captured) => {
      options = captured;
    });
    stubAgent([{ type: 'message', content: 'ok' }]);
    await ask();
    assert.equal(options.baseMcpOnly, true);
  });

  test('a non-Base-MCP provider in the inventory refuses the whole request', async () => {
    // Second line of defence, and it fails closed: the console does not run a
    // degraded version of itself with a Uniswap tool quietly in scope.
    stubTools([
      ...BASE_MCP_INVENTORY,
      { providerId: 'uniswap-quote', tools: [{ name: 'uniswap_quote' }] },
    ]);
    stubAgent([{ type: 'message', content: 'should never be produced' }]);
    const result = await ask();
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'non_base_mcp_provider_registered');
    assert.equal(result.reply, null);
  });

  test('the runtime is read-only whatever the deployment allows', async () => {
    let config: Record<string, unknown> = {};
    stubTools(BASE_MCP_INVENTORY);
    stubAgent([{ type: 'message', content: 'ok' }], (captured) => {
      config = captured;
    });
    await ask();
    const runtime = config.runtimeContext as { executionMode?: string };
    assert.equal(runtime.executionMode, 'read-only');
  });

  test('the model is told it has no Miorail route intelligence here', async () => {
    let config: Record<string, unknown> = {};
    stubTools(BASE_MCP_INVENTORY);
    stubAgent([{ type: 'message', content: 'ok' }], (captured) => {
      config = captured;
    });
    await ask();
    const extra = (config.systemPromptExtra as string[]).join(' ');
    assert.match(extra, /no access to Miorail route intelligence/i);
    assert.match(extra, /Route Card/);
  });
});

describe('no tools means no answer, not an answer from memory', () => {
  test('an empty Base MCP inventory never reaches the model', async () => {
    // The failure this prevents: a broken connection producing a confident
    // paragraph about Base that no tool supplied. "Base MCP returned nothing"
    // and "here is what I recall" are different claims.
    let agentCreated = false;
    stubTools([{ providerId: 'base-mcp-dynamic', tools: [] }]);
    baseMcpConsoleRuntimeV1.createLlmProvider = (() => ({})) as typeof baseMcpConsoleRuntimeV1.createLlmProvider;
    baseMcpConsoleRuntimeV1.createAgent = (() => {
      agentCreated = true;
      throw new Error('the model must not be called');
    }) as unknown as typeof baseMcpConsoleRuntimeV1.createAgent;

    const result = await ask();
    assert.equal(result.status, 'no_tools');
    assert.equal(result.errorCode, 'no_base_mcp_tools');
    assert.equal(result.reply, null);
    assert.equal(agentCreated, false);
  });

  test('Base MCP switched off is its own status', async () => {
    const result = await runBaseMcpConsoleV1({
      req,
      userId: 'u1',
      sessionSecret: 's',
      message: 'hello',
      enabled: false,
    });
    assert.equal(result.status, 'disabled');
  });

  test('an empty question is refused before anything is spent', async () => {
    const result = await runBaseMcpConsoleV1({
      req,
      userId: 'u1',
      sessionSecret: 's',
      message: '   ',
      enabled: true,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'empty_message');
  });
});

describe('the trace is the answer, and it is bounded', () => {
  test('each call carries its arguments, its result and its outcome', async () => {
    stubTools(BASE_MCP_INVENTORY);
    stubAgent([
      { type: 'tool_call', toolName: 'get_portfolio', args: '{"address":"0xabc"}' },
      { type: 'tool_result', toolName: 'get_portfolio', result: '{"usd":"12.00"}', isError: false },
      { type: 'message', content: 'You hold $12.' },
    ]);
    const result = await ask();
    assert.equal(result.status, 'answered');
    assert.equal(result.reply, 'You hold $12.');
    assert.equal(result.trace.length, 1);
    assert.deepEqual(result.trace[0], {
      tool: 'get_portfolio',
      args: '{"address":"0xabc"}',
      ok: true,
      result: '{"usd":"12.00"}',
      errorCode: null,
    });
  });

  test('a failed call keeps its typed reason instead of the raw message', async () => {
    stubTools(BASE_MCP_INVENTORY);
    stubAgent([
      { type: 'tool_call', toolName: 'get_portfolio', args: '{}' },
      {
        type: 'tool_result',
        toolName: 'get_portfolio',
        result: '{"errorCode":"base_mcp_timeout"}',
        isError: true,
      },
    ]);
    const result = await ask();
    assert.equal(result.trace[0]!.ok, false);
    assert.equal(result.trace[0]!.errorCode, 'base_mcp_timeout');
  });

  test('a looping model stops at the budget and says the answer is unfinished', async () => {
    const events: AgentEvent[] = [];
    for (let index = 0; index < 20; index += 1) {
      events.push({ type: 'tool_call', toolName: `t${index}`, args: '{}' });
      events.push({ type: 'tool_result', toolName: `t${index}`, result: '{}', isError: false });
    }
    stubTools(BASE_MCP_INVENTORY);
    stubAgent(events);
    const result = await ask();
    assert.equal(result.trace.length, 8);
    assert.equal(result.truncated, true);
  });

  test('the aggregator is closed even when the model throws', async () => {
    // Each console call opens an authenticated session to somebody else's
    // server. Leaking one per question is how a surface becomes a rate limit.
    const { wasClosed } = stubTools(BASE_MCP_INVENTORY);
    baseMcpConsoleRuntimeV1.createLlmProvider = (() => ({})) as typeof baseMcpConsoleRuntimeV1.createLlmProvider;
    baseMcpConsoleRuntimeV1.createAgent = (() => ({
      async *chatStream() {
        throw new Error('llm exploded');
      },
    })) as unknown as typeof baseMcpConsoleRuntimeV1.createAgent;

    const result = await ask();
    assert.equal(result.status, 'failed');
    assert.equal(wasClosed(), true);
  });

  test('an expired session is reported as needing reauth, not as a generic failure', async () => {
    stubTools(BASE_MCP_INVENTORY);
    baseMcpConsoleRuntimeV1.createLlmProvider = (() => ({})) as typeof baseMcpConsoleRuntimeV1.createLlmProvider;
    baseMcpConsoleRuntimeV1.createAgent = (() => ({
      async *chatStream() {
        throw new Error('401 unauthorized from the endpoint');
      },
    })) as unknown as typeof baseMcpConsoleRuntimeV1.createAgent;

    const result = await ask();
    assert.equal(result.status, 'needs_reauth');
    assert.equal(result.errorCode, 'needs_reauth');
  });

  test('a thrown message never reaches the caller', async () => {
    stubTools(BASE_MCP_INVENTORY);
    baseMcpConsoleRuntimeV1.createLlmProvider = (() => ({})) as typeof baseMcpConsoleRuntimeV1.createLlmProvider;
    baseMcpConsoleRuntimeV1.createAgent = (() => ({
      async *chatStream() {
        throw new Error('connect ECONNREFUSED https://mcp.base.org?token=sk-live-secret');
      },
    })) as unknown as typeof baseMcpConsoleRuntimeV1.createAgent;

    const result = await ask();
    assert.doesNotMatch(JSON.stringify(result), /sk-live-secret|mcp\.base\.org/);
  });
});

describe('what a trace is allowed to show', () => {
  test('a private-key-shaped argument is redacted', () => {
    const shown = baseMcpConsoleArgsV1('{"privateKey":"0xdeadbeef","address":"0xabc"}');
    assert.doesNotMatch(shown, /deadbeef/);
    assert.match(shown, /0xabc/);
  });

  test('unparseable arguments become an empty object, never raw bytes', () => {
    assert.equal(baseMcpConsoleArgsV1('not json at all'), '{}');
  });

  test('a bearer token in a result is redacted on the way to the screen', () => {
    // The provider already redacts on the way out. This is the second pass,
    // because a trace is a thing people screenshot.
    const shown = baseMcpConsoleResultTextV1('{"h":"Bearer sk-live-abc123"}');
    assert.doesNotMatch(shown, /sk-live-abc123/);
    assert.match(shown, /\[redacted\]/);
  });

  test('a very long result is capped rather than pasted whole', () => {
    const shown = baseMcpConsoleResultTextV1('x'.repeat(5000));
    assert.ok(shown.length <= 1201, `capped, got ${shown.length}`);
  });
});
