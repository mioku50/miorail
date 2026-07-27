import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AiProofPanel,
  AiResultPanel,
  AiReviewPanel,
  AiRouteCardPanel,
  aiIneligibleCopyV1,
  aiResultHeadlineV1,
  shortAiHashV1,
  usdLabelV1,
  type AiCandidateLikeV1,
  type AiProofLikeV1,
  type AiRouteCardLikeV1,
} from '../src/console/AiPanels';

// ---------------------------------------------------------------------------
// T66C — the four Private AI screens, rendered.
//
// The assertion that matters most is negative: no screen may contain the
// prompt, and the Proof screen may not contain the answer either.
// ---------------------------------------------------------------------------

const SECRET = 'Our runway is 7 months and the Series B is not closed.';
const ANSWER = 'Cut burn by 20% before opening the round.';
const COMMITMENT = `0x${'a'.repeat(64)}`;

function candidate(overrides: Partial<AiCandidateLikeV1> = {}): AiCandidateLikeV1 {
  return {
    modelId: 'llama-3.3-70b',
    modelName: 'Llama 3.3 70B',
    privacyMode: 'private',
    estimatedCostUsd: '0.001',
    contextTokens: 65_536,
    offline: false,
    ineligibleReason: null,
    capabilities: { supportsToolCalling: true, supportsResponseSchema: true, supportsWebSearch: null },
    ...overrides,
  };
}

function card(overrides: Partial<AiRouteCardLikeV1> = {}): AiRouteCardLikeV1 {
  return {
    status: 'ready',
    recommendation: 'Best Venice model for this task under your privacy and cost limits',
    selectionPolicy: 'Chosen by: eligibility first, then stated privacy mode, then task fit, then lowest cost, then largest context.',
    taskKind: 'general_reasoning',
    selected: candidate(),
    alternatives: [candidate({ modelId: 'other-model', modelName: 'Other', ineligibleReason: 'over_spend_ceiling' })],
    dimensions: [
      { dimension: 'task_fit', score: 100, notScoredReason: null },
      { dimension: 'privacy_mode', score: 100, notScoredReason: null },
      { dimension: 'cost', score: 98, notScoredReason: null },
      { dimension: 'latency', score: null, notScoredReason: 'no_measured_runs' },
      { dimension: 'context_capacity', score: 92, notScoredReason: null },
      { dimension: 'structured_output', score: 100, notScoredReason: null },
      { dimension: 'availability', score: 100, notScoredReason: null },
    ],
    evidenceGaps: ['availability'],
    dataSentSummary: '1 message, 53 characters go to Llama 3.3 70B on Venice. Nothing else is attached.',
    retentionClaim: 'Venice states prompts are not retained.',
    unsupportedCapabilities: ['web search not stated'],
    maxSpendUsd: '0.05',
    estimatedCostUsd: '0.001',
    x402Metered: false,
    failureReason: null,
    routeCardHash: `0x${'b'.repeat(64)}`,
    expiresAt: '2026-07-27T10:02:00.000Z',
    ...overrides,
  };
}

function proof(overrides: Partial<AiProofLikeV1> = {}): AiProofLikeV1 {
  return {
    proofHash: `0x${'c'.repeat(64)}`,
    modelId: 'llama-3.3-70b',
    modelVersion: null,
    privacyMode: 'private',
    promptCommitment: COMMITMENT,
    responseHash: `0x${'d'.repeat(64)}`,
    responseChars: ANSWER.length,
    finishReason: 'stop',
    schemaValidation: 'not_requested',
    usage: {
      promptTokens: 22,
      completionTokens: 9,
      totalTokens: 31,
      actualCostUsd: '0.0000376',
      latencyMs: 640,
    },
    x402Metered: false,
    estimatedCostUsd: '0.001',
    finalStatus: 'completed',
    failureReason: null,
    observedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('no screen leaks the request', () => {
  test('the Route Card describes the prompt without quoting it', () => {
    const html = render(createElement(AiRouteCardPanel, { card: card() }));
    assert.ok(!html.includes(SECRET));
    assert.ok(!html.includes('runway'));
    assert.ok(html.includes('53 characters'));
  });

  test('the Review screen shows the commitment, not the prompt', () => {
    const html = render(
      createElement(AiReviewPanel, {
        card: card(),
        promptCommitment: COMMITMENT,
        runnable: true,
        blockedReason: null,
        runSlot: createElement('button', {}, 'Run on Venice'),
      }),
    );
    assert.ok(!html.includes(SECRET));
    assert.ok(html.includes(shortAiHashV1(COMMITMENT)));
    assert.ok(html.includes('Run on Venice'));
  });

  test('the Proof screen contains neither the prompt nor the answer', () => {
    const html = render(createElement(AiProofPanel, { proof: proof() }));
    assert.ok(!html.includes(SECRET));
    assert.ok(!html.includes(ANSWER));
    assert.ok(!html.includes('Cut burn'));
    // But the shape of the answer is stated.
    assert.ok(html.includes(`${ANSWER.length} characters`));
  });

  test('the answer lives in its own panel, separate from the proof', () => {
    const html = render(createElement(AiResultPanel, { text: ANSWER, finalStatus: 'completed' }));
    assert.ok(html.includes('Cut burn by 20%'));
  });
});

describe('the screens say what is true', () => {
  test('an unscored dimension shows its reason, never a zero', () => {
    const html = render(createElement(AiRouteCardPanel, { card: card() }));
    assert.ok(html.includes('no measured runs'));
    assert.ok(html.includes('scorerow na'));
    assert.ok(html.includes('no combined number'));
  });

  test('the card states the rule that chose the model', () => {
    const html = render(createElement(AiRouteCardPanel, { card: card() }));
    assert.ok(html.includes('eligibility first'));
  });

  test('a refused alternative keeps its reason on the card', () => {
    const html = render(createElement(AiRouteCardPanel, { card: card() }));
    assert.ok(html.includes('costs more than your limit'));
  });

  test('a card with no model still shows what was considered', () => {
    const html = render(
      createElement(AiRouteCardPanel, {
        card: card({
          status: 'constrained',
          selected: null,
          failureReason: 'Every model was refused.',
          alternatives: [candidate({ ineligibleReason: 'offline' })],
        }),
      }),
    );
    assert.ok(html.includes('no model selected'));
    assert.ok(html.includes('Every model was refused.'));
    assert.ok(html.includes('reported offline'));
  });

  test('an unstated retention claim reads as not stated, never as not retained', () => {
    const html = render(createElement(AiRouteCardPanel, { card: card({ retentionClaim: null }) }));
    assert.ok(html.includes('Not stated by the provider'));
    assert.ok(!html.includes('not retained'));
  });

  test('a truncated answer is never headlined as completed', () => {
    assert.ok(aiResultHeadlineV1('truncated').includes('cut off'));
    assert.ok(aiResultHeadlineV1('refused').includes('declined'));
    assert.ok(aiResultHeadlineV1('completed').includes('verified'));
    const html = render(createElement(AiProofPanel, { proof: proof({ finalStatus: 'truncated', finishReason: 'length' }) }));
    assert.ok(html.includes('cut off'));
    assert.ok(!html.includes('pill g'), 'only a completed answer earns the green pill');
  });

  test('the charge and the estimate are both on the proof', () => {
    const html = render(createElement(AiProofPanel, { proof: proof() }));
    assert.ok(html.includes('Actually charged'));
    assert.ok(html.includes('Was estimated'));
    assert.ok(html.includes('$0.0000376'));
  });

  test('an unreported cost says so rather than showing zero', () => {
    const html = render(
      createElement(AiProofPanel, {
        proof: proof({ usage: { ...proof().usage, actualCostUsd: null, promptTokens: null } }),
      }),
    );
    assert.ok(html.includes('Not reported'));
    assert.ok(!html.includes('$0<'));
  });

  test('a blocked review offers no run control', () => {
    const html = render(
      createElement(AiReviewPanel, {
        card: card(),
        promptCommitment: COMMITMENT,
        runnable: false,
        blockedReason: 'Private AI execution is off on this server.',
        runSlot: createElement('button', {}, 'Run on Venice'),
      }),
    );
    assert.ok(!html.includes('Run on Venice'));
    assert.ok(html.includes('execution is off'));
  });

  test('a re-read answer says it was not stored rather than showing an empty box', () => {
    const html = render(createElement(AiResultPanel, { text: '', finalStatus: 'completed' }));
    assert.ok(html.includes('was not stored'));
  });

  test('the proof explains what a commitment is', () => {
    const html = render(createElement(AiProofPanel, { proof: proof() }));
    assert.ok(html.includes('not the text of either'));
    assert.ok(html.includes('did not keep'));
  });
});

describe('small numbers keep their precision', () => {
  test('a sub-cent charge does not round to $0.00', () => {
    assert.equal(usdLabelV1('0.0000376'), '$0.0000376');
    assert.equal(usdLabelV1('0'), '$0');
    assert.equal(usdLabelV1('1.5'), '$1.50');
    assert.equal(usdLabelV1(null), 'Not reported');
  });

  test('an ineligibility reason becomes a sentence, never a raw enum', () => {
    assert.equal(aiIneligibleCopyV1('privacy_mode_insufficient'), 'privacy mode is below what you required');
    assert.equal(aiIneligibleCopyV1(null), 'eligible');
    assert.equal(aiIneligibleCopyV1('brand_new_reason'), 'brand new reason');
  });
});
