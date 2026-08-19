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

/**
 * Headers a gateway needs before it will route a request at all.
 *
 * AgentRouter routes on `User-Agent`: a valid key sent with Node's default one
 * comes back 401 `unauthorized_client_error`, which reads as a bad credential
 * and is not one. That kept it unusable here for months. The value is
 * configurable because it is a routing token for somebody else's gateway and
 * can change without warning; the default is the one measured working.
 *
 * Host-scoped, like the key resolution below and for the same reason: a header
 * meant for one gateway must not be sent to another.
 */
export function providerHeadersV1(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!AGENTROUTER_HOSTS_V1.includes(providerLabelV1(baseUrl))) return {};
  const agent = (env.AGENTROUTER_USER_AGENT || '').trim() || 'cline/3.1.0';
  return { 'User-Agent': agent };
}

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
 *
 * Exported so `pnpm smoke:llm` can check the SAME link production builds. It
 * used to construct its own client with its own key lookup, and the copy
 * drifted twice over: no gateway headers, and an OpenRouter key resolved for
 * whatever host happened to be configured. The smoke test reported the
 * fallback broken while the fallback was fine — which is worse than no smoke
 * test, because an operator acts on it.
 */
export function fallbackLinkV1(prefix: string): (NamedLlmProviderV1 & { model: string }) | null {
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
    model,
    provider: new OpenAiCompatibleClient({
      apiKey,
      baseUrl,
      defaultModel: model,
      headers: providerHeadersV1(baseUrl),
    }),
  };
}

/**
 * Adds the model to a label whenever the host alone cannot identify the link.
 *
 * Two OpenRouter links in one chain logged "openrouter.ai failed, falling over
 * to openrouter.ai" — true, and useless: an operator cannot tell which model
 * ran out. Hosts stay bare when they are unique, because that is the shorter
 * and more familiar line.
 */
function disambiguateLabelsV1(
  links: ReadonlyArray<NamedLlmProviderV1 & { model?: string }>,
): NamedLlmProviderV1[] {
  const seen = new Map<string, number>();
  for (const link of links) seen.set(link.label, (seen.get(link.label) ?? 0) + 1);
  return links.map((link) =>
    (seen.get(link.label) ?? 0) > 1 && link.model
      ? { label: `${link.label} (${link.model})`, provider: link.provider }
      : { label: link.label, provider: link.provider },
  );
}

function withFallbackV1(primary: NamedLlmProviderV1 & { model?: string }): LlmProvider {
  const spares = [fallbackLinkV1('LLM_FALLBACK'), fallbackLinkV1('LLM_FALLBACK_2')].filter(
    (link): link is NamedLlmProviderV1 & { model: string } => link !== null,
  );
  if (spares.length === 0) return primary.provider;

  return new LlmProviderChainV1(disambiguateLabelsV1([primary, ...spares]), {
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
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    return withFallbackV1({
      label: providerLabelV1(baseUrl),
      model,
      provider: new OpenAiCompatibleClient({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl,
        defaultModel: model,
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
      model,
      provider: new OpenAiCompatibleClient({
        apiKey,
        baseUrl,
        defaultModel: model,
        headers: providerHeadersV1(baseUrl),
        fetchImpl: fetchForPaymentMode()
      })
    });
  }

  throw new Error(providerType
    ? `Unsupported production LLM_PROVIDER: ${providerType}`
    : 'LLM provider is not configured. Set LLM_PROVIDER to openai or openai-compatible.');
}
