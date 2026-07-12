import assert from 'node:assert/strict';
import test from 'node:test';
import { baseMcpApprovalLabel, historicalMessageModeLabel, shouldShowBaseMcpConfirmation } from './chatMessageState.js';

test('Base MCP approval labels distinguish pending, completed, rejected and failed', () => {
  assert.equal(baseMcpApprovalLabel('approval_required'), 'Pending Base Account confirmation');
  assert.equal(baseMcpApprovalLabel('pending'), 'Pending');
  assert.equal(baseMcpApprovalLabel('completed'), 'Completed');
  assert.equal(baseMcpApprovalLabel('rejected'), 'Rejected');
  assert.equal(baseMcpApprovalLabel('failed'), 'Failed');
});

test('confirmation CTA is removed after any terminal provider status', () => {
  assert.equal(shouldShowBaseMcpConfirmation({ approvalState: 'pending' }), true);
  assert.equal(shouldShowBaseMcpConfirmation({ approvalState: 'pending', approvalTerminal: true }), false);
  assert.equal(shouldShowBaseMcpConfirmation({ approvalState: 'completed' }), false);
});

test('historical read-only recommendations retain their original mode label', () => {
  assert.equal(
    historicalMessageModeLabel({ chainMode: 'mainnet-readonly', readOnly: true }, 'Mainnet · User-confirmed'),
    'Base Mainnet · Read-only',
  );
});
