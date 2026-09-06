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
