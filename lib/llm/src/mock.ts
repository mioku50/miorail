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

    let messageContent = content;
    let tool_calls = undefined;
    if (content.startsWith('TOOL:')) {
      tool_calls = [{
        id: 'call_123',
        type: 'function',
        function: {
          name: content.substring(5).split('|')[0],
          arguments: content.substring(5).split('|')[1] || '{}'
        }
      }];
      messageContent = '';
    }

    return {
      message: {
        role: 'assistant',
        content: messageContent,
        tool_calls: tool_calls as any,
      },
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }
    };
  }
}
