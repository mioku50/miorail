import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { mock } from 'wagmi/connectors';
import { getConnectorClient } from 'wagmi/actions';

import { WALLET_CONNECTION_NOT_READY_V1, WALLET_ON_ANOTHER_NETWORK_V1, walletAccountChangedSentenceV1, walletConnectionNotReadyV1, walletDidNotSendV1,
  walletNotAskedSentenceV1, walletSubmissionFailureMessageV1 } from './walletBatchSupport';
import { WalletAccountChangedErrorV1, WalletConnectionNotReadyErrorV1, connectedAccountsV1, liveConnectorV1, requireLiveWalletAccountV1,
  requireLiveWalletConnectionV1 } from './liveWalletConnection';

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

// Audit WAL-1 (2026-11-10): the press brings the connection back, and the wallet answers with the
// account selected in it now, which may not be the one the page showed and the server reviewed.
const OTHER = '0x00000000000000000000000000000000000c0c0c' as const;

/** A record from the last visit that names `recorded`, over a wallet that now answers as `answering`. */
function restoredAs(recorded: readonly `0x${string}`[], answering: readonly [`0x${string}`, ...`0x${string}`[]]) {
  const config = createConfig({ chains: [base], connectors: [mock({ accounts: answering })], transports: { [base.id]: http() } });
  const record = { id: config.connectors[0]!.id, name: 'Mock Connector', type: 'mock', uid: 'uid-from-the-last-visit' };
  config.setState((state) => ({
    ...state,
    status: 'connected',
    current: record.uid,
    connections: new Map([[record.uid, { accounts: recorded as never, chainId: base.id, connector: record as never }]]),
  }));
  return config;
}

test('a wallet that comes back as another account is not asked, by the page’s own check and by wagmi for a send that names the account', async () => {
  const config = restoredAs([ACCOUNT], [OTHER]);
  const failure = await requireLiveWalletAccountV1(config, ACCOUNT).then(() => null, (cause: unknown) => cause);
  assert.ok(failure instanceof WalletAccountChangedErrorV1);
  assert.equal(failure.expected, ACCOUNT);
  assert.equal(failure.message, 'Your wallet switched to another account, so it was not asked and nothing was sent. Switch back to 0x0000…0b0b, then press again.');
  // The connection is live again, and it is the other account's.
  assert.deepEqual(connectedAccountsV1(config), [OTHER]);
  // Nothing was sent, and the page says so in the same words wherever the failure surfaces.
  assert.equal(walletDidNotSendV1(failure), true);
  assert.equal(walletSubmissionFailureMessageV1(failure, 'MetaMask'), failure.message);
  assert.equal(walletNotAskedSentenceV1({ cause: failure }), failure.message);

  // A send that names the reviewed account is refused by wagmi before the wallet hears of it.
  const { sendTransaction } = await import('wagmi/actions');
  const refused = await sendTransaction(config, { account: ACCOUNT, chainId: base.id, to: OTHER, value: 0n }).then(() => null, (cause: unknown) => cause);
  assert.equal((refused as Error).name, 'ConnectorAccountNotFoundError');
  assert.equal(walletDidNotSendV1(refused), true);
  assert.equal(walletSubmissionFailureMessageV1(refused, 'MetaMask'), failure.message);
});

test('a wallet that still holds the reviewed account passes, selected first or not', async () => {
  for (const answering of [[ACCOUNT], [OTHER, ACCOUNT]] as const) {
    const config = restoredAs([ACCOUNT], answering as unknown as [`0x${string}`, ...`0x${string}`[]]);
    const live = await requireLiveWalletAccountV1(config, ACCOUNT.toUpperCase().replace('0X', '0x'));
    assert.equal(live.restored, true);
    assert.equal(live.connector, liveConnectorV1(config));
  }
  // A connection that was live all along is checked the same way.
  const config = createConfig({ chains: [base], connectors: [mock({ accounts: [ACCOUNT] })], transports: { [base.id]: http() } });
  const { connect } = await import('wagmi/actions');
  await connect(config, { connector: config.connectors[0]! });
  assert.equal((await requireLiveWalletAccountV1(config, ACCOUNT)).restored, false);
  await assert.rejects(requireLiveWalletAccountV1(config, OTHER), WalletAccountChangedErrorV1);
});

test('a connection that could not be brought back is said as that, never as another account', async () => {
  const config = restoredAs([ACCOUNT], [ACCOUNT]);
  const failure = await requireLiveWalletAccountV1(config, ACCOUNT, { connect: async () => { throw new Error('wallet is locked'); } })
    .then(() => null, (cause: unknown) => cause);
  assert.ok(failure instanceof WalletConnectionNotReadyErrorV1);
  assert.equal(walletNotAskedSentenceV1(failure), null);
});

test('what was refused before the wallet was asked: another account, another network, and nothing else', () => {
  const named = 'Your wallet switched to another account, so it was not asked and nothing was sent. Switch back to 0x0000…0b0b, then press again.';
  const unnamed = 'Your wallet switched to another account, so it was not asked and nothing was sent. Switch back to the account you signed in with, then press again.';
  // wagmi's own words carry the account.
  const wagmi = Object.assign(new Error(`Account "${ACCOUNT}" not found for connector "MetaMask".`), { name: 'ConnectorAccountNotFoundError' });
  assert.equal(walletNotAskedSentenceV1(wagmi), named);
  assert.equal(walletNotAskedSentenceV1({ shortMessage: 'x', cause: { cause: wagmi } }), named);
  assert.equal(walletNotAskedSentenceV1(Object.assign(new Error('x'), { name: 'ConnectorAccountNotFoundError' })), unnamed);
  assert.equal(walletAccountChangedSentenceV1('not an address'), unnamed);
  const network = Object.assign(new Error('The current chain of the connector (id: 1) does not match the connection’s chain (id: 8453).'), { name: 'ConnectorChainMismatchError' });
  assert.equal(walletNotAskedSentenceV1(network), WALLET_ON_ANOTHER_NETWORK_V1);
  assert.equal(walletDidNotSendV1(network), true);
  assert.equal(walletSubmissionFailureMessageV1(network), WALLET_ON_ANOTHER_NETWORK_V1);
  // A lost answer, a timeout or the wallet's own error proves nothing.
  for (const other of [new Error('wallet response lost'), Object.assign(new Error('nonce too low'), { code: -32000 }), { name: 'TimeoutError' }, null, 'boom']) {
    assert.equal(walletNotAskedSentenceV1(other), null);
  }
  assert.equal(walletDidNotSendV1(new Error('wallet response lost')), false);
});
