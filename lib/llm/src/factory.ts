import { LlmProvider } from './types';
import { MockLlmProvider } from './mock';
import { OpenAiCompatibleClient } from './openai';

export function createLlmProvider(): LlmProvider {
  const explicitProvider = process.env.LLM_PROVIDER;
  const providerType = explicitProvider || 'mock';

  if (providerType === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER is openai but OPENAI_API_KEY is not set');
    }
    return new OpenAiCompatibleClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com',
      defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    });
  }

  if (providerType === 'openai-compatible') {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM_PROVIDER is openai-compatible but LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL is not set');
    }
    return new OpenAiCompatibleClient({
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
      defaultModel: process.env.LLM_MODEL
    });
  }

  if (process.env.CHAIN_ENV === 'sepolia' && explicitProvider !== 'mock' && process.env.NODE_ENV !== 'test') {
      throw new Error('LLM provider is not configured. Real LLM configuration is required for Sepolia runtime unless LLM_PROVIDER=mock is explicitly set.');
  }

  // default to mock
  return new MockLlmProvider('This is a mock response from the agent.');
}
