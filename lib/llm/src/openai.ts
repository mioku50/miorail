import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  fetchImpl?: typeof fetch;
  /**
   * Extra request headers this gateway requires.
   *
   * Added because AgentRouter routes on `User-Agent` and answers 401
   * `unauthorized_client_error` to a valid key sent without one it recognises —
   * so an OpenAI-compatible client that sends none is unusable there whatever
   * the credential says.
   *
   * `Content-Type` and `Authorization` are applied AFTER these and cannot be
   * replaced by them: a header map is configuration, and configuration must not
   * be able to redirect the credential or change the body's declared type.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Extra request-body fields this gateway reads, such as OpenRouter's
   * routing preferences.
   *
   * Spread FIRST, for the same reason as `headers`: configuration must not be
   * able to replace the model, the messages or anything the caller asked for.
   * Host-scoped by the factory, because a field one gateway reads is a 422
   * from another.
   */
  body?: Readonly<Record<string, unknown>>;
  /** Ask compatible providers to guarantee a JSON object. Exact keys and
   * financial semantics are still enforced by the caller's strict parser. */
  jsonMode?: boolean;
}

/** The longest any one request may take, whatever budget a caller names. */
export const CLIENT_TIMEOUT_MS_V1 = 60_000;

/** How much of a provider's error body is kept. A gateway that answers with an
 * HTML page or a stack trace should not become a multi-kilobyte log line. */
const ERROR_BODY_LIMIT = 500;

/**
 * Removes the configured credential from provider-supplied text.
 *
 * Some gateways echo the `Authorization` header back inside an error body, and
 * that body ends up in an `Error` that gets logged. Short values are left alone:
 * a two-character "key" would match everywhere and turn the message to noise.
 */
export function redactSecretV1(text: string, secret: string): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * A non-2xx answer from an OpenAI-compatible endpoint.
 *
 * The message keeps the shape it has always had, so existing log greps still
 * work. `status` is the addition: a caller deciding whether a SECOND provider is
 * worth trying needs to distinguish "this key is out of quota" from "this
 * request is malformed", and parsing that back out of a string is guesswork.
 */
export class LlmHttpError extends Error {
  readonly status: number;
  /**
   * A 429 whose own rate-limit header says the allowance is zero.
   *
   * That is not "too many requests this minute", which passes, but "no
   * requests at all", which does not. Mistral answered exactly this from
   * 2026-09-29 for days: `x-ratelimit-limit-req-minute: 0` on a valid key.
   */
  readonly zeroAllowance: boolean;

  constructor(status: number, body: string, options: { zeroAllowance?: boolean } = {}) {
    super(`OpenAI API error (${status}): ${body}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.zeroAllowance = options.zeroAllowance === true;
  }
}

/** No answer arrived within the request's budget. */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`No answer within ${timeoutMs} ms`);
    this.name = 'LlmTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Rate-limit headers that state a per-window allowance: Mistral's, OpenAI's,
 * and the generic one OpenRouter sends. */
const ALLOWANCE_HEADERS_V1: readonly string[] = [
  'x-ratelimit-limit-req-minute',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit',
];

function zeroAllowanceV1(headers: Headers): boolean {
  return ALLOWANCE_HEADERS_V1.some((name) => headers.get(name)?.trim() === '0');
}

export class OpenAiCompatibleClient implements LlmProvider {
  constructor(private config: OpenAiConfig) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const timeoutMs = Math.max(1, Math.min(CLIENT_TIMEOUT_MS_V1, Math.floor(request.timeoutMs ?? CLIENT_TIMEOUT_MS_V1)));
    try {
      return await this.generateWithin(request, AbortSignal.timeout(timeoutMs));
    } catch (error) {
      // The signal also aborts reading the body, so a stalled stream lands
      // here too. Named, so a fallover line says what happened.
      if (error instanceof Error && error.name === 'TimeoutError') throw new LlmTimeoutError(timeoutMs);
      throw error;
    }
  }

  private async generateWithin(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const model = request.model || this.config.defaultModel;
    const url = `${this.config.baseUrl.replace(/(?:\/v1)?\/?$/, '')}/v1/chat/completions`;

    const fetchImpl = this.config.fetchImpl || fetch;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...(this.config.headers ?? {}),
        // Last, so a configured header can never replace either of these.
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      signal,
      body: JSON.stringify({
        ...(this.config.body ?? {}),
        model,
        messages: request.messages,
        temperature: request.temperature,
        // Sent only when a caller asked for it. A provider that does not know
        // the field ignores it; one that does stops charging for thinking on a
        // task that is transcription. See LlmRequest.reasoningEffort.
        ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
        ...(this.config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {})
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmHttpError(
        response.status,
        redactSecretV1(errorText, this.config.apiKey).slice(0, ERROR_BODY_LIMIT),
        { zeroAllowance: response.status === 429 && zeroAllowanceV1(response.headers) },
      );
    }

    const data = await response.json() as {
      provider?: unknown;
      choices?: Array<{
        finish_reason?: string;
        message?: {
          role?: string;
          content?: string;
          /** Reasoning models put their working here and the answer in
           * `content`. Read only to tell an empty answer from a truncated
           * one — never returned, never logged, never stored. */
          reasoning_content?: string;
          name?: string;
          tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    if (
      typeof data !== 'object' ||
      data === null ||
      !Array.isArray(data.choices) ||
      data.choices.length === 0 ||
      !data.choices[0].message
    ) {
      throw new Error('Invalid response structure from OpenAI API');
    }

    const firstChoice = data.choices[0];
    // The guard above already proved this is present; the local binding is
    // what the narrowing is lost across.
    const firstMessage = firstChoice.message!;
    const role = firstMessage.role as 'system' | 'user' | 'assistant' | 'tool' | undefined;

    // A reasoning model that ran out of budget mid-thought answers with an
    // EMPTY `content` and a full `reasoning_content`. Returning '' from here
    // hands the caller a silent non-answer: the verifier rejects it, the
    // narration falls back, and the log says the model replied.
    //
    // Measured on 2026-08-25 against deepseek-v4-flash: at max_tokens 300 the
    // content was empty with 1,222 characters of reasoning and
    // finish_reason "length"; with no cap it answered normally in 3-6s. So
    // this is a truncation, it is a property of the provider and the request
    // budget, and it must fall over to the next link rather than pass for a
    // reply. Tool calls are exempt — an empty content beside them is the
    // documented shape.
    const emptyContent = (firstMessage.content ?? '').trim().length === 0;
    const hasToolCalls = Array.isArray(firstMessage.tool_calls) && firstMessage.tool_calls.length > 0;
    const reasoningLength = (firstMessage.reasoning_content ?? '').length;
    if (emptyContent && !hasToolCalls && reasoningLength > 0) {
      throw new Error(
        `Model ${model} returned no content after ${reasoningLength} characters of reasoning` +
          ` (finish_reason: ${firstChoice.finish_reason ?? 'absent'})`,
      );
    }

    return {
      message: {
        role: role || 'assistant',
        content: firstMessage.content ?? '',
        name: firstMessage.name,
        tool_calls: firstMessage.tool_calls
      },
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined,
      ...(typeof data.provider === 'string' && data.provider.length > 0
        ? { upstream: data.provider.slice(0, 64) }
        : {}),
    };
  }
}
