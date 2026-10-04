import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FallbackLlmProvider,
  LLM_LINK_REST_MS_V1,
  LlmChainExhaustedError,
  LlmLinkRestV1,
  LlmProviderChainV1,
  NON_FAILOVER_STATUSES_V1,
  linkCannotServeV1,
  shouldFallOverV1,
  type NamedLlmProviderV1,
} from './fallback.js';
import { LlmHttpError, LlmTimeoutError } from './openai.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

function answering(content: string): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return { message: { role: 'assistant', content } };
    },
  };
}

function failing(error: unknown): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      throw error;
    },
  };
}

const REQUEST: LlmRequest = { messages: [{ role: 'user', content: 'hello' }] };

test('a healthy primary is never charged twice — the fallback is not called', async () => {
  const primary = answering('from primary');
  const fallback = answering('from fallback');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: primary },
    { label: 'fallback.example', provider: fallback },
  );

  const response = await chain.generate(REQUEST);
  assert.equal(response.message.content, 'from primary');
  assert.equal(fallback.calls.length, 0);
});

test('an exhausted quota falls over — this is the case the chain exists for', async () => {
  // The reported failure: a free tier ran out of credits a week earlier and
  // every route comparison had been answering 500 since.
  for (const status of [401, 402, 429, 500, 503]) {
    const fallback = answering('from fallback');
    const chain = new FallbackLlmProvider(
      { label: 'primary.example', provider: failing(new LlmHttpError(status, 'out of credits')) },
      { label: 'fallback.example', provider: fallback },
    );
    const response = await chain.generate(REQUEST);
    assert.equal(response.message.content, 'from fallback', `status ${status} must fall over`);
  }
});

test('a timeout or dropped socket falls over', async () => {
  const fallback = answering('from fallback');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new Error('fetch failed')) },
    { label: 'fallback.example', provider: fallback },
  );
  assert.equal((await chain.generate(REQUEST)).message.content, 'from fallback');
});

test('a malformed request is NOT retried against the fallback', async () => {
  // Falling over here would spend a second quota, double the latency the user
  // waits, and then report the fallback's error for a defect in the caller.
  for (const status of NON_FAILOVER_STATUSES_V1) {
    const fallback = answering('from fallback');
    const chain = new FallbackLlmProvider(
      { label: 'primary.example', provider: failing(new LlmHttpError(status, 'bad request')) },
      { label: 'fallback.example', provider: fallback },
    );
    await assert.rejects(() => chain.generate(REQUEST), new RegExp(`OpenAI API error \\(${status}\\)`));
    assert.equal(fallback.calls.length, 0, `status ${status} must not reach the fallback`);
  }
});

test('when both fail the error names both, not just the last one', async () => {
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(402, 'insufficient credits')) },
    { label: 'fallback.example', provider: failing(new LlmHttpError(429, 'rate limited')) },
  );

  await assert.rejects(
    () => chain.generate(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof LlmChainExhaustedError);
      // Without the primary's name in here, an operator investigates the
      // fallback for an outage that started at the primary.
      assert.match(error.message, /primary\.example.*insufficient credits/);
      assert.match(error.message, /fallback\.example.*rate limited/);
      assert.ok(error.primaryError instanceof LlmHttpError);
      assert.ok(error.fallbackError instanceof LlmHttpError);
      return true;
    },
  );
});

test('the fallover is announced with hosts and a reason', async () => {
  const events: Array<{ from: string; to: string; reason: string }> = [];
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(402, 'insufficient credits')) },
    { label: 'fallback.example', provider: answering('ok') },
    { onFallover: (event) => events.push(event) },
  );

  await chain.generate(REQUEST);
  assert.deepEqual(events.map((event) => [event.from, event.to]), [['primary.example', 'fallback.example']]);
  assert.match(events[0]!.reason, /insufficient credits/);
});

test('the fallback receives the request unchanged', async () => {
  const fallback = answering('ok');
  const chain = new FallbackLlmProvider(
    { label: 'primary.example', provider: failing(new LlmHttpError(500, 'down')) },
    { label: 'fallback.example', provider: fallback },
  );
  const request: LlmRequest = {
    messages: [{ role: 'user', content: 'compare routes' }],
    temperature: 0,
    tools: [{ type: 'function', function: { name: 'quote', description: 'q', parameters: {} } }],
  };
  await chain.generate(request);
  assert.deepEqual(fallback.calls[0], request);
});

test('shouldFallOverV1 treats a non-HTTP failure as the provider\'s fault', () => {
  assert.equal(shouldFallOverV1(new Error('ECONNRESET')), true);
  assert.equal(shouldFallOverV1(new LlmHttpError(404, 'no such model')), true);
  assert.equal(shouldFallOverV1(new LlmHttpError(400, 'bad')), false);
});

test('a three-link chain tries each in order and stops at the first that answers', async () => {
  const tried: string[] = [];
  const failing = (label: string): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        tried.push(label);
        throw new LlmHttpError(429, 'rate limited');
      },
    },
  });
  const answering: NamedLlmProviderV1 = {
    label: 'third',
    provider: {
      generate: async () => {
        tried.push('third');
        return { message: { role: 'assistant', content: 'ok' } };
      },
    },
  };
  const chain = new LlmProviderChainV1([failing('first'), failing('second'), answering]);
  const response = await chain.generate({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.message.content, 'ok');
  assert.deepEqual(tried, ['first', 'second', 'third']);
});

test('an exhausted three-link chain names every provider that failed', async () => {
  const failing = (label: string, status: number): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        throw new LlmHttpError(status, `${label} is unwell`);
      },
    },
  });
  const chain = new LlmProviderChainV1([
    failing('primary.example', 429),
    failing('openrouter.ai', 402),
    failing('agentrouter.org', 401),
  ]);
  await assert.rejects(
    () => chain.generate({ messages: [{ role: 'user', content: 'hi' }] }),
    (error: unknown) => {
      assert.ok(error instanceof LlmChainExhaustedError);
      assert.equal(error.failures.length, 3);
      // All three, because "agentrouter returned 401" alone sends the operator
      // to investigate the link that was never the primary.
      for (const host of ['primary.example', 'openrouter.ai', 'agentrouter.org']) {
        assert.match(error.message, new RegExp(host));
      }
      return true;
    },
  );
});

test('a malformed request stops the chain at the first link, not the last', async () => {
  // A 400 means the REQUEST is wrong. Trying two more providers would triple
  // the latency, spend two more quotas, and then blame the last one.
  let calls = 0;
  const link = (label: string): NamedLlmProviderV1 => ({
    label,
    provider: {
      generate: async () => {
        calls += 1;
        throw new LlmHttpError(400, 'bad request');
      },
    },
  });
  const chain = new LlmProviderChainV1([link('first'), link('second'), link('third')]);
  await assert.rejects(() => chain.generate({ messages: [] }), /400/);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// A budget is shared out, so a slow link cannot spend the time the next one
// needed. On 2026-09-28 a Stocks narration logged provider_did_not_answer with
// no fallover line: the primary was still thinking when the narrator's 30 s
// ran out, and the spare was never asked.
// ---------------------------------------------------------------------------

/** A link that never answers and ignores any budget it is given. */
function stalled(): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    generate(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      return new Promise<LlmResponse>(() => undefined);
    },
  };
}

test('with a budget, a stalled primary loses its turn and the spare answers in time', async () => {
  const primary = stalled();
  const spare = answering('from spare');
  const hops: string[] = [];
  const chain = new LlmProviderChainV1(
    [
      { label: 'primary.example', provider: primary },
      { label: 'spare.example', provider: spare },
    ],
    { onFallover: ({ from, to, reason }) => hops.push(`${from} -> ${to}: ${reason}`) },
  );
  const started = Date.now();
  const response = await chain.generate({ ...REQUEST, timeoutMs: 120 });
  assert.equal(response.message.content, 'from spare');
  assert.ok(Date.now() - started < 1_000);
  // Each link is told its share: half to the primary, the rest to the spare.
  const primaryShare = primary.calls[0]?.timeoutMs ?? 0;
  assert.ok(primaryShare >= 55 && primaryShare <= 60, `primary share ${primaryShare}`);
  assert.ok((spare.calls[0]?.timeoutMs ?? 0) > 0 && (spare.calls[0]?.timeoutMs ?? 0) <= 65);
  assert.deepEqual(hops, [`primary.example -> spare.example: No answer within ${primaryShare} ms`]);
});

test('a primary that answers inside its share is the only link asked', async () => {
  const primary = answering('from primary');
  const spare = answering('from spare');
  const chain = new LlmProviderChainV1(
    [
      { label: 'primary.example', provider: primary },
      { label: 'spare.example', provider: spare },
    ],
    { now: () => 0 },
  );
  const response = await chain.generate({ ...REQUEST, timeoutMs: 30_000 });
  assert.equal(response.message.content, 'from primary');
  assert.equal(primary.calls[0]?.timeoutMs, 15_000);
  assert.equal(spare.calls.length, 0);
});

test('a fast failure hands its unused share on', async () => {
  const spare = answering('from spare');
  const chain = new LlmProviderChainV1([
    { label: 'primary.example', provider: failing(new LlmHttpError(503, 'down')) },
    { label: 'spare.example', provider: spare },
  ]);
  await chain.generate({ ...REQUEST, timeoutMs: 30_000 });
  // Nearly the whole budget, not the half the primary was owed.
  assert.ok((spare.calls[0]?.timeoutMs ?? 0) > 29_000);
});

test('when every link stalls, the chain ends with the budget and names each link', async () => {
  const chain = new LlmProviderChainV1([
    { label: 'primary.example', provider: stalled() },
    { label: 'spare.example', provider: stalled() },
  ]);
  const started = Date.now();
  await assert.rejects(chain.generate({ ...REQUEST, timeoutMs: 80 }), (error: unknown) => {
    assert.ok(error instanceof LlmChainExhaustedError);
    assert.deepEqual(error.failures.map((failure) => failure.label), ['primary.example', 'spare.example']);
    assert.ok(error.failures.every((failure) => failure.error instanceof LlmTimeoutError));
    return true;
  });
  assert.ok(Date.now() - started < 1_000);
});

test('a spent budget asks nobody, and says the links were not asked', async () => {
  const primary = answering('from primary');
  const chain = new LlmProviderChainV1([{ label: 'primary.example', provider: primary }]);
  await assert.rejects(chain.generate({ ...REQUEST, timeoutMs: 0 }), /primary\.example: not asked: the budget was spent/);
  assert.equal(primary.calls.length, 0);
});

test('without a budget nothing changes: the request goes as it came', async () => {
  const primary = answering('from primary');
  const chain = new LlmProviderChainV1([{ label: 'primary.example', provider: primary }]);
  await chain.generate(REQUEST);
  assert.equal(primary.calls[0]?.timeoutMs, undefined);
});

// ---------------------------------------------------------------------------
// A link that said it cannot serve rests, so it neither costs a round trip nor
// keeps a share of every budget.
// ---------------------------------------------------------------------------

test('only an account-level refusal rests a link', () => {
  assert.equal(linkCannotServeV1(new LlmHttpError(401, 'bad key')), true);
  assert.equal(linkCannotServeV1(new LlmHttpError(402, 'budget pool quota has been exhausted')), true);
  assert.equal(linkCannotServeV1(new LlmHttpError(429, 'Rate limit exceeded', { zeroAllowance: true })), true);
  // A busy minute passes; one flagged prompt or one unsupported parameter is
  // about that request, not the link.
  assert.equal(linkCannotServeV1(new LlmHttpError(429, 'Rate limit exceeded')), false);
  assert.equal(linkCannotServeV1(new LlmHttpError(403, 'flagged')), false);
  assert.equal(linkCannotServeV1(new LlmHttpError(404, 'no endpoints')), false);
  assert.equal(linkCannotServeV1(new LlmHttpError(503, 'down')), false);
  assert.equal(linkCannotServeV1(new LlmTimeoutError(10)), false);
});

test('a dead last link rests, and the spare before it may then use the whole remainder', async () => {
  // The production shape: Mistral, with a zero allowance, is the last link.
  let clock = 1_000_000;
  const rest = new LlmLinkRestV1(() => clock);
  const rested: string[] = [];
  const primary = failing(new LlmHttpError(503, 'down'));
  let spareFails = true;
  const spareCalls: LlmRequest[] = [];
  const spare: LlmProvider = {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      spareCalls.push(request);
      if (spareFails) throw new LlmHttpError(503, 'down');
      return { message: { role: 'assistant', content: 'from spare' } };
    },
  };
  const dead = failing(new LlmHttpError(429, 'Rate limit exceeded', { zeroAllowance: true }));
  const chain = () =>
    new LlmProviderChainV1(
      [
        { label: 'primary.example', provider: primary },
        { label: 'spare.example', provider: spare },
        { label: 'dead.example', provider: dead },
      ],
      { rest, onRest: ({ label }) => rested.push(label), now: () => clock },
    );

  // While the dead link is awake, the spare before it may spend half of what
  // is left (the primary failed at once, so that is half of all 30 s), and
  // the dead link is owed the rest.
  await assert.rejects(chain().generate({ ...REQUEST, timeoutMs: 30_000 }), LlmChainExhaustedError);
  assert.equal(primary.calls[0]?.timeoutMs, 15_000);
  assert.equal(spareCalls[0]?.timeoutMs, 15_000);
  assert.equal(dead.calls.length, 1);
  assert.deepEqual(rested, ['dead.example']);

  // Resting, it is neither asked nor owed anything: in a NEW chain, as the
  // factory builds them, the spare is the last link and may use it all.
  spareFails = false;
  assert.equal((await chain().generate({ ...REQUEST, timeoutMs: 30_000 })).message.content, 'from spare');
  assert.equal(spareCalls[1]?.timeoutMs, 30_000);
  assert.equal(dead.calls.length, 1);

  // After its rest it is a link again, and owed its share again.
  clock += LLM_LINK_REST_MS_V1;
  assert.equal(rest.resting('dead.example'), false);
  await chain().generate({ ...REQUEST, timeoutMs: 30_000 });
  assert.equal(spareCalls[2]?.timeoutMs, 15_000);
});

test('an ordinary 429 does not rest a link', async () => {
  const rest = new LlmLinkRestV1();
  const busy = failing(new LlmHttpError(429, 'Rate limit exceeded'));
  const chain = new LlmProviderChainV1(
    [
      { label: 'busy.example', provider: busy },
      { label: 'spare.example', provider: answering('from spare') },
    ],
    { rest },
  );
  await chain.generate(REQUEST);
  await chain.generate(REQUEST);
  assert.equal(busy.calls.length, 2);
  assert.equal(rest.resting('busy.example'), false);
});

test('when every link rests, they are all asked anyway', async () => {
  const rest = new LlmLinkRestV1();
  rest.rest('primary.example');
  rest.rest('spare.example');
  const primary = answering('from primary');
  const chain = new LlmProviderChainV1(
    [
      { label: 'primary.example', provider: primary },
      { label: 'spare.example', provider: answering('from spare') },
    ],
    { rest },
  );
  assert.equal((await chain.generate(REQUEST)).message.content, 'from primary');
});
