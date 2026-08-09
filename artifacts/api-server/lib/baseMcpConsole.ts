import type { Request } from 'express';
import { Agent } from '@mioagent/agent';
import { createLlmProvider } from '@mioagent/llm';
import { createApiToolAggregatorForUser } from './baseMcpTools.js';
import { sanitizeStreamToolArgs, sanitizedToolErrorCode } from './streamReadRouting.js';

// ---------------------------------------------------------------------------
// The Base MCP console: other people's tools, in their own room.
//
// Until now the AI reached Base MCP from the same thread that reaches
// Miorail's own providers. That is the part worth fixing, and it is not
// cosmetic. A Miorail route carries a Route Card: measured, quote-aligned,
// with a rejection reason when it fails. A Base MCP plugin carries whatever a
// third party returned. Both spoke in one window, in one voice, and a reader
// had no way to tell which guarantee they were being offered.
//
// So this surface is defined by what it CANNOT do:
//
//   * `baseMcpOnly` in the tool factory. Not "we passed the right flags" —
//     one switch that suppresses every non-Base-MCP provider, including ones
//     nobody has written yet. Miorail's routers are not reachable from here,
//     so an answer from here cannot borrow their authority.
//   * Read-only, always. `baseMcpOnly` implies it. No swap, no send, no
//     approval URL, no clearance, no Entry Plan, nothing that reaches a
//     wallet. Transactions still belong to the one path that has always
//     owned them.
//   * No tools, no model. If Base MCP returned nothing callable, this refuses
//     to run rather than letting an LLM answer questions about Base from
//     memory. A console with no Base MCP in it is not a chatbot, and the
//     difference matters most exactly when the connection is broken.
//
// The trace is the product, not a debug view. Every tool call is shown with
// its arguments and what came back, because "which third party said this"
// is the question this whole separation exists to answer.
// ---------------------------------------------------------------------------

/** Bounded so a looping model cannot spend the user's Base MCP quota. */
const MAX_TOOL_CALLS_V1 = 8;
const MAX_MESSAGE_LENGTH_V1 = 2000;
const MAX_ARGS_CHARS_V1 = 600;
const MAX_RESULT_CHARS_V1 = 1200;
const MAX_REPLY_CHARS_V1 = 8000;

export type BaseMcpConsoleStatusV1 =
  | 'answered'
  | 'no_tools'
  | 'needs_reauth'
  | 'disabled'
  | 'failed';

export interface BaseMcpConsoleTraceEntryV1 {
  tool: string;
  /** Sanitized JSON of what the model passed. */
  args: string;
  ok: boolean;
  /** Sanitized preview of what the tool returned. */
  result: string;
  errorCode: string | null;
}

export interface BaseMcpConsoleResultV1 {
  status: BaseMcpConsoleStatusV1;
  reply: string | null;
  trace: BaseMcpConsoleTraceEntryV1[];
  /** Base MCP read tools this console could offer the model. */
  toolsAvailable: number;
  /** The tool budget ran out before the model finished. */
  truncated: boolean;
  errorCode: string | null;
  checkedAt: string;
}

export const baseMcpConsoleRuntimeV1 = {
  createApiToolAggregatorForUser,
  createLlmProvider,
  createAgent: (config: ConstructorParameters<typeof Agent>[0]) => new Agent(config),
};

/** Lines that state the boundary to the model in the same terms the card
 * states it to the reader. The structural guarantees above do the enforcing;
 * these stop the model from *claiming* what it cannot do. */
const CONSOLE_PROMPT_V1 = [
  'You are the Miorail Base MCP console. Your entire tool inventory is Base MCP, reached with the user’s own Base Account.',
  'You have no access to Miorail route intelligence here: no Route Card, no measured exit capacity, no verified router, no B20 data. Never present a Base MCP answer as a Miorail route or as verified by Miorail.',
  'Every tool here is read-only. If the user asks to swap, send, approve or sign, say that this console cannot, and that those live in the Routes flow.',
  'Attribute what you report to the tool that returned it. If no tool returned it, say you do not know rather than answering from memory.',
];

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Arguments as the trace shows them: private-key-shaped keys redacted, control
 * characters stripped, bounded. */
export function baseMcpConsoleArgsV1(raw: string): string {
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    // A model that emitted invalid JSON told us something worth showing, but
    // not its raw bytes.
    return '{}';
  }
  return truncate(JSON.stringify(sanitizeStreamToolArgs(parsed)), MAX_ARGS_CHARS_V1);
}

/**
 * A tool result as the trace shows it.
 *
 * The provider already redacts tokens and calldata on the way out of
 * `DynamicBaseMcpToolProvider`; this is the second pass, because a trace is a
 * thing users screenshot.
 */
export function baseMcpConsoleResultTextV1(raw: string): string {
  const stripped = [...(raw ?? '')]
    .map((char) => (char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char))
    .join('')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(stripped, MAX_RESULT_CHARS_V1);
}

function unavailable(
  status: BaseMcpConsoleStatusV1,
  errorCode: string,
  toolsAvailable = 0,
): BaseMcpConsoleResultV1 {
  return {
    status,
    reply: null,
    trace: [],
    toolsAvailable,
    truncated: false,
    errorCode,
    checkedAt: new Date().toISOString(),
  };
}

export async function runBaseMcpConsoleV1(input: {
  req: Request;
  userId: string;
  sessionSecret: string;
  walletAddress?: string;
  message: string;
  enabled: boolean;
}): Promise<BaseMcpConsoleResultV1> {
  if (!input.enabled) return unavailable('disabled', 'base_mcp_disabled');

  const message = input.message.trim().slice(0, MAX_MESSAGE_LENGTH_V1);
  if (!message) return unavailable('failed', 'empty_message');

  // Inside the guard, not before it. Building the aggregator refreshes OAuth
  // and opens a session to somebody else's server; a throw there used to
  // escape to the route and become an HTTP 500, which the surface can only
  // render as "could not reach the server" — the least informative thing that
  // is ever true.
  let tools: Awaited<ReturnType<typeof createApiToolAggregatorForUser>>;
  try {
    tools = await baseMcpConsoleRuntimeV1.createApiToolAggregatorForUser(
      input.req,
      input.userId,
      input.sessionSecret,
      { baseMcpOnly: true },
    );
  } catch (error) {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
    return /401|403|unauthor|invalid_grant|reauth|credential|decrypt/i.test(text)
      ? unavailable('needs_reauth', 'needs_reauth')
      : unavailable('failed', 'base_mcp_connect_failed');
  }

  try {
    const inventory = await tools.listProviderTools();
    // Belt and braces on top of `baseMcpOnly`: if a provider that is not Base
    // MCP ever reached this aggregator, the console refuses rather than
    // quietly becoming the mixed thread it was built to replace.
    const foreign = inventory.filter((entry) => !entry.providerId.startsWith('base-mcp'));
    if (foreign.length > 0) return unavailable('failed', 'non_base_mcp_provider_registered');

    const toolsAvailable = inventory.reduce((total, entry) => total + entry.tools.length, 0);
    if (toolsAvailable === 0) {
      // Deliberately NOT an LLM answer. "Base MCP returned no callable tools"
      // and "here is what I remember about Base" are different statements, and
      // only one of them is true.
      return unavailable('no_tools', 'no_base_mcp_tools');
    }

    const agent = baseMcpConsoleRuntimeV1.createAgent({
      llmProvider: baseMcpConsoleRuntimeV1.createLlmProvider(),
      toolAggregator: tools,
      systemPromptExtra: CONSOLE_PROMPT_V1,
      runtimeContext: {
        walletAddress: input.walletAddress,
        chainId: 8453,
        chain: 'base',
        // Not derived from the server's execution capabilities: this console
        // is read-only whatever the rest of the deployment is allowed to do.
        executionMode: 'read-only',
      },
    });

    const trace: BaseMcpConsoleTraceEntryV1[] = [];
    const pending = new Map<string, string>();
    let reply = '';
    let truncated = false;

    for await (const event of agent.chatStream(input.userId, message)) {
      if (event.type === 'message') {
        reply += event.content;
        continue;
      }
      if (event.type === 'tool_call') {
        pending.set(event.toolName, baseMcpConsoleArgsV1(event.args));
        continue;
      }
      trace.push({
        tool: event.toolName,
        args: pending.get(event.toolName) ?? '{}',
        ok: !event.isError,
        result: baseMcpConsoleResultTextV1(event.result),
        errorCode: event.isError ? sanitizedToolErrorCode(event.result, 'base_mcp_tool_failed') : null,
      });
      pending.delete(event.toolName);
      if (trace.length >= MAX_TOOL_CALLS_V1) {
        // Leaving the loop ends the generator, so the model does not get
        // another round. Said out loud rather than presented as a finished
        // answer.
        truncated = true;
        break;
      }
    }

    return {
      status: 'answered',
      reply: reply.trim() ? truncate(reply.trim(), MAX_REPLY_CHARS_V1) : null,
      trace,
      toolsAvailable,
      truncated,
      errorCode: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    // Never the thrown message: it can carry the endpoint, and the endpoint
    // can carry a token.
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
    if (/401|403|unauthor|invalid_grant|reauth|credential|decrypt/i.test(text)) {
      return unavailable('needs_reauth', 'needs_reauth');
    }
    return unavailable('failed', 'base_mcp_console_failed');
  } finally {
    await tools.close().catch(() => undefined);
  }
}
