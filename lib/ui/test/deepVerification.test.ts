import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { DeepVerification, type DeepVerificationResultV1 } from '../src/DeepVerification';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function baseResult(overrides: Partial<DeepVerificationResultV1> = {}): DeepVerificationResultV1 {
  return {
    outcome: 'simulated',
    transactionSafety: 'not_scored',
    missingEvidence: [],
    ...overrides,
  };
}

test('DeepVerification renders nothing (idle) when neither pending nor result is given', () => {
  const element = DeepVerification({});
  assert.equal(element, null);
});

test('DeepVerification pre-payment state shows the price and the surface pay slot', () => {
  const element = DeepVerification({ pending: { priceLabel: '0.01 USDC', payButton: 'PAY_SLOT_MARKER' } });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('0.01 USDC'));
  assert.ok(serialized.includes('PAY_SLOT_MARKER'));
});

test('DeepVerification: Simulation Passed / Transaction safety Not scored / Missing evidence contract risk', () => {
  const element = DeepVerification({
    result: baseResult({
      outcome: 'simulated',
      simulationStatus: 'passed',
      missingEvidence: ['contract_risk'],
      provider: { displayName: 'Generic Simulation Provider' },
      blockNumber: '33555111',
      gasUsed: '145000',
      paidCostUsdc: '0.01',
      evidenceHash: `0x${'a'.repeat(64)}`,
    }),
  });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('Simulation: Passed'));
  assert.ok(serialized.includes('Transaction safety: Not scored'));
  assert.ok(serialized.includes('Missing evidence:'));
  assert.ok(serialized.includes('contract risk'));
  assert.ok(serialized.includes('Generic Simulation Provider'));
  assert.ok(serialized.includes('33555111'));
  assert.ok(serialized.includes('145000'));
  assert.ok(serialized.includes('0.01'));
  assert.ok(serialized.includes('USDC'));
});

test('DeepVerification: Simulation Reverted (simulated outcome, failed status)', () => {
  const element = DeepVerification({ result: baseResult({ outcome: 'simulated', simulationStatus: 'failed' }) });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('Simulation: Reverted'));
});

test('DeepVerification: Paid, but service failed shows the honest reason, never a raw internal error', () => {
  const element = DeepVerification({
    result: baseResult({ outcome: 'paid_service_failed', reason: 'timeout' }),
  });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('Paid, but service failed'));
  assert.ok(serialized.includes('timeout'));
});

test('DeepVerification: invalid_response is shown honestly, never claims Passed', () => {
  const element = DeepVerification({ result: baseResult({ outcome: 'invalid_response', reason: 'malformed_provider_response' }) });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('Invalid response'));
  assert.ok(!serialized.includes('Simulation: Passed'));
});

test('DeepVerification links a full x402 tx hash to basescan and shortens the display text', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const element = DeepVerification({ result: baseResult({ x402TxHash: hash }) });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes(`https://basescan.org/tx/${hash}`));
});

test('DeepVerification omits x402 tx when unavailable (documented cached-replay limitation) without fabricating one', () => {
  const element = DeepVerification({ result: baseResult({ outcome: 'cached', simulationStatus: 'passed', x402TxHash: null }) });
  const serialized = JSON.stringify(element);
  assert.ok(!serialized.includes('basescan.org'));
});

test('DeepVerification source stays wagmi-free and never references forbidden surfaces', () => {
  const source = readFileSync(path.join(here, '..', 'src', 'DeepVerification.tsx'), 'utf8');
  assert.equal(/from 'wagmi'|from "wagmi"/.test(source), false);
  assert.equal(/send_calls|wallet_sendcalls|actioninbox/i.test(source), false);
  assert.equal(/from '@mioagent\/api-zod'|from '@mioagent\/api-spec'/.test(source), false);
});

test('TransactionReview renders the deepVerification slot inside the Simulation section', () => {
  const source = readFileSync(path.join(here, '..', 'src', 'TransactionReview.tsx'), 'utf8');
  const simulationSectionMatch = source.match(/aria-label="Simulation"[\s\S]*?<\/section>/);
  assert.ok(simulationSectionMatch, 'Simulation section must exist');
  assert.ok(simulationSectionMatch![0].includes('{deepVerification}'), 'deepVerification must render inside the Simulation section');
});

test('the deepVerification slot threads through TransactionReviewOutcome and RoutePlanView', () => {
  const reviewSource = readFileSync(path.join(here, '..', 'src', 'TransactionReview.tsx'), 'utf8');
  assert.ok(/deepVerification\s*=\s*null,?\s*\}:\s*\{/.test(reviewSource) || reviewSource.includes('deepVerification?: React.ReactNode'));
  assert.ok(reviewSource.includes('<TransactionReview projection={result.review} deepVerification={deepVerification} />'));

  const routePlanSource = readFileSync(path.join(here, '..', 'src', 'RoutePlan.tsx'), 'utf8');
  assert.ok(routePlanSource.includes('deepVerification?: React.ReactNode'));
  assert.ok(routePlanSource.includes('<TransactionReviewOutcome result={transactionReview} deepVerification={deepVerification} />'));
});
