import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1,
  X402B20IntelligenceV1Schema,
  hashX402IntelligenceDataV1,
  stableHashV1,
  x402IntelligencePaymentV1,
} from '../src/index.js';

test('x402 B20 delivery binds request, evidence, price and content hash', () => {
  const draft = {
    schemaVersion: 'x402-b20-intelligence/v1' as const,
    service: 'b20_exit_analysis' as const,
    answerSource: 'stored_deterministic_evidence' as const,
    chainId: 8453 as const,
    token: {
      address: '0xb200000000000000000000000000000000000001',
      name: 'MIO',
      symbol: 'MIO',
      decimals: 18,
      variant: 'asset',
    },
    observation: null,
    analysis: { status: 'not_measured' },
    missingEvidence: ['An Exit-First observation.'],
    caveats: ['No measurement means no exit claim.'],
    generatedAt: '2026-08-14T00:00:00.000Z',
    payment: x402IntelligencePaymentV1(),
    requestHash: stableHashV1('x402-intelligence-request/v1', { token: 'mio' }),
  };
  const value = X402B20IntelligenceV1Schema.parse({
    ...draft,
    dataHash: hashX402IntelligenceDataV1(draft),
  });
  // Read from the constant, not written out again: the price lives in one
  // place and the schema's literals are what keep a catalogue and a challenge
  // from ever advertising different numbers.
  assert.equal(value.payment.amountAtomic, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
  assert.equal(value.payment.amountUsdc, MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1);
  assert.equal(value.dataHash, hashX402IntelligenceDataV1(value));
});

test('a Still loan quote binds the question, the reading, the price and its content hash', async () => {
  const { X402StillLoanQuoteV1Schema, X402SellerCatalogV1Schema, X402_INTELLIGENCE_ACTIVE_SERVICES_V1, X402_INTELLIGENCE_RETIRED_SERVICES_V1 } =
    await import('../src/index.js');
  const figures = {
    borrowAtomic: '741670000',
    healthFactor: '2000012134776922350',
    healthFactorText: '2.00',
    marginBps: 5000,
    state: 'calm' as const,
    liquidationPriceCents: '10596',
    liquidationUnreachable: false,
    borrowRateBps: 366,
    stress: [{ fallBps: 1000, healthFactor: '1800010921299230115', liquidationCanStart: false }],
  };
  const draft = {
    schemaVersion: 'x402-still-loan-quote/v1' as const,
    service: 'still_loan_quote' as const,
    answerSource: 'live_chain_read' as const,
    chainId: 8453 as const,
    question: { asset: 'NVDAc' as const, token: '0xb20000000000000000000078ee7ce2fe4908108c', decimals: 8, amount: '10', amountRaw: '1000000000', borrowUsdc: null },
    reading: { block: '58159930', blockTime: '2026-11-16T09:46:01.000Z' },
    collateral: {
      name: 'NVIDIA', symbol: 'NVDAc', kind: 'stock' as const, isin: 'US67066G1040', priceCents: '21190', priceUpdatedAt: null,
      valueCents: '211907', pledgeableRaw: '1000000000', protocolFactorBps: 7000, stillFactorBps: 3500, limits: [], earnings: null,
    },
    venue: { venue: 'aave-v4' as const, market: '0x17905db0e4a3514467539956c084180616ae7b8d', label: 'Aave V4 · Coinbase Stocks', liquidityCents: '109645815', borrowRateBps: 366 },
    terms: {
      version: '2026-11-11', stockShareBps: 5000, cryptoShareBps: 5000,
      weekend: { active: false, startsAt: '2026-11-20T21:00:00.000Z', endsAt: '2026-11-23T13:30:00.000Z', stockShareBps: 4000 },
      earnings: { stockShareBps: 4000, calendarReadAt: null },
    },
    limit: { stillLimitCents: '74167', protocolLimitCents: '148334', availableNowCents: '74167', weekdayAvailableCents: null, newLoans: 'open' as const, closedBecause: [] },
    atStillLimit: { outcome: 'computed' as const, figures },
    requested: null,
    contracts: [{ label: 'Aave V4 Coinbase Stocks spoke', address: '0x17905db0e4a3514467539956c084180616ae7b8d' }],
    missingEvidence: [],
    caveats: ['Not an offer. Still is not offered to US persons.'],
    evidencePackage: { schemaVersion: 'miorail-evidence-package/v1' as const, claims: [] },
    generatedAt: '2026-11-16T09:46:02.000Z',
    payment: x402IntelligencePaymentV1(),
    requestHash: stableHashV1('x402-intelligence-request/v1', { asset: 'NVDAc', amountRaw: '1000000000' }),
  };
  const value = X402StillLoanQuoteV1Schema.parse({ ...draft, dataHash: hashX402IntelligenceDataV1(draft) });
  assert.equal(value.dataHash, hashX402IntelligenceDataV1(value));
  // A figure changed after hashing is caught, not delivered.
  assert.throws(() => X402StillLoanQuoteV1Schema.parse({ ...value, limit: { ...value.limit, stillLimitCents: '99999' } }));

  // The price list names only what is sold, and says where each retired answer went.
  assert.deepEqual([...X402_INTELLIGENCE_ACTIVE_SERVICES_V1], ['still_loan_quote']);
  assert.equal(X402_INTELLIGENCE_RETIRED_SERVICES_V1.length, 5);
  assert.equal(X402SellerCatalogV1Schema.shape.services.safeParse([]).success, false);
});
