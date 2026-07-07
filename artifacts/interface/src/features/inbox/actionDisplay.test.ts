import test from 'node:test';
import assert from 'node:assert';
import { getStateVerifiedAllowanceZeroNotice, shouldShowConfirmCta } from './actionDisplay';

test('T19.10: verified-zero revoke action shows state proof copy and no confirm CTA', () => {
  const action = {
    status: 'executed',
    executionPayload: {
      chain: 'eip155:8453',
      actionType: 'revoke_approval',
      calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b3' }],
    },
    metadata: {
      actionType: 'revoke_approval',
      executionProof: {
        type: 'state_verified_allowance_zero',
        allowanceAfter: '0',
      },
    },
  };

  assert.deepStrictEqual(getStateVerifiedAllowanceZeroNotice(action), {
    title: 'Revocation effective — allowance is now 0',
    label: 'State proof only — transaction hash was not captured',
  });
  assert.strictEqual(shouldShowConfirmCta(action), false);
});

test('T19.10: pending revoke action with calls still shows confirm CTA', () => {
  const action = {
    status: 'pending',
    executionPayload: {
      chain: 'eip155:8453',
      actionType: 'revoke_approval',
      calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b3' }],
    },
    metadata: {
      actionType: 'revoke_approval',
      userConfirmable: true,
    },
  };

  assert.strictEqual(getStateVerifiedAllowanceZeroNotice(action), null);
  assert.strictEqual(shouldShowConfirmCta(action), true);
});
