import { LlmProvider } from './types';
import { OpenAiCompatibleClient } from './openai';
import { createLazyX402BuyerPaidFetch, x402BuyerPaymentModeFromEnv } from '@mioagent/x402-gateway';

function fetchForPaymentMode(): typeof fetch | undefined {
  if (x402BuyerPaymentModeFromEnv() !== 'x402') return undefined;
  return createLazyX402BuyerPaidFetch();
}

export function createLlmProvider(): LlmProvider {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();

  if (providerType === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER is openai but OPENAI_API_KEY is not set');
    }
    return new OpenAiCompatibleClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com',
      defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      fetchImpl: fetchForPaymentMode()
    });
  }

  if (providerType === 'openai-compatible') {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM_PROVIDER is openai-compatible but LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL is not set');
    }
    return new OpenAiCompatibleClient({
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
      defaultModel: process.env.LLM_MODEL,
      fetchImpl: fetchForPaymentMode()
    });
  }

  throw new Error(providerType
    ? `Unsupported production LLM_PROVIDER: ${providerType}`
    : 'LLM provider is not configured. Set LLM_PROVIDER to openai or openai-compatible.');
}
