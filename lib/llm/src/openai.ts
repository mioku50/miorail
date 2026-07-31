import { LlmProvider, LlmRequest, LlmResponse } from './types.js';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  fetchImpl?: typeof fetch;
}

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

  constructor(status: number, body: string) {
    super(`OpenAI API error (${status}): ${body}`);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

export class OpenAiCompatibleClient implements LlmProvider {
  constructor(private config: OpenAiConfig) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model || this.config.defaultModel;
    const url = `${this.config.baseUrl.replace(/(?:\/v1)?\/?$/, '')}/v1/chat/completions`;

    const fetchImpl = this.config.fetchImpl || fetch;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {})
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new LlmHttpError(
        response.status,
        redactSecretV1(errorText, this.config.apiKey).slice(0, ERROR_BODY_LIMIT),
      );
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string;
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

    const firstMessage = data.choices[0].message;
    const role = firstMessage.role as 'system' | 'user' | 'assistant' | 'tool' | undefined;

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
      } : undefined
    };
  }
}
