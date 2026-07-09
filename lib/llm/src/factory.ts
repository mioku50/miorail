import { LlmProvider } from './types';
import { MockLlmProvider } from './mock';
import { OpenAiCompatibleClient } from './openai';
import { createX402BuyerPaidFetch, x402BuyerPaymentModeFromEnv, X402BuyerUnavailableError } from '@mioagent/x402-gateway';

function fetchForPaymentMode(): typeof fetch | undefined {
  if (x402BuyerPaymentModeFromEnv() !== 'x402') return undefined;
  try {
    return createX402BuyerPaidFetch();
  } catch (error) {
    if (error instanceof X402BuyerUnavailableError) {
      throw new Error(`LLM_PAYMENT_MODE=x402 requires a configured x402 buyer payer signer: ${error.errorCode}`);
    }
    throw error;
  }
}

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

  if (process.env.CHAIN_ENV === 'sepolia' && explicitProvider !== 'mock' && process.env.NODE_ENV !== 'test') {
      throw new Error('LLM provider is not configured. Real LLM configuration is required for Sepolia runtime unless LLM_PROVIDER=mock is explicitly set.');
  }

  // default to mock
  return new MockLlmProvider('This is a mock response from the agent.');
}
