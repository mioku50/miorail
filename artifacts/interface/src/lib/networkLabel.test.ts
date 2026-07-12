import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveNetworkLabel } from './networkLabel.js';

test('mainnet with user-confirmed capability shows User-confirmed even without a saved policy', () => {
  const state = deriveNetworkLabel({
    chainEnv: 'mainnet',
    executionMode: 'user-confirmed',
    userConfirmedEnabled: true,
    executionReady: false,
  });
  assert.equal(state.label, 'Base Mainnet · User-confirmed');
  assert.equal(state.readOnly, false);
  // Actions stay locked until the policy is executionReady.
  assert.equal(state.executionUnlocked, false);
});

test('mainnet user-confirmed with executionReady unlocks actions', () => {
  const state = deriveNetworkLabel({
    chainEnv: 'mainnet',
    executionMode: 'user-confirmed',
    userConfirmedEnabled: true,
    executionReady: true,
  });
  assert.equal(state.label, 'Base Mainnet · User-confirmed');
  assert.equal(state.readOnly, false);
  assert.equal(state.executionUnlocked, true);
});

test('read-only execution mode renders the read-only mainnet label', () => {
  const state = deriveNetworkLabel({
    chainEnv: 'mainnet-readonly',
    executionMode: 'read-only',
    userConfirmedEnabled: false,
    executionReady: false,
  });
  assert.equal(state.label, 'Base Mainnet · Read-only');
  assert.equal(state.readOnly, true);
  assert.equal(state.executionUnlocked, false);
});

test('sepolia renders its testnet label and is not read-only under server-execution', () => {
  const state = deriveNetworkLabel({
    chainEnv: 'sepolia',
    executionMode: 'server-execution',
    userConfirmedEnabled: true,
    executionReady: false,
  });
  assert.equal(state.label, 'Base Sepolia');
  assert.equal(state.readOnly, false);
});

test('while status loads, mainnet falls back to read-only and sepolia to its label', () => {
  const mainnet = deriveNetworkLabel({ chainEnv: 'mainnet' });
  assert.equal(mainnet.label, 'Base Mainnet · Read-only');
  assert.equal(mainnet.readOnly, true);
  assert.equal(mainnet.executionUnlocked, false);

  const sepolia = deriveNetworkLabel({ chainEnv: 'sepolia' });
  assert.equal(sepolia.label, 'Base Sepolia');
  assert.equal(sepolia.readOnly, false);
});
