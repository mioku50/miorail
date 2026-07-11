import assert from 'node:assert/strict';
import test from 'node:test';
import { securityCoverageUi } from './securityUi.js';

test('failed GoPlus scan with zero verdicts cannot produce optimistic security wording', () => {
  const result = securityCoverageUi({
    portfolioSnapshot: { securityCheckedTokenCount: 0 },
    securityProvider: {
      status: 'failed',
      coverage: 'unavailable',
      failureReason: '401 for api_key=do-not-render-this',
    },
  });

  assert.equal(result.state, 'unavailable');
  assert.equal(result.label, 'Contract checks unavailable');
  assert.equal(result.retryable, true);
  assert.doesNotMatch(result.reason, /GoPlus|api_key|do-not-render-this|security context/i);
});

test('partial contract coverage remains explicit and retryable', () => {
  const result = securityCoverageUi({
    portfolioSnapshot: { securityCheckedTokenCount: 2 },
    securityProvider: { status: 'partial', coverage: 'partial' },
  });
  assert.equal(result.state, 'partial');
  assert.match(result.reason, /Only 2 token contracts/);
  assert.equal(result.retryable, true);
});
