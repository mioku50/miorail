import { LlmProvider, LlmRequest, LlmResponse } from './types.js';

export class MockLlmProvider implements LlmProvider {
  public requests: LlmRequest[] = [];
  private responses: string[] | ((req: LlmRequest) => string);
  private responseIndex = 0;

  constructor(responses: string | string[] | ((req: LlmRequest) => string)) {
    this.responses = Array.isArray(responses) ? responses : (typeof responses === 'string' ? [responses] : responses);
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);

    let content: string;
    if (typeof this.responses === 'function') {
        content = this.responses(request);
    } else {
        content = this.responses[this.responseIndex % this.responses.length];
        this.responseIndex++;
    }

    return {
      message: {
        role: 'assistant',
        content: content,
      },
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }
    };
  }
}
