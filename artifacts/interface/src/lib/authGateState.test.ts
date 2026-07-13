import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAuthGate } from './authGateState.js';

test('T48a: disconnected wallet shows the shell in the disconnected phase', () => {
  const state = deriveAuthGate({ isConnected: false, sessionPending: false, sessionUser: null });
  assert.equal(state.phase, 'disconnected');
  assert.equal(state.walletConnected, false);
  assert.equal(state.sessionAuthenticated, false);
  assert.equal(state.showAppShell, true);
  assert.equal(state.showPrivateSurfaces, false);
});

test('T48a: connected off Base Mainnet is wrong-chain, not needs-signin', () => {
  const state = deriveAuthGate({
    isConnected: true,
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    chainId: 84532,
    sessionPending: false,
    sessionUser: null,
  });
  assert.equal(state.phase, 'wrong-chain');
  assert.equal(state.needsChainSwitch, true);
  assert.equal(state.sessionAuthenticated, false);
});

test('T48a: session still resolving on the right chain is booting, not needs-signin', () => {
  const state = deriveAuthGate({
    isConnected: true,
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    chainId: 8453,
    sessionPending: true,
    sessionUser: null,
  });
  assert.equal(state.phase, 'booting');
  assert.equal(state.sessionAuthenticated, false);
});

test('T48a: connected, session resolved, no matching user -> needs-signin (no auto-sign)', () => {
  const state = deriveAuthGate({
    isConnected: true,
    address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    chainId: 8453,
    sessionPending: false,
    sessionUser: null,
  });
  assert.equal(state.phase, 'needs-signin');
  assert.equal(state.sessionAuthenticated, false);
  assert.equal(state.showPrivateSurfaces, false);
});

test('T48a: a valid session for the SAME wallet is authenticated without re-signing', () => {
  const address = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const state = deriveAuthGate({
    isConnected: true,
    address,
    chainId: 8453,
    sessionPending: false,
    sessionUser: { address, chainId: 8453 },
  });
  assert.equal(state.phase, 'authenticated');
  assert.equal(state.sessionAuthenticated, true);
  assert.equal(state.tenantLoaded, true);
  assert.equal(state.showPrivateSurfaces, true);
});

test('T48a: session user is case-insensitively matched against the connected address', () => {
  const state = deriveAuthGate({
    isConnected: true,
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    chainId: 8453,
    sessionPending: false,
    sessionUser: { address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chainId: 8453 },
  });
  assert.equal(state.sessionAuthenticated, true);
  assert.equal(state.phase, 'authenticated');
});

test('T48a: switching to a different wallet invalidates the stale session -> needs-signin', () => {
  const previousAddress = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const newAddress = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const state = deriveAuthGate({
    isConnected: true,
    address: newAddress,
    chainId: 8453,
    sessionPending: false,
    // Stale session data for the previous wallet, not yet invalidated client-side.
    sessionUser: { address: previousAddress, chainId: 8453 },
  });
  assert.equal(state.sessionAuthenticated, false);
  assert.equal(state.phase, 'needs-signin');
  assert.equal(state.showPrivateSurfaces, false);
});

test('T48a: a session bound to the wrong chain id never counts as authenticated', () => {
  const address = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const state = deriveAuthGate({
    isConnected: true,
    address,
    chainId: 8453,
    sessionPending: false,
    sessionUser: { address, chainId: 84532 },
  });
  assert.equal(state.sessionAuthenticated, false);
  assert.equal(state.phase, 'needs-signin');
});
