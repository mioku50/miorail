import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  HANDOFF_CASH_ADDRESS_V1,
  StockExecutionHandoffV1Schema,
  stockExecutionGoalSentenceV1,
  stockExecutionHandoffV1,
  stockExecutionSizeNoteV1,
} from '../src/executionHandoff.js';
import { MarketRealityResponseV2Schema, type MarketRealityResponseV2 } from '../src/contracts.js';

const H = `0x${'11'.repeat(32)}`;
const POLICY = `0x${'22'.repeat(32)}`;
const COINBASE = '0xb20000000000000000000078ee7ce2fe4908108c';
const BACKED_DIRECT = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const BACKED_WRAPPER = '0x7e8101a1c322d394b3961498c7d40d2dfa94c392';
const UNDERLYING = 'security:isin:US67066G1040';
const NOW = new Date('2026-08-29T12:00:00.000Z');

function supply(state: 'positive_supply' | 'zero_supply' | 'supply_unknown') {
  const established = state !== 'supply_unknown';
  return {
    state,
    totalSupplyAtomic: established ? (state === 'zero_supply' ? '0' : '1000000000000000000') : null,
    decimals: established ? 18 : null,
    normalization: 'raw_erc20_total_supply' as const,
    blockNumber: established ? '50600000' : null,
    blockHash: established ? H : null,
    observedAt: established ? '2026-08-29T11:59:00.000Z' : null,
    evidenceHash: established ? H : null,
    source: 'erc20_total_supply' as const,
    readOutcome: established ? ('success' as const) : ('rpc_failure' as const),
    fresh: established,
    reason: established ? null : 'The supply read did not complete.',
  };
}

function reference() {
  return {
    status: 'unknown' as const,
    session: 'unknown' as const,
    marketSession: 'unknown' as const,
    publicationMode: 'unknown' as const,
    valueAtomic: null,
    decimals: null,
    observedAt: null,
    referenceUpdatedAt: null,
    freshness: 'unknown' as const,
    referenceSource: null,
    referenceAddress: null,
    calendar: null,
    evidence: null,
    comparable: false,
    reasonCode: 'reference_adapter_not_configured',
    reason: 'No reviewed adapter.',
  };
}

function representation(over: Record<string, unknown> = {}) {
  return {
    tokenAddress: COINBASE,
    issuerId: 'coinbase' as const,
    issuerInstrumentKey: `coinbase:b20_address:${COINBASE}`,
    representationKind: 'b20_asset' as const,
    supply: supply('positive_supply'),
    status: 'not_measured' as const,
    routePolicyKey: POLICY,
    exactTestedTokenAtomic: null,
    normalizedExposureAtomic: null,
    normalizedExposureDecimals: null,
    normalization: 'not_established' as const,
    returnedCashAtomic: null,
    effectivePriceAtomic: null,
    effectivePriceDecimals: null,
    premiumDiscountBps: null,
    reference: reference(),
    basis: {
      policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1' as const,
      status: 'withheld' as const,
      kind: 'withheld' as const,
      premiumDiscountBps: null,
      reasonCode: 'measurement_failed',
      reason: 'Fixture basis is withheld.',
    },
    sources: [
      {
        source: 'kyberswap',
        status: 'not_measured' as const,
        errorCode: null,
        quoteEvidence: null,
        simulationEvidence: {
          kind: 'route_simulation' as const,
          status: 'not_simulated' as const,
          evidenceHash: null,
        },
      },
    ],
    observedAt: null,
    expiresAt: null,
    liveness: 'never_measured' as const,
    lastObservation: null,
    ...over,
  };
}

const questionV1 = {
  chainId: 8453 as const,
  underlyingKey: UNDERLYING,
  direction: 'buy' as const,
  requestedCashAtomic: '1000000000',
  cashAsset: 'USDC' as const,
  cashAddress: HANDOFF_CASH_ADDRESS_V1,
  cashDecimals: 6,
  destination: 'USDC' as const,
  exactSizeOnly: true as const,
  baseOnly: true as const,
};

function response(over: Record<string, unknown> = {}): MarketRealityResponseV2 {
  return MarketRealityResponseV2Schema.parse({
    schemaVersion: 'market-reality/v2',
    question: questionV1,
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
      reason: 'Fixture coverage is incomplete.',
    },
    numericComparisonCoverage: {
      policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
      eligibleRepresentationCount: 2,
      pricedRepresentationCount: 0,
      status: 'incomplete',
      reason: 'Fixture coverage is incomplete.',
    },
    ranking: {
      status: 'withheld',
      policy: 'withheld_phase_10b8',
      orderedTokenAddresses: [],
      reason: 'Ranking is withheld.',
    },
    quoteEvidenceIsExecutionProof: false,
    representations: [
      representation(),
      representation({
        tokenAddress: BACKED_DIRECT,
        issuerId: 'backed',
        issuerInstrumentKey: 'backed:instrument:nvda',
        representationKind: 'rebasing_erc20',
      }),
      representation({
        tokenAddress: BACKED_WRAPPER,
        issuerId: 'backed',
        issuerInstrumentKey: 'backed:instrument:wnvda',
        representationKind: 'non_rebasing_erc4626_wrapper',
        supply: supply('zero_supply'),
      }),
    ],
    assembledAt: NOW.toISOString(),
    ...over,
  });
}

function ready(over: Record<string, unknown> = {}, tokenAddress = COINBASE) {
  const result = stockExecutionHandoffV1({
    response: response(over),
    tokenAddress,
    now: NOW,
  });
  assert.equal(result.status, 'ready', `expected a handoff, got ${JSON.stringify(result)}`);
  assert.ok(result.status === 'ready');
  return result.handoff;
}

describe('Phase 17.4 — the reader names a side', () => {
  test('preparing a buy does not re-ask the board\u2019s question', () => {
    // The card used to carry one button and take its direction from the page's
    // Sell/Buy toggle, so a reader who wanted to buy had to change the question
    // the WHOLE board was answering — which silently re-measured every other
    // representation on screen.
    const sellBoard = response({ question: { ...questionV1, direction: 'sell' } });
    const buy = stockExecutionHandoffV1({
      response: sellBoard,
      tokenAddress: COINBASE,
      direction: 'buy',
      now: NOW,
    });
    assert.equal(buy.status, 'ready');
    assert.equal(buy.status === 'ready' && buy.handoff.direction, 'buy');
    // The size is the one already on screen; only the side moved.
    assert.equal(
      buy.status === 'ready' && buy.handoff.requestedCashAtomic,
      sellBoard.question.requestedCashAtomic,
    );
  });

  test('the size basis follows the side being prepared, not the board', () => {
    // A BUY spends an exact number of USDC atoms and is sized before anything
    // quotes it. A SELL of "cash worth" has no token amount until something
    // prices it, and that quote expires in about twenty seconds — carrying it
    // forward would be spending an expired quote as executable state.
        const buy = stockExecutionHandoffV1({
      response: response({ question: { ...questionV1, direction: 'sell' } }),
      tokenAddress: COINBASE,
      direction: 'buy',
      now: NOW,
    });
    assert.equal(buy.status === 'ready' && buy.handoff.sizeBasis, 'exact_cash_in');
    const sell = stockExecutionHandoffV1({
      response: response({ question: { ...questionV1, direction: 'buy' } }),
      tokenAddress: COINBASE,
      direction: 'sell',
      now: NOW,
    });
    assert.equal(sell.status === 'ready' && sell.handoff.sizeBasis, 'cash_equivalent_requires_replan');
  });

  test('naming a side is not permission to execute one', () => {
    // Every refusal and every literal is unchanged. A prepare button on a
    // zero-supply contract must refuse exactly as the inspector did.
    const built = stockExecutionHandoffV1({
      response: response({ question: { ...questionV1, direction: 'sell' } }),
      tokenAddress: COINBASE,
      direction: 'buy',
      now: NOW,
    });
    assert.ok(built.status === 'ready');
    if (built.status !== 'ready') return;
    assert.equal(built.handoff.createsApproval, false);
    assert.equal(built.handoff.createsCalldata, false);
    assert.equal(built.handoff.createsTransaction, false);
    assert.equal(built.handoff.quoteIsExecutionEvidence, false);
    assert.equal(built.handoff.intent, 'inspect_route');
  });

  test('an omitted side still follows the board', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const built = stockExecutionHandoffV1({
        response: response({ question: { ...questionV1, direction } }),
        tokenAddress: COINBASE,
        now: NOW,
      });
      assert.equal(built.status === 'ready' && built.handoff.direction, direction);
    }
  });
});

describe('Phase 13.1 — Stocks to advanced execution', () => {
  // §11.1
  test('the exact address survives the handoff, with its identity attached', () => {
    const handoff = ready();
    assert.equal(handoff.tokenAddress, COINBASE);
    assert.equal(handoff.caip10, `eip155:8453:${COINBASE}`);
    assert.equal(handoff.chainId, 8453);
    assert.equal(handoff.underlyingKey, UNDERLYING);
    assert.equal(handoff.issuerId, 'coinbase');
    assert.equal(handoff.representationKind, 'b20_asset');
    assert.equal(handoff.direction, 'buy');
    assert.equal(handoff.requestedCashAtomic, '1000000000');
    assert.equal(handoff.destination, 'USDC');
    assert.equal(handoff.routePolicyKey, POLICY);
    assert.deepEqual(handoff.approvedSources, ['kyberswap']);
  });

  // §11.2
  test('a ticker cannot create an execution intent', () => {
    for (const selector of ['NVDA', 'NVDAc', 'nvidia', 'NVIDIA Corporation', '']) {
      const result = stockExecutionHandoffV1({
        response: response(),
        tokenAddress: selector,
        now: NOW,
      });
      assert.equal(result.status, 'refused', `${selector} must not select a representation`);
      assert.ok(result.status === 'refused');
      assert.equal(result.reason, 'representation_not_reviewed');
    }
    // And no name of any kind reaches the planner's sentence.
    const sentence = stockExecutionGoalSentenceV1(ready());
    assert.doesNotMatch(sentence, /NVDA|nvidia|coinbase|backed/i);
    assert.match(sentence, new RegExp(COINBASE));
  });

  // §11.3
  test('the Coinbase representation is never substituted with Backed', () => {
    const handoff = ready();
    assert.equal(handoff.tokenAddress, COINBASE);
    assert.notEqual(handoff.tokenAddress, BACKED_DIRECT);
    assert.match(stockExecutionGoalSentenceV1(handoff), new RegExp(COINBASE));
    assert.doesNotMatch(stockExecutionGoalSentenceV1(handoff), new RegExp(BACKED_DIRECT));
  });

  // §11.4 and §6
  test('the direct Backed representation is never substituted with its wrapper', () => {
    const direct = ready({}, BACKED_DIRECT);
    assert.equal(direct.tokenAddress, BACKED_DIRECT);
    assert.equal(direct.representationKind, 'rebasing_erc20');
    assert.doesNotMatch(stockExecutionGoalSentenceV1(direct), new RegExp(BACKED_WRAPPER));
  });

  // §11.5 and §6
  test('a zero-supply representation refuses instead of redirecting to what it wraps', () => {
    const result = stockExecutionHandoffV1({
      response: response(),
      tokenAddress: BACKED_WRAPPER,
      now: NOW,
    });
    assert.equal(result.status, 'refused');
    assert.ok(result.status === 'refused');
    assert.equal(result.reason, 'zero_supply_representation');
    // The refusal names the address the reader chose and promises no other.
    assert.match(result.detail, /stays on the address you chose/i);
    assert.doesNotMatch(result.detail, new RegExp(BACKED_DIRECT));
  });

  test('supply that could not be established refuses too, and says so differently', () => {
    const unknown = stockExecutionHandoffV1({
      response: response({
        representations: [representation({ supply: supply('supply_unknown') })],
      }),
      tokenAddress: COINBASE,
      now: NOW,
    });
    assert.ok(unknown.status === 'refused');
    assert.equal(unknown.reason, 'supply_not_established');
  });

  // §11.6 and §5
  test('an expired Market Reality quote is carried as expired, never as readiness', () => {
    const expired = ready({
      representations: [
        representation({
          status: 'not_measured',
          liveness: 'history_only',
          observedAt: '2026-08-29T11:59:00.000Z',
          expiresAt: '2026-08-29T11:59:20.000Z',
          lastObservation: {
            status: 'no_route',
            source: 'kyberswap',
            errorCode: 'provider_no_route',
            observedAt: '2026-08-29T11:59:00.000Z',
            expiresAt: '2026-08-29T11:59:20.000Z',
            open: false,
            returnedCashAtomic: null,
          },
        }),
      ],
    });
    assert.equal(expired.evidenceState, 'expired_quote');
    assert.equal(expired.quoteIsExecutionEvidence, false);
    // The expired quote's own numbers are not carried at all.
    assert.equal('exactTestedTokenAtomic' in expired, false);
    assert.equal('returnedCashAtomic' in expired, false);
  });

  test('a fresh quote is still not readiness, only a fresher label', () => {
    const fresh = ready({
      representations: [
        representation({
          expiresAt: '2026-08-29T12:00:20.000Z',
          observedAt: '2026-08-29T12:00:00.000Z',
          liveness: 'history_only',
          lastObservation: {
            status: 'no_route',
            source: 'kyberswap',
            errorCode: 'provider_no_route',
            observedAt: '2026-08-29T12:00:00.000Z',
            expiresAt: '2026-08-29T12:00:20.000Z',
            open: true,
            returnedCashAtomic: null,
          },
        }),
      ],
    });
    assert.equal(fresh.evidenceState, 'fresh_quote');
    assert.equal(fresh.quoteIsExecutionEvidence, false);
    assert.equal(fresh.createsCalldata, false);
  });

  // §11.7 / §11.8 / §11.9 / §11.10
  test('the handoff is an intent to look, and says so in literals', () => {
    const handoff = ready();
    assert.equal(handoff.intent, 'inspect_route');
    assert.equal(handoff.createsApproval, false);
    assert.equal(handoff.createsCalldata, false);
    assert.equal(handoff.createsTransaction, false);
    assert.equal(handoff.quoteIsExecutionEvidence, false);

    // Nothing in the payload can carry a transaction, a signature or a
    // simulation result: the schema is strict and none of those are in it.
    for (const forbidden of [
      'calldata',
      'data',
      'to',
      'value',
      'signature',
      'signer',
      'approval',
      'simulation',
      'blueprintId',
      'walletAddress',
    ]) {
      assert.equal(
        StockExecutionHandoffV1Schema.safeParse({ ...handoff, [forbidden]: '0x00' }).success,
        false,
        `${forbidden} must not be accepted into a handoff`,
      );
    }
  });

  const SELL_QUESTION = {
    chainId: 8453,
    underlyingKey: UNDERLYING,
    direction: 'sell' as const,
    requestedCashAtomic: '1000000000',
    cashAsset: 'USDC' as const,
    cashAddress: HANDOFF_CASH_ADDRESS_V1,
    cashDecimals: 6,
    destination: 'USDC' as const,
    exactSizeOnly: true,
    baseOnly: true,
  };

  // §11.6 — a SELL nothing has priced still carries no token amount, and the
  // planner asking is then the honest outcome.
  test('a SELL nothing priced carries no token amount, and the sentence names none', () => {
    const sell = ready({ question: SELL_QUESTION });
    assert.equal(sell.sizeBasis, 'cash_equivalent_requires_replan');
    assert.equal(sell.exactTokenAtomic, null);
    assert.equal(sell.tokenDecimals, null);
    assert.equal(sell.sizeObservedAt, null);
    const sentence = stockExecutionGoalSentenceV1(sell);
    assert.equal(sentence, `Swap ${COINBASE} to ${HANDOFF_CASH_ADDRESS_V1} on Base`);
    assert.doesNotMatch(sentence, /1000|worth/);
    assert.match(stockExecutionSizeNoteV1(sell), /no token amount to sell yet/);
  });

  // The defect this replaces: the planner answered `amount_required` — "what
  // exact amount should be swapped?" — to a reader whose screen had already
  // established the number, and who cannot convert dollars into tokens by hand.
  test('a SELL carries the token amount this board established', () => {
    const sell = ready({
      question: SELL_QUESTION,
      representations: [
        representation({
          exactTestedTokenAtomic: '3114520000000000000',
          observedAt: '2026-08-29T11:59:50.000Z',
          expiresAt: '2026-08-29T12:00:10.000Z',
        }),
      ],
    });
    assert.equal(sell.sizeBasis, 'observed_token_amount');
    assert.equal(sell.exactTokenAtomic, '3114520000000000000');
    assert.equal(sell.tokenDecimals, 18);
    assert.equal(sell.sizeObservedAt, '2026-08-29T11:59:50.000Z');
    assert.equal(
      stockExecutionGoalSentenceV1(sell),
      `Swap 3.11452 ${COINBASE} to ${HANDOFF_CASH_ADDRESS_V1} on Base`,
    );
    // The SIZE travels; the PRICE does not. What those tokens fetch is
    // re-established against fresh routes, and the sentence never states it.
    assert.doesNotMatch(stockExecutionGoalSentenceV1(sell), /\$|worth|USD/);
    assert.match(stockExecutionSizeNoteV1(sell), /Selling 3\.11452 tokens/);
    assert.match(stockExecutionSizeNoteV1(sell), /priced again on fresh routes/);
  });

  test('a BUY is sized in cash and may not carry a token amount', () => {
    assert.equal(ready().exactTokenAtomic, null);
    assert.equal(
      StockExecutionHandoffV1Schema.safeParse({
        ...ready(),
        exactTokenAtomic: '1',
        tokenDecimals: 18,
        sizeObservedAt: '2026-08-29T11:59:50.000Z',
      }).success,
      false,
      'a BUY carrying a token amount must be refused',
    );
  });

  test('a carried amount travels with its decimals and its instant', () => {
    const sell = ready({
      question: SELL_QUESTION,
      representations: [
        representation({
          exactTestedTokenAtomic: '3114520000000000000',
          observedAt: '2026-08-29T11:59:50.000Z',
          expiresAt: '2026-08-29T12:00:10.000Z',
        }),
      ],
    });
    for (const half of ['tokenDecimals', 'sizeObservedAt'] as const) {
      assert.equal(
        StockExecutionHandoffV1Schema.safeParse({ ...sell, [half]: null }).success,
        false,
        `${half} must travel with the amount`,
      );
    }
  });

  test('a BUY spends an exact cash amount, and the sentence carries it', () => {
    const buy = ready();
    assert.equal(buy.sizeBasis, 'exact_cash_in');
    assert.equal(
      stockExecutionGoalSentenceV1(buy),
      `Swap 1000 ${HANDOFF_CASH_ADDRESS_V1} to ${COINBASE} on Base`,
    );
    assert.match(stockExecutionSizeNoteV1(buy), /exact before anything is quoted/);
  });

  test('a representation with no reviewed route policy has nothing to hand across', () => {
    const result = stockExecutionHandoffV1({
      response: response({ representations: [representation({ routePolicyKey: null })] }),
      tokenAddress: COINBASE,
      now: NOW,
    });
    assert.ok(result.status === 'refused');
    assert.equal(result.reason, 'route_policy_not_established');
  });

  test('the sentence names addresses only, in both directions', () => {
    for (const handoff of [ready()]) {
      const sentence = stockExecutionGoalSentenceV1(handoff);
      const addresses = sentence.match(/0x[0-9a-f]{40}/g) ?? [];
      assert.equal(addresses.length, 2, 'exactly the token and the cash asset');
      assert.ok(addresses.includes(COINBASE));
      assert.ok(addresses.includes(HANDOFF_CASH_ADDRESS_V1));
    }
  });
});
