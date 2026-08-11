import { LlmProvider } from './types';
import { OpenAiCompatibleClient } from './openai';
import { LlmProviderChainV1, type NamedLlmProviderV1 } from './fallback';
import { createLazyX402BuyerPaidFetch, x402BuyerPaymentModeFromEnv } from '@mioagent/x402-gateway';

function fetchForPaymentMode(): typeof fetch | undefined {
  if (x402BuyerPaymentModeFromEnv() !== 'x402') return undefined;
  return createLazyX402BuyerPaidFetch();
}

function trimmed(name: string): string {
  return (process.env[name] || '').trim();
}

/** The host, for error messages and logs. Never the key, and never the full URL
 * — some gateways carry a token in the path. */
export function providerLabelV1(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'llm-provider';
  }
}

/** OpenRouter's own key variables, honoured ONLY when the fallback actually
 * points at OpenRouter. A key is a bearer credential for one host; resolving it
 * for an unrelated base URL would hand it to whoever that host is. */
const OPENROUTER_HOSTS_V1: readonly string[] = ['openrouter.ai'];

/** Hosts whose own key variable is honoured, and only for that host. Same rule
 * as OpenRouter's: a key is a bearer credential for ONE host, and resolving it
 * for an unrelated base URL would hand it to whoever that host is. */
const AGENTROUTER_HOSTS_V1: readonly string[] = ['agentrouter.org'];

function fallbackApiKeyV1(baseUrl: string, prefix: string): string {
  const explicit = trimmed(`${prefix}_API_KEY`);
  if (explicit) return explicit;
  const host = providerLabelV1(baseUrl);
  if (OPENROUTER_HOSTS_V1.includes(host)) {
    return trimmed('OPENROUTER_API_KEY') || trimmed('OPENROUTER_KEY');
  }
  if (AGENTROUTER_HOSTS_V1.includes(host)) return trimmed('AGENTROUTER_API_KEY');
  return '';
}

/**
 * Wraps `primary` in a fallback chain when one is configured.
 *
 * Three states, and the middle one is the reason this is not a silent lookup:
 *
 *   none of the three set  — no fallback. Legal; the chain is optional.
 *   all three resolved     — fallback active.
 *   some set               — throws. A half-configured fallback is an operator
 *                            saying "I want resilience" and not getting it, and
 *                            the day that matters is the day the primary dies.
 *                            Discovering it then is the whole failure this
 *                            feature was added to prevent.
 *
 * The fallback is authenticated with its own bearer key and does not take part
 * in x402: an x402-paid fetch would attempt payment against a gateway that
 * never asked for one.
 */
/**
 * One configured fallback link, or null when its variables are all unset.
 *
 * `prefix` is `LLM_FALLBACK` for the first spare and `LLM_FALLBACK_2` for the
 * second. A second spare exists because the primary here answers 429 on most
 * requests, which makes a single spare the provider rather than the spare.
 */
function fallbackLinkV1(prefix: string): NamedLlmProviderV1 | null {
  const baseUrl = trimmed(`${prefix}_BASE_URL`);
  const model = trimmed(`${prefix}_MODEL`);
  const apiKey = baseUrl
    ? fallbackApiKeyV1(baseUrl, prefix)
    : trimmed(`${prefix}_API_KEY`);

  if (!baseUrl && !model && !apiKey) return null;

  const missing = [
    baseUrl ? null : `${prefix}_BASE_URL`,
    apiKey ? null : `${prefix}_API_KEY`,
    model ? null : `${prefix}_MODEL`,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(`LLM fallback is partially configured — missing: ${missing.join(', ')}`);
  }

  return {
    label: providerLabelV1(baseUrl),
    provider: new OpenAiCompatibleClient({ apiKey, baseUrl, defaultModel: model }),
  };
}

function withFallbackV1(primary: NamedLlmProviderV1): LlmProvider {
  const spares = [fallbackLinkV1('LLM_FALLBACK'), fallbackLinkV1('LLM_FALLBACK_2')].filter(
    (link): link is NamedLlmProviderV1 => link !== null,
  );
  if (spares.length === 0) return primary.provider;

  return new LlmProviderChainV1([primary, ...spares], {
    onFallover: ({ from, to, reason }) => {
      // Hosts and a redacted provider message. An operator needs to know the
      // primary is down long before the last spare also runs out.
      console.warn(`[llm] ${from} failed, falling over to ${to}: ${reason}`);
    },
  });
}

export function createLlmProvider(): LlmProvider {
  const providerType = (process.env.LLM_PROVIDER || '').trim().toLowerCase();

  if (providerType === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER is openai but OPENAI_API_KEY is not set');
    }
    const baseUrl = 'https://api.openai.com';
    return withFallbackV1({
      label: providerLabelV1(baseUrl),
      provider: new OpenAiCompatibleClient({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl,
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        fetchImpl: fetchForPaymentMode()
      })
    });
  }

  if (providerType === 'openai-compatible') {
    // Empty counts as unset. `LLM_BASE_URL=` in a .env is the exact shape this
    // has failed as in production: a duplicate key whose second, blank value won.
    const baseUrl = trimmed('LLM_BASE_URL');
    const apiKey = trimmed('LLM_API_KEY');
    const model = trimmed('LLM_MODEL');
    if (!baseUrl || !apiKey || !model) {
      const missing = [
        baseUrl ? null : 'LLM_BASE_URL',
        apiKey ? null : 'LLM_API_KEY',
        model ? null : 'LLM_MODEL',
      ].filter((name): name is string => name !== null);
      throw new Error(
        `LLM_PROVIDER is openai-compatible but ${missing.join(', ')} is not set` +
          ' (an empty value counts as unset — check for a duplicate key in .env,' +
          ' where node --env-file takes the LAST one)',
      );
    }
    return withFallbackV1({
      label: providerLabelV1(baseUrl),
      provider: new OpenAiCompatibleClient({
        apiKey,
        baseUrl,
        defaultModel: model,
        fetchImpl: fetchForPaymentMode()
      })
    });
  }

  throw new Error(providerType
    ? `Unsupported production LLM_PROVIDER: ${providerType}`
    : 'LLM provider is not configured. Set LLM_PROVIDER to openai or openai-compatible.');
}
