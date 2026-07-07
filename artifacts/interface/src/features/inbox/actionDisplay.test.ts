import test from 'node:test';
import assert from 'node:assert';
import {
  filterInboxActions,
  getRevokeExecutionNotice,
  getStateVerifiedAllowanceZeroNotice,
  shouldShowConfirmCta,
} from './actionDisplay';

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

test('T19.12: executed revoke action renders wallet receipt proof with tx and batch', () => {
  const action = {
    status: 'executed',
    txHash: '0xabc1230000000000000000000000000000000000000000000000000000000000',
    batchId: '0xbatch1234567890abcdef',
    executionPayload: {
      actionType: 'revoke_approval',
      calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
    },
    metadata: {
      actionType: 'revoke_approval',
      allowanceAfter: '0',
      executionProof: {
        type: 'wallet_confirmation_receipt',
        txHash: '0xabc1230000000000000000000000000000000000000000000000000000000000',
        batchId: '0xbatch1234567890abcdef',
        statusCode: 200,
        allowanceAfter: '0',
        source: 'metadata.confirmation',
      },
    },
  };

  const notice = getRevokeExecutionNotice(action);
  assert.strictEqual(notice?.title, 'Revocation effective — allowance is now 0');
  assert.ok(notice?.txHashUrl?.includes('basescan.org/tx/0xabc123'));
  assert.strictEqual(notice?.stateOnlyLabel, undefined);
  assert.ok(notice?.shortBatchId);
  assert.strictEqual(shouldShowConfirmCta(action), false);
});

test('T19.12: repeated revoke rows keep history but dedupe non-history views to executed state', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const spender = '0x2222222222222222222222222222222222222222';
  const pending = {
    id: 'pending-old',
    kind: 'transaction',
    status: 'pending',
    createdAt: '2026-01-02T00:00:00Z',
    executionPayload: { actionType: 'revoke_approval', calls: [{ to: token }] },
    metadata: { actionType: 'revoke_approval', userConfirmable: true, walletAddress: wallet, tokenAddress: token, spender, allowanceAfter: '0' },
  };
  const executed = {
    id: 'executed-new',
    kind: 'transaction',
    status: 'executed',
    createdAt: '2026-01-01T00:00:00Z',
    executedAt: '2026-01-01T00:10:00Z',
    executionPayload: { actionType: 'revoke_approval', calls: [{ to: token }] },
    metadata: {
      actionType: 'revoke_approval',
      walletAddress: wallet,
      tokenAddress: token,
      spender,
      allowanceAfter: '0',
      executionProof: { type: 'wallet_confirmation_receipt', txHash: '0xabc', statusCode: 200, allowanceAfter: '0', source: 'metadata.confirmation' },
    },
  };
  const executedOld = {
    ...executed,
    id: 'executed-old',
    createdAt: '2025-12-31T00:00:00Z',
    executedAt: '2025-12-31T00:10:00Z',
  };

  assert.deepStrictEqual(filterInboxActions([pending, executed], 'all').map((a) => a.id), ['executed-new']);
  assert.deepStrictEqual(filterInboxActions([pending, executed], 'confirmable').map((a) => a.id), []);
  assert.deepStrictEqual(filterInboxActions([executedOld, executed], 'history').map((a) => a.id), ['executed-old', 'executed-new']);
});
