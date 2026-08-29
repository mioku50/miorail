import {
  fallbackLinkV1,
  primaryApiKeyV1,
  primaryLinkV1,
  type LlmProvider,
} from '@mioagent/llm';

import {
  STOCKS_BENCH_CORPUS_V1,
  STOCKS_BENCH_NOW_V1,
} from '../artifacts/api-server/lib/stocksBenchCorpus.js';
import { stocksEvidenceBundleV1 } from '../artifacts/api-server/lib/stocksEvidence.js';
import {
  STOCKS_NARRATOR_SYSTEM_V1,
  verifyStocksNarrationV1,
} from '../artifacts/api-server/lib/stocksNarration.js';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Prints what a rejected narration actually SAID.
//
// A rejection histogram cannot tell an over-strict rule from a model that got
// it wrong, and the difference decides whether the benchmark measured the
// models or measured my regex. So this prints the offending sentence beside
// the rule that caught it, for a handful of fixtures, and a human reads them.
//
// Read-only: the same frozen corpus, no chain, no wallet, no key printed.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const ids = (process.env.PROBE_FIXTURES || 'B,D,I,C').split(',');
  const which = (process.env.PROBE_LANE || 'fallback').trim();

  const baseUrl = (process.env.LLM_BASE_URL || '').trim();
  const link =
    which === 'primary'
      ? primaryLinkV1({
          baseUrl,
          apiKey: primaryApiKeyV1(baseUrl),
          model: (process.env.LLM_MODEL || '').trim(),
        })
      : fallbackLinkV1('LLM_FALLBACK');
  if (!link) throw new Error('no lane');
  const provider: LlmProvider = link.provider;
  console.log(`lane ${link.label} · ${link.model}\n`);

  for (const id of ids) {
    const entry = STOCKS_BENCH_CORPUS_V1.find((row) => row.id === id.trim());
    if (!entry) continue;
    const bundle = stocksEvidenceBundleV1({
      question: entry.question,
      reality: entry.reality,
      history: entry.history,
      now: STOCKS_BENCH_NOW_V1,
    });
    let raw: string;
    try {
      const response = await provider.generate({
        messages: [
          { role: 'system', content: STOCKS_NARRATOR_SYSTEM_V1 },
          {
            role: 'user',
            content: [
              `QUESTION: ${bundle.question}`,
              '',
              'EVIDENCE ROWS:',
              ...bundle.items.map(
                (item) =>
                  `- ${item.id} [${item.kind}${item.subject ? ` ${item.subject}` : ''}] ${item.label}: ${item.value}`,
              ),
              ...(bundle.missing.length > 0
                ? ['', 'NOT ESTABLISHED (state these as absences, never as zero):', ...bundle.missing.map((m) => `- ${m}`)]
                : []),
              '',
              'MUST SURVIVE ANY PARAPHRASE:',
              ...bundle.caveats.map((c) => `- ${c}`),
              '',
              `ROUTERS ASKED: ${bundle.approvedSources.join(', ') || 'none'}`,
              `OPEN EVIDENCE: ${bundle.hasOpenEvidence ? 'yes' : 'no'}`,
            ].join('\n'),
          },
        ],
        temperature: 0,
      });
      raw = (response.message.content ?? '').trim();
    } catch (error) {
      console.log(`=== ${id}  PROVIDER FAILED: ${error instanceof Error ? error.name : 'unknown'}\n`);
      continue;
    }
    const verdict = verifyStocksNarrationV1({ raw, bundle });
    console.log(`=== ${id} (${entry.name}) — ${verdict.ok ? 'PASSED' : 'REJECTED'}`);
    for (const violation of verdict.violations) console.log(`    [${violation.code}] ${violation.detail}`);
    if (verdict.narration) {
      console.log(`    explanation: ${verdict.narration.explanation}`);
      for (const claim of verdict.narration.established.slice(0, 4)) {
        console.log(`    claim: ${claim.claim}  <- ${claim.sourceIds.join(',')}`);
      }
    } else {
      console.log(`    raw(240): ${raw.slice(0, 240).replace(/\n/g, ' ')}`);
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
