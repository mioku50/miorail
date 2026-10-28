import assert from 'node:assert/strict';
import test from 'node:test';
import { runStillWalletActionV1, walletControlViewV1 } from './walletControls';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const GUEST = { connected: false, address: null, chainId: null, session: null, sessionPending: false, phase: 'disconnected' as const };

test('the shell keeps a connect action for a guest and a visible checking state during boot', () => {
  const guest = walletControlViewV1(GUEST);
  assert.equal(guest.kind, 'connect');
  assert.equal(guest.label, 'Connect wallet');
  assert.equal(guest.signIn, false);
  assert.equal(guest.signOut, false);
  const checking = walletControlViewV1({ ...GUEST, sessionPending: true });
  assert.equal(checking.kind, 'checking');
  assert.equal(checking.label, 'Checking wallet…');
});

test('a persisted session is identified as an account, not a browser wallet connection', () => {
  const view = walletControlViewV1({ ...GUEST, session: { address: A, chainId: 8453 } });
  assert.equal(view.kind, 'account');
  assert.equal(view.label, '0x1111…1111');
  assert.equal(view.status, 'Signed in · Wallet disconnected');
  assert.equal(view.walletAddress, null);
  assert.equal(view.sessionAddress, A);
  assert.equal(view.signOut, true);
  assert.equal(view.disconnect, false);
  assert.match(view.warning ?? '', /no wallet is connected/);
});

test('a connection alone requires a separate signature; only matching identity on Base is signed in', () => {
  const input = { ...GUEST, connected: true, address: A, chainId: 8453, phase: 'needs-signin' as const };
  const connected = walletControlViewV1(input);
  assert.equal(connected.status, 'Connected · Not signed in');
  assert.equal(connected.signIn, true);
  assert.equal(connected.signOut, false);
  const matched = walletControlViewV1({ ...input, phase: 'authenticated', session: { address: A.toUpperCase(), chainId: 8453 } });
  assert.equal(matched.status, 'Connected · Signed in');
  assert.equal(matched.signIn, false);
  assert.equal(matched.signOut, true);
  assert.equal(matched.warning, null);
});

test('a different browser wallet never borrows the session identity or its signed-in label', () => {
  const view = walletControlViewV1({
    ...GUEST, connected: true, address: B, chainId: 8453,
    session: { address: A, chainId: 8453 }, phase: 'needs-signin',
  });
  assert.equal(view.label, '0x2222…2222');
  assert.equal(view.walletAddress, B);
  assert.equal(view.sessionAddress, A);
  assert.equal(view.signIn, true);
  assert.equal(view.status, 'Connected · Different account');
  assert.match(view.warning ?? '', /differs from your signed-in account/);
});

test('a wallet on another chain offers a network switch, never a sign-in on that chain', () => {
  const view = walletControlViewV1({
    ...GUEST, connected: true, address: A, chainId: 84532,
    session: { address: A, chainId: 8453 }, phase: 'wrong-chain',
  });
  assert.equal(view.status, 'Connected · Switch to Base');
  assert.equal(view.switchChain, true);
  assert.equal(view.signIn, false);
  assert.equal(view.disconnect, true);
});

test('sign out invalidates the session and tenant cache without disconnecting or signing', async () => {
  const events: string[] = [];
  const result = await runStillWalletActionV1({
    action: 'signout', connectors: ['A', 'B'],
    logout: async () => { events.push('logout'); },
    clearSession: () => { events.push('clear'); },
    disconnect: async (connector) => { events.push(`disconnect:${connector}`); },
    openWalletPicker: () => { events.push('picker'); },
  });
  assert.equal(result, 'done');
  assert.deepEqual(events, ['logout', 'clear']);
});

test('switch wallet logs out first, drops every connection and opens the existing picker last', async () => {
  const events: string[] = [];
  const result = await runStillWalletActionV1({
    action: 'switch', connectors: ['A', 'B'],
    logout: async () => { events.push('logout'); },
    clearSession: () => { events.push('clear'); },
    disconnect: async (connector) => { events.push(`disconnect:${connector}`); },
    openWalletPicker: () => { events.push('picker'); },
  });
  assert.equal(result, 'done');
  assert.deepEqual(events, ['logout', 'clear', 'disconnect:A', 'disconnect:B', 'clear', 'picker']);
});

test('a refused logout leaves connections and client session intact and does not open a new sign-in', async () => {
  const events: string[] = [];
  await assert.rejects(runStillWalletActionV1({
    action: 'switch', connectors: ['A', 'B'],
    logout: async () => { throw new Error('prepared transaction invalidation failed'); },
    clearSession: () => { events.push('clear'); },
    disconnect: async (connector) => { events.push(`disconnect:${connector}`); },
    openWalletPicker: () => { events.push('picker'); },
  }));
  assert.deepEqual(events, []);
});

test('a partial disconnect still attempts remaining providers and refuses to silently choose another wallet', async () => {
  const events: string[] = [];
  const result = await runStillWalletActionV1({
    action: 'switch', connectors: ['A', 'B'],
    logout: async () => { events.push('logout'); },
    clearSession: () => { events.push('clear'); },
    disconnect: async (connector) => { events.push(`disconnect:${connector}`); if (connector === 'A') throw new Error('provider unavailable'); },
    openWalletPicker: () => { events.push('picker'); },
  });
  assert.equal(result, 'disconnect_incomplete');
  assert.deepEqual(events, ['logout', 'clear', 'disconnect:A', 'disconnect:B', 'clear']);
});
