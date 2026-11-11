import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QUOTE_PACER_DEFAULTS_V1, THROTTLED_PASS_EXIT_CODE_V1, createQuotePacerV1, errorCodeSummaryV1, throttledPassV1,
} from './rwaCashExitPacer.js';

// Audit OPS-3 (2026-11-10): the hourly pass asked a ladder's quotes as fast as they were answered, and
// KyberSwap, whose public limit is three a second, answered 429 to most of the pass for days.
function clock() {
  let at = 0;
  const slept: number[] = [];
  return { now: () => at, sleep: async (ms: number) => { slept.push(ms); at += ms; }, slept, advance: (ms: number) => { at += ms; } };
}

test('quotes are asked at most one every 400 ms, however fast they are answered', async () => {
  const time = clock();
  const { pacing } = createQuotePacerV1({ ...QUOTE_PACER_DEFAULTS_V1, minGapMs: 400, now: time.now, sleep: time.sleep });
  const asked: number[] = [];
  for (let quote = 0; quote < 6; quote++) {
    await pacing.beforeQuote();
    asked.push(time.now());
    time.advance(quote === 2 ? 900 : 40);
    pacing.answered(false);
  }
  // The first goes at once; a slow answer (900 ms) needs no extra wait before the next.
  assert.deepEqual(asked, [0, 400, 800, 1_700, 2_100, 2_500]);
  assert.ok(asked.every((at, index) => index === 0 || at - asked[index - 1]! >= 400));
});

test('a 429 is waited out and asked once more; the wait doubles while the throttle lasts and starts again once a quote gets through', async () => {
  const time = clock();
  const { pacing, counts } = createQuotePacerV1({ minGapMs: 400, backoffMs: 3_000, maxBackoffMs: 30_000, backoffBudgetMs: 60_000, now: time.now, sleep: time.sleep, random: () => 0.5 });
  for (const expected of [3_000, 6_000, 12_000, 24_000]) {
    assert.equal(await pacing.rateLimited(), true);
    assert.equal(time.slept.at(-1), expected);
    pacing.answered(true);
  }
  // Capped at thirty seconds, and at what is left of the pass's sixty: 15 of them.
  assert.equal(await pacing.rateLimited(), true);
  assert.equal(time.slept.at(-1), 15_000);
  // The budget is spent: the next 429 is recorded as it came, with no wait.
  assert.equal(await pacing.rateLimited(), false);
  assert.equal(time.slept.length, 5);
  assert.deepEqual(counts(), { quotes: 4, throttled: 6, retried: 5, rateLimited: 4, waitedMs: 60_000, gapMs: 400, longestGapMs: 400 });

  const fresh = createQuotePacerV1({ minGapMs: 400, backoffMs: 3_000, maxBackoffMs: 30_000, backoffBudgetMs: 600_000, now: time.now, sleep: time.sleep, random: () => 0.5 });
  await fresh.pacing.rateLimited();
  await fresh.pacing.rateLimited();
  fresh.pacing.answered(false);
  await fresh.pacing.rateLimited();
  assert.deepEqual(time.slept.slice(-3), [3_000, 6_000, 3_000]);
});

// 2026-11-11: at a fixed 400 ms the first two paced passes still ended 11% and 33% throttled, because the
// limit is the server's and other jobs ask the same router. The pace now finds itself.
test('a 429 lengthens the time between quotes by half, up to its ceiling, and thirty quotes that got through shorten it by a tenth', async () => {
  const time = clock();
  const { pacing, counts } = createQuotePacerV1({ ...QUOTE_PACER_DEFAULTS_V1, backoffBudgetMs: 0, now: time.now, sleep: time.sleep });
  const gapOfNext = async () => { await pacing.beforeQuote(); const first = time.now(); await pacing.beforeQuote(); return time.now() - first; };
  assert.equal(QUOTE_PACER_DEFAULTS_V1.minGapMs, 700);
  assert.equal(await gapOfNext(), 700);
  await pacing.rateLimited();
  assert.equal(await gapOfNext(), 1_050);
  await pacing.rateLimited();
  await pacing.rateLimited();
  // 1,575 would be past the ceiling: at 1.5 s a pass of 2,700 quotes still ends inside the unit's 90 minutes.
  assert.equal(await gapOfNext(), 1_500);
  assert.ok(2_700 * QUOTE_PACER_DEFAULTS_V1.maxGapMs + QUOTE_PACER_DEFAULTS_V1.backoffBudgetMs + 409 * 250 < 90 * 60_000);
  for (let quote = 0; quote < 29; quote++) pacing.answered(false);
  assert.equal(await gapOfNext(), 1_500);
  pacing.answered(false);
  assert.equal(await gapOfNext(), 1_350);
  // A quote that ended throttled is not one that got through, and a 429 starts the count again.
  for (let quote = 0; quote < 29; quote++) pacing.answered(false);
  await pacing.rateLimited();
  assert.equal(await gapOfNext(), 1_500);
  // It comes all the way back, and never below where it started.
  for (let quote = 0; quote < 30 * 12; quote++) pacing.answered(false);
  assert.equal(await gapOfNext(), 700);
  assert.deepEqual({ gapMs: counts().gapMs, longestGapMs: counts().longestGapMs }, { gapMs: 700, longestGapMs: 1_500 });
});

test('a pace given no ceiling stays fixed', async () => {
  const time = clock();
  const { pacing } = createQuotePacerV1({ minGapMs: 400, backoffMs: 3_000, maxBackoffMs: 30_000, backoffBudgetMs: 0, now: time.now, sleep: time.sleep });
  await pacing.rateLimited();
  await pacing.beforeQuote(); const first = time.now(); await pacing.beforeQuote();
  assert.equal(time.now() - first, 400);
});

test('the wait after a 429 is spread by half either way, so passes do not come back in step', async () => {
  for (const [random, expected] of [[0, 1_500], [0.999, 4_497], [0.25, 2_250]] as const) {
    const time = clock();
    const { pacing } = createQuotePacerV1({ ...QUOTE_PACER_DEFAULTS_V1, now: time.now, sleep: time.sleep, random: () => random });
    await pacing.rateLimited();
    assert.deepEqual(time.slept, [expected]);
  }
});

test('a pass that ended mostly rate limited is named as one, and a narrow run is not judged', () => {
  assert.equal(throttledPassV1({ quotes: 4_000, rateLimited: 1_201 }), true);
  assert.equal(throttledPassV1({ quotes: 4_000, rateLimited: 1_200 }), false);
  assert.equal(throttledPassV1({ quotes: 4_000, rateLimited: 0 }), false);
  // An operator's run over two tickers.
  assert.equal(throttledPassV1({ quotes: 24, rateLimited: 24 }), false);
  assert.equal(throttledPassV1({ quotes: 0, rateLimited: 0 }), false);
  assert.equal(THROTTLED_PASS_EXIT_CODE_V1, 75);
});

test('the journal names why rungs were not finished, the most frequent first', () => {
  assert.equal(errorCodeSummaryV1(['provider_rate_limited', null, 'cash_size_anchor_no_route', 'provider_rate_limited', undefined, 'provider_rate_limited']),
    'provider_rate_limited ×3, cash_size_anchor_no_route ×1');
  assert.equal(errorCodeSummaryV1([null, undefined]), '');
  assert.equal(errorCodeSummaryV1(['b', 'a']), 'a ×1, b ×1');
});
