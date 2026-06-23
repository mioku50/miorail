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

    const data = await response.json() as any;

    if (
      typeof data !== 'object' ||
      data === null ||
      !('choices' in data) ||
      !Array.isArray((data as any).choices) ||
      (data as any).choices.length === 0 ||
      !('message' in (data as any).choices[0])
    ) {
      throw new Error('Invalid response structure from OpenAI API');
    }

    const typedData = data as {
      choices: { message: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; tool_calls?: any[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      message: {
        role: typedData.choices[0].message.role,
        content: typedData.choices[0].message.content ?? '',
        name: typedData.choices[0].message.name,
        tool_calls: typedData.choices[0].message.tool_calls
      },
      usage: typedData.usage ? {
        promptTokens: typedData.usage.prompt_tokens,
        completionTokens: typedData.usage.completion_tokens,
        totalTokens: typedData.usage.total_tokens
      } : undefined
    };
  }
}
