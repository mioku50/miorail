import {
  LlmHttpError,
  LlmTimeoutError,
  createLlmProvider,
  fallbackLinkV1,
  primaryApiKeyV1,
  primaryLinkV1,
  type LlmProvider,
} from '@mioagent/llm';

import { loadRootEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Does the configured language lane answer?
//
// On 2026-09-09 the configured primary had been returning 402 "budget pool
// quota has been exhausted" on every call for an unknown number of days, and
// nothing in the system said so. An unreachable model is not an error on any
// surface — it is a fallback — so Ask Miorail waited out its budget and served
// the deterministic text with a 200. The failure was found by a person asking
// a question, which is the worst available detector.
//
// Each link is asked on its own first. Asking only the chain hid a dead spare
// for days: from 2026-09-29 Mistral answered every call with a zero
// allowance, and the chain still said "ok" because the primary answered.
//
//   link primary openrouter.ai deepseek/deepseek-v4-flash ok 1022ms
//   link spare_2 api.mistral.ai mistral-small-2603 dead HTTP 429, the allowance is zero
//   ok 1180ms                      <- the chain, as the product drives it; last
//
// It prints hosts, models and verdicts, and never a key, a base URL or a
// provider body.
// ---------------------------------------------------------------------------

const PROMPT_V1 = 'say ok';
/** A narrator's whole wait, so the chain line measures what a reader gets. */
const CHAIN_BUDGET_MS_V1 = 30_000;
const LINK_BUDGET_MS_V1 = 20_000;

async function ask(provider: LlmProvider, timeoutMs: number): Promise<string> {
  const started = Date.now();
  try {
    const response = await provider.generate({
      messages: [{ role: 'user', content: PROMPT_V1 }],
      temperature: 0,
      // The same setting every transcription caller uses, so this measures the
      // lane as the product actually drives it.
      reasoningEffort: 'none',
      timeoutMs,
    });
    const said = (response.message.content ?? '').trim().slice(0, 16);
    return said.length > 0 ? `ok ${Date.now() - started}ms` : `dead answered with nothing after ${Date.now() - started}ms`;
  } catch (error) {
    return `dead ${reasonOf(error)}`;
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof LlmHttpError) {
    return `HTTP ${error.status}${error.zeroAllowance ? ', the allowance is zero' : ''}`;
  }
  if (error instanceof LlmTimeoutError) return `no answer within ${error.timeoutMs} ms`;
  return message(error);
}

async function main(): Promise<void> {
  loadRootEnvFileV1();

  const baseUrl = (process.env.LLM_BASE_URL || '').trim();
  const model = (process.env.LLM_MODEL || '').trim();
  const links: Array<{ role: string; label: string; model: string; provider: LlmProvider }> = [];
  if (baseUrl && model) {
    links.push({ role: 'primary', ...primaryLinkV1({ baseUrl, apiKey: primaryApiKeyV1(baseUrl), model }) });
  }
  for (const [role, prefix] of [
    ['spare', 'LLM_FALLBACK'],
    ['spare_2', 'LLM_FALLBACK_2'],
  ] as const) {
    try {
      const link = fallbackLinkV1(prefix);
      if (link) links.push({ role, ...link });
    } catch (error) {
      console.log(`link ${role} - - dead ${message(error)}`);
    }
  }
  for (const link of links) {
    console.log(`link ${link.role} ${link.label} ${link.model} ${await ask(link.provider, LINK_BUDGET_MS_V1)}`);
  }

  let provider;
  try {
    provider = createLlmProvider();
  } catch (error) {
    console.log(`dead no lane is configured: ${message(error)}`);
    return;
  }
  console.log(await ask(provider, CHAIN_BUDGET_MS_V1));
}

/** Never a key: the client already redacts its own credential from an error
 * body, and this truncates whatever is left. */
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 110);
}

void main();
