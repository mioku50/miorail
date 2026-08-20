import {
  createLlmProvider,
  createStructuredLlmProvider,
  fallbackLinkV1,
  providerLabelV1,
} from '../lib/llm/src/factory.js';
import { FallbackLlmProvider } from '../lib/llm/src/fallback.js';
import { resolveB20ConsolePlanV1 } from '../artifacts/api-server/lib/b20ConsoleIntent.js';
import { extractSemanticIntent } from '../artifacts/api-server/lib/semanticIntent.js';
import { extractSwapIntentV2 } from '../lib/intent-engine/src/extractor.js';
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

    const structuredConfigured = Boolean((process.env.LLM_STRUCTURED_PROVIDER || '').trim());
    console.log(
      structuredConfigured
        ? `⏳ Checking structured lane (${process.env.LLM_STRUCTURED_MODEL || 'model unset'})...`
        : '   · no dedicated structured lane; it inherits primary',
    );
    const structured = createStructuredLlmProvider();
    const structuredResponse = await structured.generate({
      messages: [
        {
          role: 'system',
          content: 'Return exactly {"intent":"ok","confidence":1} and no other text.',
        },
        { role: 'user', content: 'Classify this smoke request.' },
      ],
      temperature: 0,
    });
    const parsedStructured = JSON.parse(structuredResponse.message.content || '') as Record<string, unknown>;
    if (
      Object.keys(parsedStructured).sort().join(',') !== 'confidence,intent' ||
      parsedStructured.intent !== 'ok' ||
      parsedStructured.confidence !== 1
    ) {
      throw new Error('Structured LLM returned an invalid smoke contract');
    }
    console.log('✅ Structured lane returned the exact JSON contract');

    const semanticCases = [
      {
        language: 'EN',
        question: 'Surface assets where acquisition worked but disposal could not be established',
        expected: 'find_bought_not_sellable',
      },
      {
        language: 'RU',
        question: 'Где вывод пока слабее из-за того, чего Миорейл ещё не смог установить?',
        expected: 'find_needs_evidence',
      },
      {
        language: 'RU route coverage',
        question: 'Где Miorail проверил не все маршруты и площадки?',
        expected: 'find_not_searched',
      },
    ] as const;
    for (const semanticCase of semanticCases) {
      const startedAt = Date.now();
      const resolved = await resolveB20ConsolePlanV1({
        question: semanticCase.question,
        scope: 'explore',
        provider: structured,
        timeoutMs: 10_000,
      });
      if (resolved.source !== 'semantic_classifier' || resolved.plan.intent !== semanticCase.expected) {
        throw new Error(
          `Structured LLM failed the ${semanticCase.language} B20 intent contract` +
            ` (source=${resolved.source}, intent=${resolved.plan.intent}, reason=${resolved.reason ?? 'none'})`,
        );
      }
      console.log(`✅ ${semanticCase.language} B20 intent resolved in ${Date.now() - startedAt}ms`);
    }

    const financialMessage = 'Пожалуйста, обменяй 0.1 USDC на ETH в сети Base';
    const semanticIntent = await extractSemanticIntent({
      llm: structured,
      message: financialMessage,
      context: { recentMessages: [], runtimeChainId: 8453 },
    });
    if (
      semanticIntent?.intent !== 'swap' ||
      semanticIntent.amount !== '0.1' ||
      semanticIntent.fromAsset?.toUpperCase() !== 'USDC' ||
      semanticIntent.toAsset?.toUpperCase() !== 'ETH'
    ) {
      throw new Error('Structured LLM failed the chat semantic-intent contract');
    }
    console.log('✅ Chat semantic-intent contract passed');

    const routeIntent = await extractSwapIntentV2({
      llm: structured,
      message: financialMessage,
      context: {
        tenantId: 'smoke',
        walletAddress: '0x1111111111111111111111111111111111111111',
        runtimeChainId: 8453,
        requestId: 'structured-smoke',
        requestedAt: '2026-08-20T00:00:00.000Z',
      },
    });
    if (
      routeIntent?.goal !== 'swap' ||
      routeIntent.amount !== '0.1' ||
      routeIntent.fromAsset?.toUpperCase() !== 'USDC' ||
      routeIntent.toAsset?.toUpperCase() !== 'ETH'
    ) {
      throw new Error('Structured LLM failed the RouteIntentV2 extraction contract');
    }
    console.log('✅ RouteIntentV2 extraction contract passed');

    // The primary answered, so the chain never exercised the fallback. Check it
    // on its own: a fallback that has never served a request is untested.
    // Both spares, each on its own. A spare that has never served a request is
    // untested, and the second one is the last thing standing on the day the
    // other two are out.
    for (const prefix of ['LLM_FALLBACK', 'LLM_FALLBACK_2']) {
      const baseUrl = (process.env[`${prefix}_BASE_URL`] || '').trim();
      if (!baseUrl) continue;
      console.log(`⏳ Checking ${prefix} (${providerLabelV1(baseUrl)}) on its own...`);
      const ok = await checkFallbackDirectly(prefix);
      if (!ok) process.exit(1);
    }

    console.log('🎉 LLM Runtime Smoke Test Passed!');
  } catch (err: unknown) {
    reportError(err);
    process.exit(1);
  }
}

/**
 * Forces a fallover by pairing a primary that always fails with the CONFIGURED
 * fallback, then confirms the fallback answered.
 *
 * The link comes from `fallbackLinkV1` — the same function production uses.
 * This built its own client with its own key lookup, and the copy drifted:
 * it sent no gateway headers, so AgentRouter refused it 401 while the real
 * chain worked, and it resolved an OpenRouter key for whatever host was
 * configured. A smoke test that reports a working fallback broken is worse
 * than none, because an operator acts on it.
 */
async function checkFallbackDirectly(prefix: string): Promise<boolean> {
  const link = fallbackLinkV1(prefix);
  if (!link) {
    console.error(`❌ ${prefix} is not configured`);
    return false;
  }

  const chain = new FallbackLlmProvider(
    {
      label: 'smoke-unreachable-primary',
      provider: {
        generate: async () => {
          throw new Error('deliberate smoke failure — forcing a fallover');
        },
      },
    },
    link,
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
  const secrets = [
    process.env.LLM_API_KEY,
    process.env.LLM_STRUCTURED_API_KEY,
    process.env.LLM_FALLBACK_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_KEY,
  ]
    .map((value) => (value || '').trim())
    .filter((value) => value.length >= 8);
  if (secrets.some((secret) => message.includes(secret))) {
    console.error('❌ SECURITY FAILURE: API Key leaked in error message!');
    return;
  }
  console.error('❌ Error during LLM generation:', message);
}

run();
