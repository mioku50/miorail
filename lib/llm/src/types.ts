export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  /**
   * How much the model may think before it answers, where the provider offers
   * the OpenAI-standard control.
   *
   * `none` is not a micro-optimisation. Measured on 2026-09-09 against the
   * Stocks narrator's real bundle on deepseek-v4-flash: thinking on, 120.5s
   * and 18,888 completion tokens of which 14,791 were reasoning; thinking off,
   * 6.7s and 710 tokens. The surface's 30s budget could not be met, so every
   * reader got the deterministic fallback after half a minute of waiting, and
   * each of those unusable answers was billed.
   *
   * Set it on a call whose task is transcription or extraction from evidence
   * already in the prompt. Leave it unset where the model is asked to reason.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /**
   * The caller's whole budget for this answer, in milliseconds, across every
   * link a chain may try.
   *
   * The Stocks narrator gives up at 30 s, and it used to hand the chain no
   * budget at all, so each link waited out the client's own 60 s. A slow
   * primary spent the whole 30 s and the spare was never asked: on 2026-09-28
   * a narration logged `provider_did_not_answer` with no fallover line. With a
   * budget, a chain gives each link an equal share of what is left, and the
   * client aborts its request when its share runs out. Unset keeps the
   * client's 60 s per link.
   */
  timeoutMs?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
}

export interface LlmResponse {
  message: LlmMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /**
   * The upstream that served the answer, where a gateway names it (OpenRouter
   * answers with `provider`). Read by measurements only: one upstream behind
   * OpenRouter took 17-52 s while every other took 2.5-7 s, and a p95 alone
   * cannot say which one was slow.
   */
  upstream?: string;
}

export interface LlmProvider {
  generate(request: LlmRequest): Promise<LlmResponse>;
}
