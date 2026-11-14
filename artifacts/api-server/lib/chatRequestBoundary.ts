import type { Response } from 'express';
import type { LlmProvider } from '@mioagent/llm';
import type { ToolAggregator } from '@mioagent/tools';
import { abortableV1 } from '@mioagent/utils';
import type { ModelBudgetV1 } from './modelBudget.js';

export const CHAT_DEADLINE_MS_V1 = 60_000;

export class ChatRequestCancelledV1 extends Error {
  constructor(readonly code: 'chat_timeout' | 'chat_disconnected') {
    super(code);
    this.name = 'ChatRequestCancelledV1';
  }
}

/** One lifetime covers setup, direct reads, semantic routing and the tool loop. With `models`, every model
 * call of the request first takes its place in the server's one budget (audit MCP-5): a call refused there
 * never reaches the provider, and its ModelBudgetSpentErrorV1 says why. */
export function chatRequestBoundaryV1(res: Response, timeoutMs = CHAT_DEADLINE_MS_V1, models?: { budget: ModelBudgetV1; clientKey: string }) {
  const controller = new AbortController();
  const { signal } = controller;
  let ownedTools: ToolAggregator | undefined;
  let closed = false;
  const closeTools = () => {
    if (!ownedTools || closed) return;
    closed = true;
    void ownedTools.close().catch(() => { /* Cleanup must not expose a provider's error. */ });
  };
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new ChatRequestCancelledV1('chat_disconnected'));
    closeTools();
  };
  res.once('close', onClose);
  const timer = setTimeout(() => {
    controller.abort(new ChatRequestCancelledV1('chat_timeout'));
    closeTools();
  }, timeoutMs);
  timer.unref();

  return {
    signal,
    wait: <T>(work: () => PromiseLike<T> | T) => abortableV1(signal, work),
    async tools(factory: () => Promise<ToolAggregator>): Promise<ToolAggregator> {
      return abortableV1(signal, async () => {
        const tools = await factory();
        ownedTools = tools;
        if (signal.aborted) { closeTools(); signal.throwIfAborted(); }
        tools.setAbortSignal(signal);
        return tools;
      });
    },
    llm(provider: LlmProvider): LlmProvider {
      return { generate: request => abortableV1(signal, async () => {
        if (models) await models.budget.take(models.clientKey);
        return provider.generate({
          ...request,
          signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
        });
      }) };
    },
    dispose() {
      clearTimeout(timer);
      res.off('close', onClose);
      closeTools();
    },
  };
}
