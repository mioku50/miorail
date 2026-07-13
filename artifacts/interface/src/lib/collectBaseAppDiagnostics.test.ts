import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBaseAppDiagnostics } from './collectBaseAppDiagnostics.js';

test('T48a: no provider, no wallet -> conservative all-false snapshot', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: false,
    sessionAuthenticated: false,
    isBaseAppEnvironment: false,
  });
  assert.equal(snapshot.injectedProviderDetected, false);
  assert.equal(snapshot.walletAddress, null);
  assert.equal(snapshot.chainId, null);
  assert.equal(snapshot.sessionAuthenticated, false);
  assert.equal(snapshot.walletCapabilities, null);
  assert.equal(snapshot.sendCallsSupported, false);
});

test('T48a: connected + authenticated BaseApp session reports the wallet fields', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    walletAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    chainId: 8453,
    sessionAuthenticated: true,
    isBaseAppEnvironment: true,
  });
  assert.equal(snapshot.injectedProviderDetected, true);
  assert.equal(snapshot.walletAddress, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(snapshot.chainId, 8453);
  assert.equal(snapshot.sessionAuthenticated, true);
  assert.equal(snapshot.isBaseAppEnvironment, true);
});

test('T48a: EIP-5792 atomic.status "supported" marks wallet_sendCalls as supported', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: true,
    capabilities: { atomic: { status: 'supported' } },
  });
  assert.equal(snapshot.sendCallsSupported, true);
  assert.deepEqual(snapshot.walletCapabilities, { atomic: { status: 'supported' } });
});

test('T48a: EIP-5792 atomic.status "ready" also marks wallet_sendCalls as supported', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: true,
    capabilities: { atomic: { status: 'ready' } },
  });
  assert.equal(snapshot.sendCallsSupported, true);
});

test('T48a: legacy atomicBatch.supported shape is also recognized', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: true,
    capabilities: { atomicBatch: { supported: true } },
  });
  assert.equal(snapshot.sendCallsSupported, true);
});

test('T48a: atomic.status "unsupported" does not mark wallet_sendCalls as supported', () => {
  const snapshot = collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: true,
    capabilities: { atomic: { status: 'unsupported' } },
  });
  assert.equal(snapshot.sendCallsSupported, false);
});

test('T48a: malformed/empty capabilities never throw and resolve to unsupported', () => {
  assert.equal(collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: false,
    capabilities: {},
  }).sendCallsSupported, false);

  assert.equal(collectBaseAppDiagnostics({
    injectedProviderDetected: true,
    sessionAuthenticated: false,
    isBaseAppEnvironment: false,
    capabilities: null,
  }).sendCallsSupported, false);
});
