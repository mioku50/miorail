import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { LlmProvider, LlmRequest } from '@mioagent/llm';

import { planB20AnswerV1 } from './b20AnswerPlan.js';
import {
  bundleEvidenceStringsV1,
  narrateB20AnswerV1,
  B20_NARRATOR_SYSTEM_V1,
  type B20EvidenceBundleV1,
} from './b20Answer.js';

// ---------------------------------------------------------------------------
// A model sits in exactly one place in this pipeline, and these tests are about
// the walls on either side of it.
//
// On the left, the planner: a pure function decides which reads a question may
// cause, from a list written in one file. On the right, the verifier and the
// fallback: whatever comes back either passes every check or is discarded in
// favour of the sentence this product already shipped.
// ---------------------------------------------------------------------------

const TOKEN = '0xb2000000000000000000003b78773002b7d292bd';

const BUNDLE: B20EvidenceBundleV1 = {
  intent: 'card',
  facts: [
    { label: 'Round trip', value: 'not measured' },
    { label: 'Bought at launch', value: '62 wallets' },
  ],
  missing: ['a supported exit route at the reference size'],
  caveats: ['This describes one stored measurement, not a recommendation.'],
};

function provider(reply: string | (() => Promise<never>)): LlmProvider {
  return {
    generate: async (_request: LlmRequest) => {
      if (typeof reply !== 'string') return reply();
      return { message: { role: 'assistant' as const, content: reply } };
    },
  };
}

describe('the planner emits only reads from its own list', () => {
  test('a question attached to a card reads that card', () => {
    const plan = planB20AnswerV1({ question: 'Why was this rejected?', tokenAddress: TOKEN });
    assert.equal(plan.intent, 'card');
    assert.deepEqual(plan.steps, [{ tool: 'card', tokenAddress: TOKEN, historyLimit: 12 }]);
    assert.equal(plan.refusal, null);
  });

  test('"how many" reads the counts rather than paging the feed', () => {
    // The whole reason Stage 05 exists. A planner that answered this with the
    // list would spend 46 round trips computing a number.
    for (const question of ['How many launches were bought and could not be sold?', 'Сколько запусков без выхода?']) {
      const plan = planB20AnswerV1({ question, tokenAddress: null });
      assert.equal(plan.intent, 'count_universe');
      assert.deepEqual(plan.steps.map((step) => step.tool), ['summary']);
    }
  });

  test('the product’s own finding is asked for in words, in either language', () => {
    for (const question of [
      'Which tokens were bought but cannot be sold?',
      'Какие токены купили, а продать нельзя?',
    ]) {
      const plan = planB20AnswerV1({ question, tokenAddress: null });
      assert.equal(plan.intent, 'find_bought_not_sellable', question);
      assert.deepEqual(plan.steps.map((step) => step.tool), ['summary', 'list']);
      const list = plan.steps[1] as Extract<typeof plan.steps[number], { tool: 'list' }>;
      assert.equal(list.standingKind, 'bought_not_sellable');
      assert.ok(list.limit <= 10, 'a plan must not ask for an unbounded page');
    }
  });

  test('a Cyrillic pattern actually matches, because \\b would not', () => {
    // `\b` is ASCII-only, so a Russian regex written with word boundaries
    // matches nothing and does so silently. This is the guard for that.
    const plan = planB20AnswerV1({ question: 'сколько всего измерено?', tokenAddress: null });
    assert.equal(plan.intent, 'count_universe');
  });

  test('an out-of-scope question is refused BEFORE anything is read', () => {
    for (const question of [
      'Will this price moon?',
      'Should I buy this?',
      'Who is the dev behind it?',
      'Is this a scam?',
      'Стоит ли покупать?',
    ]) {
      const plan = planB20AnswerV1({ question, tokenAddress: null });
      assert.equal(plan.intent, 'unsupported', question);
      assert.deepEqual(plan.steps, [], 'a refused question must cost no reads');
      assert.ok((plan.refusal ?? '').length > 40, question);
    }
  });

  test('a refusal explains what Miorail measures instead of scolding', () => {
    const plan = planB20AnswerV1({ question: 'Should I buy this?', tokenAddress: null });
    assert.match(plan.refusal!, /measurements/i);
    assert.doesNotMatch(plan.refusal!, /cannot help|I'm sorry|unable to assist/i);
  });

  test('an unrecognised question falls to the counts, not to nothing', () => {
    const plan = planB20AnswerV1({ question: 'what is going on', tokenAddress: null });
    assert.equal(plan.intent, 'count_universe');
    assert.equal(plan.refusal, null);
  });

  test('a token in hand outranks a universe phrasing', () => {
    // "How many buyers did this have" is about the card in front of you.
    const plan = planB20AnswerV1({ question: 'How many wallets bought this?', tokenAddress: TOKEN });
    assert.equal(plan.intent, 'card');
  });
});

describe('the narrator is used only when it can be checked', () => {
  test('a verifiable narration replaces the deterministic answer, and says so', async () => {
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: provider('62 wallets bought this in the launch window, and no sale priced at the reference size.'),
    });
    assert.equal(result.answerSource, 'verified_narration');
    assert.match(result.answer, /62 wallets/);
    assert.equal(result.narrationRejectedBecause, null);
  });

  test('an invented number falls back rather than being shown', async () => {
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: provider('About 1,400 wallets bought this and the round trip was 2.1%.'),
    });
    assert.equal(result.answerSource, 'deterministic_evidence');
    assert.equal(result.answer, 'A purchase priced; a sale did not.');
    assert.match((result.narrationRejectedBecause ?? []).join(' '), /numbers not present/);
  });

  test('a recommendation falls back', async () => {
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: provider('62 wallets bought this — a promising sign.'),
    });
    assert.equal(result.answerSource, 'deterministic_evidence');
  });

  test('no provider is an ordinary state, not an error', async () => {
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: null,
    });
    assert.equal(result.answerSource, 'deterministic_evidence');
    assert.deepEqual(result.narrationRejectedBecause, ['no language provider is configured']);
  });

  test('a provider that throws never leaks its cause', async () => {
    // A provider error carries a base URL, and a base URL carries a key.
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: provider(async () => {
        throw new Error('connect ECONNREFUSED https://api.example.com/v1?key=sk-secret');
      }),
    });
    assert.equal(result.answerSource, 'deterministic_evidence');
    const because = (result.narrationRejectedBecause ?? []).join(' ');
    assert.doesNotMatch(because, /sk-secret|api\.example\.com/);
  });

  test('a hung provider does not hold the request open', async () => {
    const result = await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      timeoutMs: 20,
      provider: {
        generate: () => new Promise(() => undefined),
      },
    });
    assert.equal(result.answerSource, 'deterministic_evidence');
    assert.match((result.narrationRejectedBecause ?? []).join(' '), /did not answer/);
  });
});

describe('the bundle is the model’s only context', () => {
  test('every string in the bundle is offered as evidence, including the absences', () => {
    const strings = bundleEvidenceStringsV1(BUNDLE);
    assert.ok(strings.includes('62 wallets'));
    assert.ok(strings.includes('a supported exit route at the reference size'));
    assert.ok(strings.some((item) => /not a recommendation/.test(item)));
  });

  test('the prompt carries the question and nothing about a wallet', async () => {
    let seen: LlmRequest | null = null;
    await narrateB20AnswerV1({
      question: 'What happened here?',
      bundle: BUNDLE,
      deterministic: 'A purchase priced; a sale did not.',
      provider: {
        generate: async (request) => {
          seen = request;
          return { message: { role: 'assistant' as const, content: 'No sale priced.' } };
        },
      },
    });
    const request = seen as unknown as LlmRequest;
    const prompt = request.messages.map((message) => message.content).join('\n');
    assert.match(prompt, /What happened here\?/);
    assert.match(prompt, /62 wallets/);
    // The narrator has no tools and no wallet. An argument it cannot receive is
    // a boundary that cannot be crossed by accident later.
    assert.equal(request.tools, undefined);
    assert.doesNotMatch(prompt, /0x[0-9a-f]{40}/i);
    assert.equal(request.temperature, 0);
  });

  test('the system prompt states every rule the verifier enforces', () => {
    // A rule the narrator is not told about is a fallback that happens every
    // time rather than a constraint it can satisfy.
    for (const rule of [/ONLY numbers that appear verbatim/, /Never recommend/, /Never claim an outcome/, /never a zero/]) {
      assert.match(B20_NARRATOR_SYSTEM_V1, rule);
    }
  });

  test('a bundle too wide to check is not sent at all', async () => {
    // The global console can be asked about the whole universe, and a bundle
    // of two hundred figures makes "every number must be in the evidence"
    // accept almost anything while still reporting itself as passing. The
    // provider is not called: the deterministic answer already states every
    // one of those figures exactly.
    let called = false;
    const result = await narrateB20AnswerV1({
      question: 'summarise everything',
      bundle: {
        intent: 'universe_counts',
        facts: Array.from({ length: 60 }, (_value, index) => ({ label: `row ${index}`, value: `${index * 3}` })),
        missing: [],
        caveats: ['This is a read of stored measurements.'],
      },
      deterministic: 'The deterministic sentence.',
      provider: {
        generate: async () => {
          called = true;
          return { message: { role: 'assistant' as const, content: 'anything' } };
        },
      },
    });
    assert.equal(called, false);
    assert.equal(result.answer, 'The deterministic sentence.');
    assert.match((result.narrationRejectedBecause ?? []).join(' '), /distinct figures/);
  });
});
