export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
}

export interface LlmResponse {
  message: LlmMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LlmProvider {
  generate(request: LlmRequest): Promise<LlmResponse>;
}
