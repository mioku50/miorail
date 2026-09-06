import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stockSellTermsFromRunV1,
  stockSellTermsOpenV1,
  stockSellTermsWireV1,
} from './stockSellTerms.js';

// ---------------------------------------------------------------------------
// The rule this file pins: terms belong to ONE exact amount.
//
// A run that measured a different size answers a different question, and
// accepting it here would put the review page back where it was — showing
// evidence for one size beside a confirm button for another.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-06T18:00:00.000Z');
const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';

function observation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'official-cash-exit-observation/v1',
    observationHash: `0x${'11'.repeat(32)}`,
    runId: `0x${'22'.repeat(32)}`,
    chainId: 8453,
    tokenAddress: TOKEN,
    tokenSymbol: 'NVDAc',
    tokenDecimals: 8,
    scope: 'tenant_position',
    tenantId: 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70',
    sizeKind: 'actual_position',
    requestedCashAtomic: null,
    requestedTokenAtomic: '85690',
    testedTokenAtomic: '85690',
    destination: 'USDC',
    destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationDecimals: 6,
    source: 'kyberswap',
    status: 'full',
    evidenceStrength: 'router_quote',
    executionProven: false,
    buyQuote: null,
    sellQuote: {
      leg: 'sell',
      outputAtomic: '90000',
      observedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
    },
    errorCode: null,
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
    ...overrides,
  };
}

const runOf = (...observations: unknown[]) =>
  ({ runId: `0x${'22'.repeat(32)}`, observations }) as never;

test('a run that measured this exact amount establishes the terms', () => {
  const terms = stockSellTermsFromRunV1({
    run: runOf(observation()),
    tokenAmountAtomic: '85690',
    now: NOW,
  });
  assert.equal(terms.status, 'established');
  if (terms.status !== 'established') return;
  assert.equal(terms.rung.requestedTokenAtomic, '85690');
  assert.equal(terms.rung.returnedAtomic, '90000');
});

test('a run that measured a different amount answers a different question', () => {
  // The whole defect in one assertion. This run is real, current and complete
  // — and it is not about the size the holder is confirming.
  const terms = stockSellTermsFromRunV1({
    run: runOf(observation()),
    tokenAmountAtomic: '85691',
    now: NOW,
  });
  assert.equal(terms.status, 'not_established');
  if (terms.status !== 'not_established') return;
  assert.equal(terms.code, 'stock_sell_terms_not_measured');
});

test('a cash-denominated rung never answers a token question', () => {
  const terms = stockSellTermsFromRunV1({
    run: runOf(
      observation({
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: '90000',
        requestedTokenAtomic: null,
      }),
    ),
    tokenAmountAtomic: '85690',
    now: NOW,
  });
  assert.equal(terms.status, 'not_established');
});

test('routers that answered and refused this size is a market fact', () => {
  const terms = stockSellTermsFromRunV1({
    run: runOf(observation({ status: 'unavailable', sellQuote: null, errorCode: 'no_route' })),
    tokenAmountAtomic: '85690',
    now: NOW,
  });
  assert.equal(terms.status, 'no_route');
});

test('a measurement that did not complete is ours, and never a market verdict', () => {
  const terms = stockSellTermsFromRunV1({
    run: runOf(observation({ status: 'measurement_failed', sellQuote: null, errorCode: 'timeout' })),
    tokenAmountAtomic: '85690',
    now: NOW,
  });
  assert.equal(terms.status, 'not_established');
  if (terms.status !== 'not_established') return;
  assert.equal(terms.code, 'stock_sell_terms_measurement_failed');
});

test('no run at all establishes nothing, and says so as ours', () => {
  const terms = stockSellTermsFromRunV1({ run: null, tokenAmountAtomic: '85690', now: NOW });
  assert.equal(terms.status, 'not_established');
});

test('an expired quote is established evidence that is no longer open', () => {
  // Two separate facts: the routers DID answer, and their answer has a life.
  // Re-labelling an expired quote as a failed measurement would let a stale
  // price read as an outage.
  const run = runOf(observation());
  const later = new Date(NOW.getTime() + 60_000);
  const fresh = stockSellTermsFromRunV1({ run, tokenAmountAtomic: '85690', now: NOW });
  assert.equal(stockSellTermsOpenV1(fresh, NOW), true);
  const stale = stockSellTermsFromRunV1({ run, tokenAmountAtomic: '85690', now: later });
  // Past its window every source reads not_measured, so the rung is no longer
  // a current answer — and `open` refuses it either way.
  assert.equal(stockSellTermsOpenV1(stale, later), false);
});

test('the wire shape carries the size, the sources and both clocks — and no evidence hashes', () => {
  const terms = stockSellTermsFromRunV1({
    run: runOf(observation()),
    tokenAmountAtomic: '85690',
    now: NOW,
  });
  const wire = stockSellTermsWireV1(terms);
  assert.equal(wire.status, 'established');
  assert.equal(wire.tokenAmountAtomic, '85690');
  assert.equal(wire.returnedAtomic, '90000');
  assert.equal(wire.createsTransaction, false);
  assert.ok(Array.isArray(wire.sources));
  assert.ok(wire.observedAt && wire.expiresAt);
  // A field a screen does not need is a field that can be rendered wrongly.
  assert.equal('quoteEvidence' in wire, false);
  assert.equal('simulationEvidence' in wire, false);
});

test('a refusal wire says nothing was measured and carries no size', () => {
  const wire = stockSellTermsWireV1({
    status: 'not_established',
    code: 'stock_sell_terms_measurement_failed',
  });
  assert.equal(wire.sizeMeasured, false);
  assert.equal(wire.code, 'stock_sell_terms_measurement_failed');
  assert.equal('tokenAmountAtomic' in wire, false);
});
