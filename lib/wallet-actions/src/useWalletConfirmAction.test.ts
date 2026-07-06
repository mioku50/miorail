import { test } from 'node:test';
import assert from 'node:assert';
import * as mod from './useWalletConfirmAction';

test('useWalletConfirmAction and CallsStatusPoller are exported correctly', () => {
  assert.equal(typeof mod.useWalletConfirmAction, 'function');
  assert.equal(typeof mod.CallsStatusPoller, 'function');
});

test('useWalletConfirmAction does not invoke useCallsStatus directly', () => {
  const hookSource = mod.useWalletConfirmAction.toString();
  assert.ok(!hookSource.includes('useCallsStatus('), 'useWalletConfirmAction must not call useCallsStatus directly; polling must be encapsulated in CallsStatusPoller');
  assert.ok(hookSource.includes('CallsStatusPoller'), 'useWalletConfirmAction must reference CallsStatusPoller');
});

test('CallsStatusPoller validates batchId length before enabling useCallsStatus', () => {
  const pollerSource = mod.CallsStatusPoller.toString();
  assert.ok(pollerSource.includes('trim()') && pollerSource.includes('length'), 'CallsStatusPoller must check batchId validity before enabling polling');
});
