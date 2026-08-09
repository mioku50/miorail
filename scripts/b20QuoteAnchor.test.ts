import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { V4QuoteUnavailableError } from '@mioagent/swap-adapters';

import { createV4QuoteContextV1, type QuoteCallResultV1 } from './b20MeasureDeps.js';

// ---------------------------------------------------------------------------
// Quotes read at the observation block, and the one thing that must never
// happen: reading somewhere else and still saying `anchored`.
//
// This is the caveat that outlived its cause. Router quotes were read at
// `latest` because Aerodrome's reader takes no block tag; the measurement then
// moved to the Uniswap v4 Quoter, which is an ordinary `eth_call`, and the
// constant stayed. 50,937 observations in one day carried a warning about
// mixed-block data that no longer had to be mixed.
// ---------------------------------------------------------------------------

const ANCHOR_V1 = '0x2f3f0c0';
const REQUEST_V1 = { to: '0x0d5e0f97', data: '0xabcdef' };

/** A reader that answers per block tag, and records what it was asked. */
function reader(answers: Record<string, QuoteCallResultV1 | QuoteCallResultV1[]>) {
  const seen: string[] = [];
  const queues = new Map<string, QuoteCallResultV1[]>(
    Object.entries(answers).map(([tag, value]) => [tag, Array.isArray(value) ? [...value] : [value]]),
  );
  const call = async (input: { to: string; data: string; blockTag: string }): Promise<QuoteCallResultV1> => {
    seen.push(input.blockTag);
    const queue = queues.get(input.blockTag);
    if (!queue || queue.length === 0) return { ok: false, reason: 'rpc_error' };
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  };
  return { call, seen };
}

describe('a quote is read at the observation block', () => {
  test('an answering anchor is used, and the measurement says so', () => {
    const rpc = reader({ [ANCHOR_V1]: { ok: true, value: '0x2a' } });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    return quotes.call(REQUEST_V1).then((value) => {
      assert.equal(value, '0x2a');
      assert.deepEqual(rpc.seen, [ANCHOR_V1], 'the quote must not be read at latest');
      assert.equal(quotes.alignment(), 'anchored');
    });
  });

  test('a revert at the anchor is a measurement AT the anchor', async () => {
    // The Quoter reverts to return, and a token that cannot be sold reverts
    // too. Both are answers from the anchored block, so the alignment holds.
    const rpc = reader({ [ANCHOR_V1]: { ok: false, reason: 'reverted' } });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    assert.equal(await quotes.call(REQUEST_V1), '');
    assert.equal(quotes.alignment(), 'anchored');
    assert.deepEqual(rpc.seen, [ANCHOR_V1], 'a revert must not trigger a retry at latest');
  });

  test('an empty result at the anchor is also an answer', async () => {
    const rpc = reader({ [ANCHOR_V1]: { ok: false, reason: 'empty_result' } });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    assert.equal(await quotes.call(REQUEST_V1), '');
    assert.equal(quotes.alignment(), 'anchored');
  });
});

describe('a block the node no longer holds falls back, and admits it', () => {
  test('the retry goes to latest and the alignment changes with it', async () => {
    // A full node keeps roughly 128 blocks of state. A slow, rate-limited pass
    // can outlive that window mid-token, and the fix must not be to publish
    // `latest` data under an `anchored` label.
    const rpc = reader({
      [ANCHOR_V1]: { ok: false, reason: 'rpc_error' },
      latest: { ok: true, value: '0x2a' },
    });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    assert.equal(await quotes.call(REQUEST_V1), '0x2a');
    assert.deepEqual(rpc.seen, [ANCHOR_V1, 'latest']);
    assert.equal(quotes.alignment(), 'latest_not_anchored');
  });

  test('the fallback is one-way — a later anchored call does not restore the claim', async () => {
    // Once anything in this measurement was read at `latest`, its numbers no
    // longer describe one moment. A subsequent call that happens to succeed at
    // the anchor does not make the earlier ones atomic.
    const rpc = reader({
      [ANCHOR_V1]: [{ ok: false, reason: 'rpc_error' }, { ok: true, value: '0xff' }],
      latest: { ok: true, value: '0x2a' },
    });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    await quotes.call(REQUEST_V1);
    await quotes.call(REQUEST_V1);
    assert.equal(quotes.alignment(), 'latest_not_anchored');
    assert.deepEqual(rpc.seen, [ANCHOR_V1, 'latest', 'latest'], 'later quotes stay at latest');
  });

  test('a revert on the fallback still yields the pool’s answer, unanchored', async () => {
    const rpc = reader({
      [ANCHOR_V1]: { ok: false, reason: 'rpc_error' },
      latest: { ok: false, reason: 'reverted' },
    });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    assert.equal(await quotes.call(REQUEST_V1), '');
    assert.equal(quotes.alignment(), 'latest_not_anchored');
  });
});

describe('an endpoint that will not answer anywhere is degraded, never a finding', () => {
  test('both tags failing throws rather than returning "cannot be sold"', async () => {
    // The recurring defect this rail is built against: a throttled read shaped
    // like a fact about the token.
    const rpc = reader({
      [ANCHOR_V1]: { ok: false, reason: 'rpc_error' },
      latest: { ok: false, reason: 'rpc_error' },
    });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    await assert.rejects(() => quotes.call(REQUEST_V1), V4QuoteUnavailableError);
  });

  test('a rate limit degrades the measurement instead of unanchoring it', async () => {
    // The first version retried at `latest` on ANY non-answer, so the most
    // ordinary failure on this endpoint quietly turned an anchored measurement
    // into an unanchored one. Production showed it at once: 87 of 92 v4
    // observations fell back, none because the block was gone.
    for (const reason of ['rate_limited', 'rpc_timeout', 'rpc_unavailable', 'invalid_response']) {
      const rpc = reader({
        [ANCHOR_V1]: { ok: false, reason },
        latest: { ok: true, value: '0x2a' },
      });
      const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
      await assert.rejects(() => quotes.call(REQUEST_V1), V4QuoteUnavailableError, reason);
      assert.deepEqual(rpc.seen, [ANCHOR_V1], `${reason} must not be retried at latest`);
      assert.equal(quotes.alignment(), 'anchored', `${reason} must not unanchor the measurement`);
    }
  });

  test('a failure after the fallback still throws instead of answering', async () => {
    const rpc = reader({
      [ANCHOR_V1]: { ok: false, reason: 'rpc_error' },
      latest: [{ ok: true, value: '0x2a' }, { ok: false, reason: 'rpc_timeout' }],
    });
    const quotes = createV4QuoteContextV1(rpc.call, ANCHOR_V1);
    await quotes.call(REQUEST_V1);
    await assert.rejects(() => quotes.call(REQUEST_V1), V4QuoteUnavailableError);
  });
});
