import test from 'node:test';
import assert from 'node:assert';
import { simulateButtonLabel, SimulateButton } from '../src/SimulateButton.js';

const base = { isConnected: true, isWrongChain: false, priceLabel: '0.01 USDC' } as const;

test('simulateButtonLabel: idle shows the price', () => {
  assert.equal(
    simulateButtonLabel({ ...base, state: 'idle', outcome: null, simulationStatus: null }),
    'Pay & simulate (0.01 USDC)',
  );
});

test('simulateButtonLabel: covers every payment-flow state named in decision 10(c)', () => {
  assert.equal(simulateButtonLabel({ ...base, state: 'preparing_payment', outcome: null, simulationStatus: null }), 'Preparing payment');
  assert.equal(simulateButtonLabel({ ...base, state: 'awaiting_wallet_confirmation', outcome: null, simulationStatus: null }), 'Confirm in Base Account');
  assert.equal(simulateButtonLabel({ ...base, state: 'awaiting_wallet', outcome: null, simulationStatus: null }), 'Confirm in Base Account');
  assert.equal(simulateButtonLabel({ ...base, state: 'settling_payment', outcome: null, simulationStatus: null }), 'Payment settled');
  assert.equal(simulateButtonLabel({ ...base, state: 'running_action', outcome: null, simulationStatus: null }), 'Running simulation');
});

test('simulateButtonLabel: terminal outcomes — Simulation passed / reverted / Paid, but service failed / Simulation failed', () => {
  assert.equal(simulateButtonLabel({ ...base, state: 'succeeded', outcome: 'simulated', simulationStatus: 'passed' }), 'Simulation passed');
  assert.equal(simulateButtonLabel({ ...base, state: 'succeeded', outcome: 'cached', simulationStatus: 'passed' }), 'Simulation passed');
  assert.equal(simulateButtonLabel({ ...base, state: 'succeeded', outcome: 'simulated', simulationStatus: 'failed' }), 'Simulation reverted');
  assert.equal(simulateButtonLabel({ ...base, state: 'succeeded', outcome: 'paid_service_failed', simulationStatus: null }), 'Paid, but service failed');
  assert.equal(simulateButtonLabel({ ...base, state: 'succeeded', outcome: 'invalid_response', simulationStatus: null }), 'Simulation failed');
});

test('simulateButtonLabel: connection/chain gates win over payment state', () => {
  assert.equal(
    simulateButtonLabel({ ...base, isConnected: false, state: 'succeeded', outcome: 'simulated', simulationStatus: 'passed' }),
    'Connect wallet first',
  );
  assert.equal(
    simulateButtonLabel({ ...base, isWrongChain: true, state: 'idle', outcome: null, simulationStatus: null }),
    'Switch to Base',
  );
});

test('simulateButtonLabel: payment-failure states retain their PAID_ACTION_LABELS-style copy', () => {
  assert.equal(simulateButtonLabel({ ...base, state: 'rejected', outcome: null, simulationStatus: null }), 'Payment rejected - retry');
  assert.equal(simulateButtonLabel({ ...base, state: 'insufficient_funds', outcome: null, simulationStatus: null }), 'Insufficient USDC on Base');
  assert.equal(simulateButtonLabel({ ...base, state: 'settlement_failed', outcome: null, simulationStatus: null }), 'Payment settlement failed');
});

test('SimulateButton is exported correctly and its source never references calldata/calls', () => {
  assert.equal(typeof SimulateButton, 'function');
  const source = SimulateButton.toString();
  assert.ok(!/\bcalls\s*:/.test(source), 'must never construct a calls/calldata payload');
});
