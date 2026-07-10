import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityLabel, capabilityState, x402CapabilityState } from './capabilityStatus.js';

test('canonical capability states collapse provider vocabulary to three user states', () => {
  assert.equal(capabilityState('connected'), 'active');
  assert.equal(capabilityState('ready'), 'active');
  assert.equal(capabilityState('partial'), 'limited');
  assert.equal(capabilityState('needs_reauth'), 'limited');
  assert.equal(capabilityState('failed'), 'off');
  assert.equal(capabilityState('missing'), 'off');
  assert.equal(capabilityLabel('active'), 'Active');
  assert.equal(capabilityLabel('limited'), 'Limited');
  assert.equal(capabilityLabel('off'), 'Off');
});

test('settlement evidence takes precedence over raw x402 status vocabulary', () => {
  assert.equal(x402CapabilityState({ settleReady: true, status: 'degraded' }), 'active');
  assert.equal(x402CapabilityState({ settleReady: false, status: 'degraded' }), 'limited');
  assert.equal(x402CapabilityState({ settleReady: false, status: 'missing' }), 'off');
});
