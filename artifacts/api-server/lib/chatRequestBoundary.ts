import type { Response } from 'express';
import type { LlmProvider } from '@mioagent/llm';
import type { ToolAggregator } from '@mioagent/tools';
import { abortableV1 } from '@mioagent/utils';

export const CHAT_DEADLINE_MS_V1 = 60_000;

export class ChatRequestCancelledV1 extends Error {
  constructor(readonly code: 'chat_timeout' | 'chat_disconnected') {
    super(code);
    this.name = 'ChatRequestCancelledV1';
  }
}

/** One lifetime covers setup, direct reads, semantic routing and the tool loop. */
export function chatRequestBoundaryV1(res: Response, timeoutMs = CHAT_DEADLINE_MS_V1) {
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
      return { generate: request => abortableV1(signal, () => provider.generate({
        ...request,
        signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
      })) };
    },
    dispose() {
      clearTimeout(timer);
      res.off('close', onClose);
      closeTools();
    },
  };
}
