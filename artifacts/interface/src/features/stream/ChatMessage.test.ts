import assert from 'node:assert/strict';
import test from 'node:test';
import { baseMcpApprovalLabel } from './ChatMessage.js';

test('Base MCP approval labels distinguish pending, completed, rejected and failed', () => {
  assert.equal(baseMcpApprovalLabel('approval_required'), 'Pending Base Account confirmation');
  assert.equal(baseMcpApprovalLabel('pending'), 'Pending');
  assert.equal(baseMcpApprovalLabel('completed'), 'Completed');
  assert.equal(baseMcpApprovalLabel('rejected'), 'Rejected');
  assert.equal(baseMcpApprovalLabel('failed'), 'Failed');
});
