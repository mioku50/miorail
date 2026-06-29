import { LlmProvider, LlmMessage } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';
import { MemoryService } from '@mioagent/memory';
import { logger } from '@mioagent/utils';

export interface AgentConfig {
  llmProvider: LlmProvider;
  toolAggregator: ToolAggregator;
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; toolName: string; args: string }
  | { type: 'tool_result'; toolName: string; result: string; isError: boolean; approvalUrl?: string; requestId?: string };

export class Agent {
  constructor(private config: AgentConfig) {}

  async *chatStream(userId: string, userMessage: string, history: LlmMessage[] = []): AsyncGenerator<AgentEvent, void, unknown> {
    console.log("TRACE: agent.chatStream started");
    const basePrompt = 'You are a helpful assistant. Use tools if necessary.';

    console.log("TRACE: getting user settings");
    const userSettings = await MemoryService.getUserSettings(userId);
    console.log("TRACE: got user settings");
    const memory = userSettings?.memoryMd;
    let systemPrompt = basePrompt;
    if (memory && memory.trim().length > 0) {
      systemPrompt = `${basePrompt}\n\n<user_memory>\n${memory.trim()}\n</user_memory>`;
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ];

    console.log("TRACE: listing tools");
    const tools = await this.config.toolAggregator.listTools();
    console.log("TRACE: listed tools");
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
          try {
            const res = await this.config.toolAggregator.callTool(tc.function.name, argsObj);
            resultStr = res.content;
            isErr = res.isError;
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
