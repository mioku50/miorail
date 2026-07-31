import { createLlmProvider, providerLabelV1 } from '../lib/llm/src/factory.js';
import { FallbackLlmProvider } from '../lib/llm/src/fallback.js';
import { OpenAiCompatibleClient } from '../lib/llm/src/openai.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// Checks the LLM router this deployment is actually configured with, and — when
// a fallback is configured — checks that too. An untested fallback is a promise
// nobody has kept: it is discovered broken on the one day it was needed.

async function run() {
  console.log('--- Smoke Test: LLM Runtime ---');

  // Before any lookup, so a variable set in .env is not reported as missing.
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  if (process.env.LLM_PROVIDER !== 'openai-compatible') {
    console.error('❌ LLM_PROVIDER must be openai-compatible');
    process.exit(1);
  }

  if (!process.env.LLM_BASE_URL?.trim() || !process.env.LLM_API_KEY?.trim() || !process.env.LLM_MODEL?.trim()) {
    console.error('❌ LLM_BASE_URL, LLM_API_KEY, LLM_MODEL must be set (an empty value counts as unset)');
    process.exit(1);
  }

  console.log('✅ Provider:', process.env.LLM_PROVIDER);
  console.log('✅ Base URL:', process.env.LLM_BASE_URL);
  console.log('✅ Model:', process.env.LLM_MODEL);
  console.log('✅ API Key is set (hidden)');

  const fallbackBaseUrl = (process.env.LLM_FALLBACK_BASE_URL || '').trim();
  const fallbackModel = (process.env.LLM_FALLBACK_MODEL || '').trim();
  console.log(
    fallbackBaseUrl ? `✅ Fallback: ${fallbackBaseUrl} (${fallbackModel})` : '   · no fallback configured',
  );

  try {
    const provider = createLlmProvider();
    console.log('✅ Provider factory instantiated successfully');

    console.log('⏳ Requesting completion from LLM...');
    const res = await provider.generate({
      messages: [{ role: 'user', content: 'Say "hello sepolia" in lowercase.' }]
    });

    if (res && res.message && res.message.content) {
      console.log('✅ LLM response received:', res.message.content.trim());
    } else {
      console.error('❌ LLM returned empty or invalid response:', res);
      process.exit(1);
    }

    // The primary answered, so the chain never exercised the fallback. Check it
    // on its own: a fallback that has never served a request is untested.
    if (fallbackBaseUrl) {
      console.log(`⏳ Checking the fallback (${providerLabelV1(fallbackBaseUrl)}) on its own...`);
      const ok = await checkFallbackDirectly();
      if (!ok) process.exit(1);
    }

    console.log('🎉 LLM Runtime Smoke Test Passed!');
  } catch (err: unknown) {
    reportError(err);
    process.exit(1);
  }
}

/** Forces a fallover by pairing a primary that always fails with the CONFIGURED
 * fallback, then confirms the fallback answered. */
async function checkFallbackDirectly(): Promise<boolean> {
  const baseUrl = (process.env.LLM_FALLBACK_BASE_URL || '').trim();
  const model = (process.env.LLM_FALLBACK_MODEL || '').trim();
  const apiKey = (
    process.env.LLM_FALLBACK_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_KEY ||
    ''
  ).trim();

  const chain = new FallbackLlmProvider(
    {
      label: 'smoke-unreachable-primary',
      provider: {
        generate: async () => {
          throw new Error('deliberate smoke failure — forcing a fallover');
        },
      },
    },
    { label: providerLabelV1(baseUrl), provider: new OpenAiCompatibleClient({ apiKey, baseUrl, defaultModel: model }) },
    { onFallover: () => {} },
  );

  try {
    const res = await chain.generate({ messages: [{ role: 'user', content: 'Say "fallback ok" in lowercase.' }] });
    const content = res.message.content?.trim();
    if (!content) {
      console.error('❌ Fallback returned an empty response');
      return false;
    }
    console.log('✅ Fallback response received:', content);
    return true;
  } catch (err: unknown) {
    console.error('❌ Fallback is configured but does not work:');
    reportError(err);
    return false;
  }
}

/** Prints an error, refusing to print it at all if it contains a credential. */
function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const secrets = [process.env.LLM_API_KEY, process.env.LLM_FALLBACK_API_KEY, process.env.OPENROUTER_KEY]
    .map((value) => (value || '').trim())
    .filter((value) => value.length >= 8);
  if (secrets.some((secret) => message.includes(secret))) {
    console.error('❌ SECURITY FAILURE: API Key leaked in error message!');
    return;
  }
  console.error('❌ Error during LLM generation:', message);
}

run();
