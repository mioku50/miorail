import { LlmProvider, LlmMessage } from '@mioagent/llm';
import { ToolAggregator } from '@mioagent/tools';
import { MemoryService } from '@mioagent/memory';

export interface AgentConfig {
  llmProvider: LlmProvider;
  toolAggregator: ToolAggregator;
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; toolName: string; args: string }
  | { type: 'tool_result'; toolName: string; result: string; isError: boolean };

export class Agent {
  constructor(private config: AgentConfig) {}

  async *chatStream(userId: string, userMessage: string, history: LlmMessage[] = []): AsyncGenerator<AgentEvent, void, unknown> {
    const basePrompt = 'You are a helpful assistant. Use tools if necessary.';

    const userSettings = await MemoryService.getUserSettings(userId);
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

    const tools = await this.config.toolAggregator.listTools();
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
      const response = await this.config.llmProvider.generate({
        messages,
        tools: llmTools
      });

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
          try {
            const res = await this.config.toolAggregator.callTool(tc.function.name, argsObj);
            resultStr = res.content;
            isErr = res.isError;
          } catch (e) {
            resultStr = e instanceof Error ? e.message : String(e);
            isErr = true;
          }

          yield { type: 'tool_result', toolName: tc.function.name, result: resultStr, isError: isErr };

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
