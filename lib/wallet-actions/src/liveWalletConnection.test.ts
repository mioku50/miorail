import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { mock } from 'wagmi/connectors';
import { getConnectorClient } from 'wagmi/actions';

import { WALLET_CONNECTION_NOT_READY_V1, walletConnectionNotReadyV1, walletDidNotSendV1, walletSubmissionFailureMessageV1 } from './walletBatchSupport';
import { WalletConnectionNotReadyErrorV1, liveConnectorV1, requireLiveWalletConnectionV1 } from './liveWalletConnection';

const ACCOUNT = '0x00000000000000000000000000000000000b0b0b' as const;

/** A config whose last connection came back from storage as wagmi restores it: a bare record. */
function restored(status: 'reconnecting' | 'connected' = 'reconnecting') {
  const config = createConfig({
    chains: [base],
    connectors: [mock({ accounts: [ACCOUNT] })],
    transports: { [base.id]: http() },
  });
  const record = { id: config.connectors[0]!.id, name: 'Mock Connector', type: 'mock', uid: 'uid-from-the-last-visit' };
  config.setState((state) => ({
    ...state,
    status,
    current: record.uid,
    connections: new Map([[record.uid, { accounts: [ACCOUNT] as const, chainId: base.id, connector: record as never }]]),
  }));
  return config;
}

test('a restored record fails wagmi as the page saw it on 2026-11-09', async () => {
  const config = restored();
  const failure = await getConnectorClient(config).then(() => null, (cause: unknown) => cause);
  assert.match(String((failure as Error)?.message), /connector\.getChainId is not a function/);
  // The page names it, says nothing was sent, and does not blame the fee sponsor or the wallet.
  assert.equal(walletConnectionNotReadyV1(failure), true);
  assert.equal(walletDidNotSendV1(failure), true);
  assert.equal(walletSubmissionFailureMessageV1(failure, 'MetaMask'), WALLET_CONNECTION_NOT_READY_V1);
  // The minifier renames the variable, never the property.
  assert.equal(walletConnectionNotReadyV1(new TypeError('s.connector.getChainId is not a function')), true);
  assert.equal(walletConnectionNotReadyV1(new TypeError("s.connector.getChainId is not a function. (In 's.connector.getChainId()', 's.connector.getChainId' is undefined)")), true);
  assert.equal(walletConnectionNotReadyV1(Object.assign(new Error('x'), { name: 'ConnectorUnavailableReconnectingError' })), true);
  assert.equal(walletConnectionNotReadyV1(new Error('User rejected the request.')), false);
});

test('a live connection is used as it is', async () => {
  const config = createConfig({ chains: [base], connectors: [mock({ accounts: [ACCOUNT] })], transports: { [base.id]: http() } });
  let connects = 0;
  await requireLiveWalletConnectionV1(config, { connect: async () => { connects += 1; } }).then(
    () => assert.fail('nothing is connected yet'),
    (cause: unknown) => assert.ok(cause instanceof WalletConnectionNotReadyErrorV1),
  );
  const { connect } = await import('wagmi/actions');
  await connect(config, { connector: config.connectors[0]! });
  const live = await requireLiveWalletConnectionV1(config, { connect: async () => { connects += 1; } });
  assert.equal(live.restored, false);
  assert.equal(live.connector, liveConnectorV1(config));
  assert.equal(connects, 0);
});

test('a press waits for wagmi’s own reconnect first', async () => {
  const config = restored();
  const wallet = config.connectors[0]!;
  let connects = 0;
  const pending = requireLiveWalletConnectionV1(config, { reconnectWaitMs: 5_000, connect: async () => { connects += 1; } });
  // wagmi's reconnect finishes meanwhile and puts the live connector in place.
  setTimeout(() => config.setState((state) => ({
    ...state,
    status: 'connected',
    current: wallet.uid,
    connections: new Map([[wallet.uid, { accounts: [ACCOUNT] as const, chainId: base.id, connector: wallet }]]),
  })), 20);
  const live = await pending;
  assert.equal(live.restored, true);
  assert.equal(live.connector, wallet);
  assert.equal(connects, 0);
});

test('a reconnect that never finishes: the press connects the same wallet again, through wagmi', async () => {
  const config = restored();
  const live = await requireLiveWalletConnectionV1(config, { reconnectWaitMs: 20 });
  assert.equal(live.restored, true);
  assert.equal(live.connector, config.connectors[0]);
  assert.equal(config.state.status, 'connected');
  // And wagmi's actions work again.
  const client = await getConnectorClient(config);
  assert.equal(client.account.address.toLowerCase(), ACCOUNT);
});

test('says so plainly when the wallet cannot be brought back, and keeps the person’s own No', async () => {
  // No connector of that wallet in this tab.
  const gone = restored();
  gone.setState((state) => {
    const [uid, connection] = [...state.connections.entries()][0]!;
    return { ...state, connections: new Map([[uid, { ...connection, connector: { ...connection.connector, id: 'io.unknown.wallet' } }]]) };
  });
  await assert.rejects(requireLiveWalletConnectionV1(gone, { reconnectWaitMs: 10 }), (cause: unknown) =>
    cause instanceof WalletConnectionNotReadyErrorV1 && (cause as Error).message === WALLET_CONNECTION_NOT_READY_V1);

  // The wallet never answers the connect.
  await assert.rejects(
    requireLiveWalletConnectionV1(restored(), { reconnectWaitMs: 10, connectWaitMs: 30, connect: () => new Promise(() => {}) }),
    (cause: unknown) => cause instanceof WalletConnectionNotReadyErrorV1,
  );

  // The person refused to connect: that refusal is theirs, not a connection that was not ready.
  const refusal = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  await assert.rejects(
    requireLiveWalletConnectionV1(restored(), { reconnectWaitMs: 10, connect: async () => { throw refusal; } }),
    (cause: unknown) => cause === refusal,
  );
});
