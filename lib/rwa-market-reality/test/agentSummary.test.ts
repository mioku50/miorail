import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { marketRealityAgentSummaryV1 } from '../src/agentSummary.js';
import { MarketRealityResponseV2Schema } from '../src/contracts.js';
import type { MarketRealityResponseV2 } from '../src/contracts.js';

// ---------------------------------------------------------------------------
// The summary exists so an external model does not have to invent one.
//
// What is pinned here is the sentence it must never produce: `0 of 2` is a fact
// about Miorail's freshness at one exact size, and "NVIDIA has no liquidity" is
// what a model reaching for English turns that into.
// ---------------------------------------------------------------------------

const FORBIDDEN_V1 = [
  /\bno liquidity\b/i,
  /\billiquid\b/i,
  /\buntradeable\b|\buntradable\b/i,
  /\bcannot be (sold|traded|bought)\b/i,
  /\bbest\b/i,
  /\bcheaper\b/i,
  /\bbetter\b/i,
  /\brecommend/i,
];

function response(over: Record<string, unknown> = {}): MarketRealityResponseV2 {
  return MarketRealityResponseV2Schema.parse({
    schemaVersion: 'market-reality/v2',
    question: {
      chainId: 8453,
      underlyingKey: 'security:isin:US67066G1040',
      direction: 'sell',
      requestedCashAtomic: '1000000000',
      cashAsset: 'USDC',
      cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      cashDecimals: 6,
      destination: 'USDC',
      exactSizeOnly: true,
      baseOnly: true,
    },
    universe: {
      reviewedRepresentationCount: 3,
      positiveSupplyRepresentationCount: 2,
      zeroSupplyRepresentationCount: 1,
      unresolvedSupplyRepresentationCount: 0,
    },
    marketOutcomeCoverage: {
      policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
      eligibleRepresentationCount: 2,
      establishedOutcomeCount: 0,
      status: 'incomplete',
      reason: 'No positive-supply representation has a fresh exact-direction outcome.',
    },
    numericComparisonCoverage: {
      policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
      eligibleRepresentationCount: 2,
      pricedRepresentationCount: 0,
      status: 'incomplete',
      reason: 'No fresh normalized quote.',
    },
    ranking: {
      status: 'withheld',
      policy: 'withheld_phase_10b8',
      orderedTokenAddresses: [],
      reason: 'coverage_incomplete',
    },
    quoteEvidenceIsExecutionProof: false,
    representations: [],
    assembledAt: '2026-08-30T12:00:00.000Z',
    ...over,
  });
}

describe('Miorail reads its own comparison', () => {
  test('an absent answer is about our freshness, never about the market', () => {
    const summary = marketRealityAgentSummaryV1(response());
    assert.equal(summary.currentComparisonAvailable, false);
    assert.match(summary.summary, /reviewed 3 representations/);
    assert.match(summary.summary, /2 have positive supply/);
    assert.match(summary.summary, /1 has zero observed supply/);
    assert.match(summary.summary, /nothing reliable to compare right now/);
    // "either" takes a singular noun. Production read "either active
    // representations" on the first deploy of this sentence.
    assert.match(summary.summary, /either active representation at/);
    assert.doesNotMatch(summary.summary, /either active representations/);
    // The size and direction travel with the claim: an answer about $1,000 SELL
    // is not an answer about $100,000.
    assert.match(summary.summary, /\$1,000 SELL → USDC/);

    const spoken = [summary.summary, summary.nextSafeStep, summary.notEstablished].join(' ');
    for (const forbidden of FORBIDDEN_V1) {
      // `notEstablished` names these words in order to forbid them, so the
      // scan runs on what Miorail ASSERTS, not on what it warns against.
      assert.doesNotMatch(`${summary.summary} ${summary.nextSafeStep}`, forbidden, String(forbidden));
    }
    assert.match(summary.notEstablished, /not about whether the security trades/);
    assert.ok(spoken.length > 0);
  });

  test('a complete comparison says so, and still chooses nothing', () => {
    const summary = marketRealityAgentSummaryV1(
      response({
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 2,
          establishedOutcomeCount: 2,
          status: 'complete',
          reason: null,
        },
      }),
    );
    assert.equal(summary.currentComparisonAvailable, true);
    assert.match(summary.summary, /current market answer for all 2/);
    assert.match(summary.nextSafeStep, /does not choose a winner/);
    for (const forbidden of [/\bbest\b/i, /\bcheaper\b/i, /\brecommend/i]) {
      assert.doesNotMatch(summary.nextSafeStep, forbidden);
    }
  });

  test('the summary quotes no cash figure', () => {
    const summary = marketRealityAgentSummaryV1(response());
    // The requested size is the user's own question and may be repeated. Any
    // OTHER money figure would be a term in conversational prose, which is the
    // one place Miorail cannot keep it honest.
    const money = [...summary.summary.matchAll(/\$[\d,]+(?:\.\d+)?/g)].map((match) => match[0]);
    assert.deepEqual(money, ['$1,000']);
  });

  test('nothing outstanding is stated as membership, not as a verdict', () => {
    const summary = marketRealityAgentSummaryV1(response());
    assert.match(summary.summary, /zero observed supply/);
    assert.doesNotMatch(summary.summary, /dead|delisted|worthless/i);
  });

  test('the sentence agrees with itself at every count', () => {
    // Three eligible, none answered: "either" no longer applies.
    const many = marketRealityAgentSummaryV1(
      response({
        universe: {
          reviewedRepresentationCount: 4,
          positiveSupplyRepresentationCount: 3,
          zeroSupplyRepresentationCount: 1,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 3,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'none',
        },
      }),
    );
    assert.match(many.summary, /any of the 3 active representations/);

    // Partially answered: the remainder is counted, and agrees in number.
    const partial = marketRealityAgentSummaryV1(
      response({
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 2,
          establishedOutcomeCount: 1,
          status: 'incomplete',
          reason: 'one missing',
        },
      }),
    );
    assert.match(partial.summary, /1 of 2 active representation at/);
    assert.doesNotMatch(partial.summary, /representations at/);

    // Nothing eligible at all is its own sentence, not a count of zero.
    const none = marketRealityAgentSummaryV1(
      response({
        universe: {
          reviewedRepresentationCount: 1,
          positiveSupplyRepresentationCount: 0,
          zeroSupplyRepresentationCount: 1,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 0,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'no eligible representation',
        },
      }),
    );
    assert.match(none.summary, /nothing to compare/);
    assert.doesNotMatch(none.summary, /either/);
  });
});
