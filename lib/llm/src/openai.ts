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
        temperature: request.temperature
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as any;

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid response structure from OpenAI API');
    }

    return {
      message: {
        role: data.choices[0].message.role,
        content: data.choices[0].message.content,
        name: data.choices[0].message.name
      },
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }
}
