import { LlmProvider, LlmRequest, LlmResponse } from './types.js';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export class OpenAiCompatibleClient implements LlmProvider {
  constructor(private config: OpenAiConfig) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const model = request.model || this.config.defaultModel;
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {})
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
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
