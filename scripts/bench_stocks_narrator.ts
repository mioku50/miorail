import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFileSync } from 'node:fs';

import {
  LlmProviderChainV1,
  createStructuredLlmProvider,
  fallbackLinkV1,
  primaryApiKeyV1,
  primaryLinkV1,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@mioagent/llm';

import {
  STOCKS_BENCH_CORPUS_V1,
  STOCKS_BENCH_NOW_V1,
} from '../artifacts/api-server/lib/stocksBenchCorpus.js';
import { stocksEvidenceBundleV1 } from '../artifacts/api-server/lib/stocksEvidence.js';
import {
  narrateStocksAnswerV1,
  type StocksNarrationViolationCodeV1,
} from '../artifacts/api-server/lib/stocksNarration.js';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Phase 13.2A: does the narrator that already ships actually explain the
// Stocks evidence, on the models production is configured with?
//
// The question this answers is operational, not aesthetic. A verifier that
// rejects nine narrations in ten is not broken — the deterministic answer
// ships and the reader loses nothing — but it means the surface costs a
// request per question and changes nothing, and that is a decision to take
// with a number rather than a feeling.
//
// What it sends: the benchmark bundle and the question. What it never sends:
// a wallet, a key, a token the operator did not put in the corpus. What it
// prints: host labels, model names, rates and latencies. Never a key, never a
// base URL with a credential in its path, never a raw provider body.
//
// Read-only in the strongest sense available: the corpus is ten frozen typed
// fixtures, so this benchmark cannot reach a chain, a database or a router.
// ---------------------------------------------------------------------------

const CONTENT_VIOLATIONS_V1: readonly StocksNarrationViolationCodeV1[] = [
  'unsupported_number',
  'claim_number_not_in_cited_evidence',
  'unknown_source_id',
  'claim_cites_another_representation',
  'subject_as_established_claim',
  'unknown_subject',
  'invented_issuer',
  'invented_venue',
  'judgement_vocabulary',
  'forbidden_vocabulary',
  'universal_market_claim',
  'zero_supply_as_dead',
  'provider_failure_unattributed',
  'expired_quote_as_current',
  'overclaim',
  'meaning_changed',
  'absences_not_stated',
  'absence_invented',
];

const REASONING_EMPTY_V1 = /returned no content after \d+ characters of reasoning/;

interface LaneV1 {
  key: string;
  label: string;
  model: string;
  provider: LlmProvider;
  /** True for the chain production actually calls, where a fallover is real. */
  isChain: boolean;
}

interface RunV1 {
  lane: string;
  fixture: string;
  answered: boolean;
  verified: boolean;
  emptyContent: boolean;
  fellOver: boolean;
  latencyMs: number | null;
  violationCodes: StocksNarrationViolationCodeV1[];
  providerErrorName: string | null;
}

function lanesV1(): LaneV1[] {
  const lanes: LaneV1[] = [];
  const primaryBaseUrl = (process.env.LLM_BASE_URL || '').trim();
  const primaryModel = (process.env.LLM_MODEL || '').trim();
  if (primaryBaseUrl && primaryModel) {
    const link = primaryLinkV1({
      baseUrl: primaryBaseUrl,
      apiKey: primaryApiKeyV1(primaryBaseUrl),
      model: primaryModel,
    });
    lanes.push({ key: 'primary', label: link.label, model: link.model, provider: link.provider, isChain: false });
  }
  for (const prefix of ['LLM_FALLBACK', 'LLM_FALLBACK_2']) {
    let link: ReturnType<typeof fallbackLinkV1> = null;
    try {
      link = fallbackLinkV1(prefix);
    } catch (error) {
      console.warn(`[bench] ${prefix} is not usable: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    if (link) {
      lanes.push({
        key: prefix.toLowerCase(),
        label: link.label,
        model: link.model,
        provider: link.provider,
        isChain: false,
      });
    }
  }
  try {
    lanes.push({
      key: 'structured',
      label: (process.env.LLM_STRUCTURED_BASE_URL || 'primary').trim(),
      model: (process.env.LLM_STRUCTURED_MODEL || '').trim() || 'primary',
      provider: createStructuredLlmProvider(),
      isChain: false,
    });
  } catch (error) {
    console.warn(`[bench] structured lane is not usable: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  // The production chain, composed from the links above in the order
  // `createLlmProvider` composes them: primary, first spare, second spare.
  const chainLinks = lanes.filter((lane) => !lane.isChain && lane.key !== 'structured');
  if (chainLinks.length > 1) {
    lanes.push({
      key: 'chain',
      label: 'production chain',
      model: chainLinks.map((lane) => lane.model).join(' → '),
      provider: new LlmProviderChainV1(
        chainLinks.map((lane, index) => ({
          label: lane.label,
          provider: attributedLinkV1(lane.provider, index),
        })),
      ),
      isChain: true,
    });
  }
  return lanes;
}

/**
 * Which link in the chain actually answered, per call.
 *
 * The first version of this watched `console.warn` for the chain's own
 * fallover line, restoring the original in a `finally`. That is correct with
 * one request in flight and wrong with eight: the first run to finish restores
 * the real `console.warn` and every other run in flight stops counting. It
 * reported a 0% fallback activation rate in the same run whose log carried a
 * fallover line — a measurement that contradicted the evidence beside it.
 *
 * An async context is per-call and survives every await between here and the
 * link that answers, which is exactly the scope the question has.
 */
interface ChainCallV1 {
  answeredByIndex: number | null;
  attempts: number;
}
const chainCall = new AsyncLocalStorage<ChainCallV1>();

/** Wraps one link so it records that IT was the one that answered. The client
 * underneath is production's — the same key resolution, the same gateway
 * headers — so this observes the chain rather than approximating it. */
function attributedLinkV1(provider: LlmProvider, index: number): LlmProvider {
  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const context = chainCall.getStore();
      if (context) context.attempts += 1;
      const response = await provider.generate(request);
      if (context) context.answeredByIndex = index;
      return response;
    },
  };
}

function percentileV1(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

async function mapWithConcurrencyV1<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const repetitions = Number(process.env.BENCH_REPETITIONS || '10');
  const concurrency = Number(process.env.BENCH_CONCURRENCY || '4');
  const outputPath = (process.env.BENCH_OUTPUT || '').trim();
  const onlyLane = (process.env.BENCH_LANE || '').trim();

  const lanes = lanesV1().filter((lane) => !onlyLane || lane.key === onlyLane);
  if (lanes.length === 0) {
    console.error('No LLM lane is configured. Nothing to measure.');
    process.exitCode = 1;
    return;
  }

  const bundles = STOCKS_BENCH_CORPUS_V1.map((entry) => ({
    id: entry.id,
    name: entry.name,
    bundle: stocksEvidenceBundleV1({
      question: entry.question,
      reality: entry.reality,
      history: entry.history,
      now: STOCKS_BENCH_NOW_V1,
    }),
  }));

  console.log(
    `Stocks narrator benchmark — ${bundles.length} fixtures x ${lanes.length} lanes x ${repetitions} runs\n`,
  );
  for (const lane of lanes) console.log(`  lane ${lane.key.padEnd(14)} ${lane.label} · ${lane.model}`);
  console.log('');

  const jobs: Array<{ lane: LaneV1; fixture: (typeof bundles)[number] }> = [];
  for (const lane of lanes) {
    for (const fixture of bundles) {
      for (let index = 0; index < repetitions; index += 1) jobs.push({ lane, fixture });
    }
  }

  // Pacing, for a provider metered by TOKENS rather than requests.
  //
  // Mistral publishes x-ratelimit-limit-tokens-minute: 25,000 on medium and
  // 50,000 on small, against a Stocks prompt of roughly 3,000 tokens. That is
  // six to sixteen narrations a minute — ample for a reader asking questions,
  // and nothing at all for a benchmark firing as fast as it can. Measuring
  // availability without pacing measures the benchmark, which is exactly what
  // the first three runs here did.
  const delayMs = Number(process.env.BENCH_DELAY_MS || '0');
  let nextSlot = Date.now();
  const pace = async (): Promise<void> => {
    if (delayMs <= 0) return;
    const slot = nextSlot;
    nextSlot += delayMs;
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };

  const runs = await mapWithConcurrencyV1(jobs, concurrency, async (job) => {
    await pace();
    const context: ChainCallV1 = { answeredByIndex: null, attempts: 0 };
    const answered = await chainCall.run(context, () =>
      narrateStocksAnswerV1({ bundle: job.fixture.bundle, provider: job.lane.provider, timeoutMs: 60_000 }),
    );
    const fellOver = job.lane.isChain && context.attempts > 1;
    const providerError = answered.providerError;
    const run: RunV1 = {
      lane: job.lane.key,
      fixture: job.fixture.id,
      answered: providerError === null,
      verified: answered.answerSource === 'verified_narration',
      emptyContent: providerError !== null && REASONING_EMPTY_V1.test(providerError),
      fellOver: job.lane.isChain && fellOver,
      latencyMs: answered.latencyMs,
      violationCodes: (answered.rejectedBecause ?? []).map((violation) => violation.code),
      providerErrorName: providerError,
    };
    return run;
  });

  const report = {
    schemaVersion: 'stocks-narrator-benchmark/v1',
    startedAt: new Date().toISOString(),
    repetitions,
    delayMs,
    fixtures: bundles.map((entry) => ({ id: entry.id, name: entry.name })),
    lanes: lanes.map((lane) => ({ key: lane.key, host: lane.label, model: lane.model })),
    byLane: lanes.map((lane) => summariseV1(runs.filter((run) => run.lane === lane.key), lane)),
    byFixture: bundles.map((fixture) => ({
      fixture: fixture.id,
      verifierPassRate: rate(
        runs.filter((run) => run.fixture === fixture.id && run.verified).length,
        runs.filter((run) => run.fixture === fixture.id).length,
      ),
      violations: histogramV1(runs.filter((run) => run.fixture === fixture.id)),
    })),
  };

  console.log('lane            answered  verified  empty   fellOver  p50ms   p95ms   unsupported');
  for (const summary of report.byLane) {
    console.log(
      `${summary.lane.padEnd(15)} ${`${summary.answeredRate}%`.padEnd(9)} ${`${summary.verifierPassRate}%`.padEnd(9)} ` +
        `${`${summary.emptyContentRate}%`.padEnd(7)} ${`${summary.fallbackActivationRate}%`.padEnd(9)} ` +
        `${String(summary.latencyP50Ms ?? '-').padEnd(7)} ${String(summary.latencyP95Ms ?? '-').padEnd(7)} ` +
        `${summary.unsupportedClaimRejectionRate}%`,
    );
  }

  console.log('\nfixture  verified   top violations');
  for (const entry of report.byFixture) {
    const top = Object.entries(entry.violations)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([code, count]) => `${code} x${count}`)
      .join(', ');
    console.log(`${entry.fixture.padEnd(8)} ${`${entry.verifierPassRate}%`.padEnd(10)} ${top || '-'}`);
  }

  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nreport written to ${outputPath}`);
  }
}

function histogramV1(runs: readonly RunV1[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of runs) {
    for (const code of new Set(run.violationCodes)) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function summariseV1(runs: readonly RunV1[], lane: LaneV1) {
  const latencies = runs
    .map((run) => run.latencyMs)
    .filter((value): value is number => value !== null && value > 0);
  const rejectedOnContent = runs.filter((run) =>
    run.violationCodes.some((code) => CONTENT_VIOLATIONS_V1.includes(code)),
  ).length;
  const errors: Record<string, number> = {};
  for (const run of runs) {
    if (!run.providerErrorName) continue;
    // The message shape, never the message: a provider error can carry a URL.
    const shape = REASONING_EMPTY_V1.test(run.providerErrorName)
      ? 'empty_content_after_reasoning'
      : /timed out/.test(run.providerErrorName)
        ? 'timeout'
        : /\b(401|403)\b/.test(run.providerErrorName)
          ? 'unauthorized'
          : /\b(429|402)\b/.test(run.providerErrorName)
            ? 'rate_limited_or_unpaid'
            : /\b5\d\d\b/.test(run.providerErrorName)
              ? 'provider_5xx'
              : 'other';
    errors[shape] = (errors[shape] ?? 0) + 1;
  }
  return {
    lane: lane.key,
    host: lane.label,
    model: lane.model,
    runs: runs.length,
    answeredRate: rate(runs.filter((run) => run.answered).length, runs.length),
    verifierPassRate: rate(runs.filter((run) => run.verified).length, runs.length),
    emptyContentRate: rate(runs.filter((run) => run.emptyContent).length, runs.length),
    fallbackActivationRate: lane.isChain
      ? rate(runs.filter((run) => run.fellOver).length, runs.length)
      : 0,
    latencyP50Ms: percentileV1(latencies, 50),
    latencyP95Ms: percentileV1(latencies, 95),
    unsupportedClaimRejectionRate: rate(rejectedOnContent, runs.length),
    violations: histogramV1(runs),
    providerErrors: errors,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
