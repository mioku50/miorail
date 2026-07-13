import assert from 'node:assert/strict';
import test from 'node:test';
import { isBaseAppEnvironment } from './baseAppEnvironment';

test('T47 detects injected BaseApp without treating normal Base Account popup as embedded', () => {
  assert.equal(isBaseAppEnvironment({ connectorId: 'injected', userAgent: 'BaseApp/1.0' }), true);
  assert.equal(isBaseAppEnvironment({ connectorId: 'injected', userAgent: 'CoinbaseWallet/32.1' }), true);
  assert.equal(isBaseAppEnvironment({ connectorId: 'baseAccount', connectorName: 'Base Account' }), false);
  assert.equal(isBaseAppEnvironment({ connectorId: 'injected', connectorName: 'MetaMask' }), false);
  assert.equal(isBaseAppEnvironment({
    connectorId: 'injected',
    connectorName: 'Coinbase Wallet',
    userAgent: 'Mozilla/5.0 Chrome/126.0',
    provider: { isCoinbaseWallet: true },
  }), false);
});
