import { createLlmProvider } from '@mioagent/llm';

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
// One trivial completion through the real chain with the real credentials.
// It prints a verdict and never a key, a base URL or a provider body.
// ---------------------------------------------------------------------------

const PROMPT_V1 = 'say ok';

async function main(): Promise<void> {
  loadRootEnvFileV1();
  let provider;
  try {
    provider = createLlmProvider();
  } catch (error) {
    console.log(`dead no lane is configured: ${message(error)}`);
    return;
  }
  const started = Date.now();
  try {
    const response = await provider.generate({
      messages: [{ role: 'user', content: PROMPT_V1 }],
      temperature: 0,
      // The same setting every transcription caller uses, so this measures the
      // lane as the product actually drives it.
      reasoningEffort: 'none',
    });
    const said = (response.message.content ?? '').trim().slice(0, 16);
    console.log(said.length > 0 ? `ok ${Date.now() - started}ms` : `dead answered with nothing after ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`dead ${message(error)}`);
  }
}

/** Never a key: the client already redacts its own credential from an error
 * body, and this truncates whatever is left. */
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 110);
}

void main();
