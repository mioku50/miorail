import { LlmProvider, LlmMessage } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';
import { MemoryService } from '@mioagent/memory';
import { logger } from '@mioagent/utils';

export interface AgentConfig {
  llmProvider: LlmProvider;
  toolAggregator: ToolAggregator;
  runtimeContext?: {
    walletAddress?: string;
    chainId: number;
    chain: string;
    executionMode: 'read-only' | 'user-confirmed';
    providerNamespace?: string;
    skillNamespace?: string;
    skillInstructions?: string[];
    skillLoaded?: boolean;
  };
  toolResultGuard?: (input: {
    toolName: string;
    content: string;
    isError: boolean;
  }) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }>;
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; toolName: string; args: string }
  | { type: 'tool_result'; toolName: string; result: string; isError: boolean; approvalUrl?: string; requestId?: string };

const NAMESPACED_TOOL_VERBS = new Set([
  'get', 'list', 'query', 'read', 'search', 'check', 'fetch', 'lookup', 'view', 'find',
  'quote', 'prepare', 'swap', 'send', 'sign', 'deposit', 'withdraw', 'supply', 'borrow', 'repay',
]);

function isNamespacedPartnerTool(toolName: string): boolean {
  const parts = toolName.toLowerCase().split(/[_:.\-/]/).filter(Boolean);
  return parts.length >= 2 && !NAMESPACED_TOOL_VERBS.has(parts[0]!) && NAMESPACED_TOOL_VERBS.has(parts[1]!);
}

export class Agent {
  constructor(private config: AgentConfig) {}

  async *chatStream(userId: string, userMessage: string, history: LlmMessage[] = []): AsyncGenerator<AgentEvent, void, unknown> {
    console.log("TRACE: agent.chatStream started");
    console.log("TRACE: getting user settings");
    const userSettings = await MemoryService.getUserSettings(userId);
    console.log("TRACE: got user settings");
    const memory = userSettings?.memoryMd;
    console.log("TRACE: listing tools");
    const providerInventory = await this.config.toolAggregator.listProviderTools();
    const allTools = providerInventory.flatMap((entry) => entry.tools);
    const runtime = this.config.runtimeContext;
    const providerNamespace = runtime?.providerNamespace?.toLowerCase();
    const tools = providerNamespace
      ? allTools.filter((tool) => {
          const lower = tool.name.toLowerCase();
          return lower === providerNamespace || lower.startsWith(`${providerNamespace}_`)
            || lower.startsWith(`${providerNamespace}:`) || lower.startsWith(`${providerNamespace}.`)
            || lower.startsWith(`${providerNamespace}-`) || lower.startsWith(`${providerNamespace}/`);
        })
      : runtime?.executionMode === 'read-only'
        ? allTools.filter((tool) => !isNamespacedPartnerTool(tool.name))
        : allTools;
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    console.log("TRACE: listed tools");
    const baseMcpTools = providerInventory
      .filter((entry) => entry.providerId.startsWith('base-mcp'))
      .flatMap((entry) => entry.tools.map((tool) => tool.name))
      .filter((name) => allowedToolNames.has(name));
    const partnerTools = providerInventory
      .filter((entry) => entry.providerId !== 'native' && !entry.providerId.startsWith('base-mcp'))
      .flatMap((entry) => entry.tools.map((tool) => tool.name))
      .filter((name) => allowedToolNames.has(name));
    const basePrompt = [
      'You are Miorail Agent Stream. Use an enabled matching tool before claiming a provider or MCP capability is unavailable.',
      'Never invent tool results. Never request, read, or store a private key.',
      runtime ? `Runtime: wallet=${runtime.walletAddress || 'Base Account user scope'}, chain=${runtime.chain}, chainId=${runtime.chainId}, executionMode=${runtime.executionMode}.` : '',
      providerNamespace ? `Provider scope is ${providerNamespace}. Use only ${providerNamespace}-namespaced tools and never substitute another protocol.` : '',
      runtime?.skillLoaded && runtime.skillNamespace
        ? `Runtime skill ${runtime.skillNamespace} is loaded from the packaged registry. Follow these instructions: ${(runtime.skillInstructions || []).join(' ')}`
        : 'Tool inventory does not prove that plugin instructions were loaded. Never claim you read or loaded plugin instructions unless the runtime explicitly confirms it.',
      `Enabled Base MCP read tools: ${baseMcpTools.join(', ') || 'none'}.`,
      `Enabled partner read tools: ${partnerTools.join(', ') || 'none'}.`,
      'In read-only mode, do not call send_calls, swap, sign, prepare, deposit, withdraw, or any transaction tool.',
    ].filter(Boolean).join('\n');

    let systemPrompt = basePrompt;
    if (memory && memory.trim().length > 0) {
      systemPrompt = `${basePrompt}\n\n<user_memory>\n${memory.trim()}\n</user_memory>`;
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ];

    const llmTools = tools.length > 0 ? tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>
      }
    })) : undefined;

    let isFinished = false;

    while (!isFinished) {
      logger.info('Agent generating response');
      const llmStart = Date.now();
      const response = await this.config.llmProvider.generate({
        messages,
        tools: llmTools
      });
      logger.info('Agent generated response', { durationMs: Date.now() - llmStart, hasToolCalls: !!(response.message.tool_calls && response.message.tool_calls.length > 0) });

      const msg = response.message;
      messages.push(msg);

      if (msg.content) {
        yield { type: 'message', content: msg.content };
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          yield { type: 'tool_call', toolName: tc.function.name, args: tc.function.arguments };

          let argsObj = {};
          try {
            argsObj = JSON.parse(tc.function.arguments);
          } catch {
            // skip
          }

          let resultStr;
          let isErr;
          logger.info('Agent calling tool', { toolName: tc.function.name });
          const toolStart = Date.now();
          if (!allowedToolNames.has(tc.function.name)) {
            resultStr = JSON.stringify({
              errorCode: providerNamespace ? 'provider_tool_scope_violation' : 'tool_not_available_in_runtime',
              ...(providerNamespace ? { requiredProvider: providerNamespace } : {}),
            });
            isErr = true;
            logger.warn('Agent blocked cross-provider tool call', {
              toolName: tc.function.name,
              requiredProvider: providerNamespace,
            });
          } else try {
            const res = await this.config.toolAggregator.callTool(tc.function.name, argsObj);
            resultStr = res.content;
            isErr = res.isError;
            if (this.config.toolResultGuard) {
              try {
                const guarded = await this.config.toolResultGuard({
                  toolName: tc.function.name,
                  content: resultStr,
                  isError: isErr,
                });
                resultStr = guarded.content;
                isErr = guarded.isError;
              } catch {
                resultStr = JSON.stringify({ errorCode: 'tool_result_screening_failed' });
                isErr = true;
              }
            }
            logger.info('Agent tool call success', { toolName: tc.function.name, durationMs: Date.now() - toolStart });
          } catch (e) {
            resultStr = e instanceof Error ? e.message : String(e);
            isErr = true;
            logger.error('Agent tool call error', { toolName: tc.function.name, error: String(e), durationMs: Date.now() - toolStart });
          }

          let approvalUrl: string | undefined;
          let requestId: string | undefined;
          try {
            if (resultStr) {
              const parsedResult = JSON.parse(resultStr);
              if (parsedResult && typeof parsedResult === 'object') {
                if (typeof parsedResult.approvalUrl === 'string') approvalUrl = parsedResult.approvalUrl;
                if (typeof parsedResult.requestId === 'string') requestId = parsedResult.requestId;
              }
            }
          } catch {
            // skip
          }

          yield { type: 'tool_result', toolName: tc.function.name, result: resultStr, isError: isErr, approvalUrl, requestId };

          messages.push({
            role: 'tool',
            content: resultStr,
            tool_call_id: tc.id
          });
        }
      } else {
        isFinished = true;
      }
    }
  }
}
