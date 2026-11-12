import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBaseAppEarly } from './detectBaseAppEarly';
import {
  METAMASK_OPEN_HREF_V1,
  baseAccountConnectorV1,
  createWalletConnectorIdV1,
  isMobileBrowserV1,
  metaMaskPairHrefV1,
  metaMaskPairSchemeV1,
  openInBaseAppHrefV1,
  openInMetaMaskHrefV1,
  walletChoicesV1,
  walletDisplayNameV1,
  type WalletConnectorViewV1,
} from './walletChoices';

// The connectors wagmi builds from main.tsx, plus what a browser announces.
const GENERIC: WalletConnectorViewV1 = { id: 'injected', name: 'Injected', type: 'injected' };
const BASE_ACCOUNT: WalletConnectorViewV1 = { id: 'baseAccount', name: 'Base Account', type: 'baseAccount' };
const METAMASK: WalletConnectorViewV1 = { id: 'io.metamask', name: 'MetaMask', type: 'injected', icon: 'data:image/svg+xml,<svg/>' };
const COINBASE: WalletConnectorViewV1 = { id: 'com.coinbase.wallet', name: 'Coinbase Wallet', type: 'injected', icon: 'data:image/png;base64,AA==' };
const PAGE = 'https://miorail.xyz/routes?from=stocks&token=0xb20000000000000000000078ee7ce2fe4908108c&side=buy';
// main.tsx adds it only on a phone browser with no wallet, with a project id.
const WALLET_CONNECT: WalletConnectorViewV1 = { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' };
// What production logged for the operator's phone on 2026-09-24.
const BASE_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CoinbaseWalletRN/30.13.95 (org.toshi.distribution; build:30130000; iOS 27.0)';

const names = (result: ReturnType<typeof walletChoicesV1>) => result.choices.map((choice) => choice.name);

test('a desktop browser with two extensions offers both by name, then Base Account', () => {
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT, METAMASK, COINBASE],
    inBaseApp: false,
    hasWindowProvider: true,
    mobile: false,
    pageUrl: PAGE,
  });
  // The generic connector would reach one of the two a second time.
  assert.deepEqual(names(result), ['MetaMask', 'Coinbase Wallet', 'Base Account']);
  assert.equal(result.note, null);
  const metamask = result.choices[0]!;
  assert.equal(metamask.kind === 'connector' && metamask.icon, 'data:image/svg+xml,<svg/>');
  assert.match(result.choices[2]!.detail, /nothing to install/);
  // The row is also where a person with no wallet begins, and the fee offer
  // has covered Still's loans since 2026-11-09, not stock trades alone.
  assert.match(result.choices[2]!.detail, /^Create one with a passkey, or use yours/);
  assert.match(result.choices[2]!.detail, /stock trades and Still loans\.$/);
});

// The gas credits programme asks for Base Account as the way to make a wallet
// (2026-11-12): "Create a wallet" on Home opens exactly the connector the
// picker's Base Account row does, and only where that row exists.
test('"Create a wallet" opens Base Account, and only where Base Account is built and nothing is connected yet', () => {
  assert.equal(createWalletConnectorIdV1({ connectors: [GENERIC, BASE_ACCOUNT, METAMASK], connected: false }), 'baseAccount');
  assert.equal(createWalletConnectorIdV1({ connectors: [GENERIC, METAMASK, { id: 'org.base.account', name: 'Base Account', type: 'baseAccount' }], connected: false }), 'org.base.account');
  // A connected wallet is one the person already has: they sign in with it.
  assert.equal(createWalletConnectorIdV1({ connectors: [GENERIC, BASE_ACCOUNT], connected: true }), null);
  // Inside Base App and Farcaster main.tsx builds the injected connector alone.
  assert.equal(createWalletConnectorIdV1({ connectors: [GENERIC, COINBASE], connected: false }), null);
  assert.equal(createWalletConnectorIdV1({ connectors: [], connected: false }), null);
  assert.equal(baseAccountConnectorV1([METAMASK, BASE_ACCOUNT]), BASE_ACCOUNT);
  assert.equal(baseAccountConnectorV1([METAMASK, COINBASE]), null);
});

test('a host that injects without announcing is offered once, as a browser wallet', () => {
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT],
    inBaseApp: false,
    hasWindowProvider: true,
    mobile: false,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(result), ['Browser wallet', 'Base Account']);
  // Configured is not present: no provider in the page, no generic choice.
  assert.deepEqual(
    names(walletChoicesV1({ connectors: [GENERIC, BASE_ACCOUNT], inBaseApp: false, hasWindowProvider: false, mobile: false, pageUrl: PAGE })),
    ['Base Account'],
  );
});

test('a phone browser with no wallet offers Base Account and reopening the page in MetaMask or Base App', () => {
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT],
    inBaseApp: false,
    hasWindowProvider: false,
    mobile: true,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(result), ['Base Account', 'MetaMask', 'Base App (Coinbase Wallet)']);
  const links = result.choices.filter((choice) => choice.kind === 'open_in');
  assert.deepEqual(
    links.map((choice) => choice.kind === 'open_in' && choice.href),
    [
      'https://link.metamask.io/dapp/miorail.xyz/routes?from=stocks&token=0xb20000000000000000000078ee7ce2fe4908108c&side=buy',
      `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(PAGE)}`,
    ],
  );
  assert.equal(result.note, null);
});

test('a phone browser with WalletConnect offers MetaMask that stays in this browser, before reopening the page inside it', () => {
  // 2026-11-03, the operator: "Open in MetaMask" opened the page inside MetaMask, where it should come back to Safari.
  const result = walletChoicesV1({ connectors: [GENERIC, BASE_ACCOUNT, WALLET_CONNECT], inBaseApp: false, hasWindowProvider: false, mobile: true, pageUrl: PAGE });
  assert.deepEqual(result.choices.map((choice) => [choice.kind, choice.name]), [
    ['connector', 'Base Account'], ['connector', 'MetaMask'], ['open_in', 'MetaMask'], ['open_in', 'Base App (Coinbase Wallet)'],
  ]);
  const paired = result.choices[1]!;
  assert.deepEqual(paired.kind === 'connector' && [paired.connectorId, paired.pairWith, paired.detail],
    ['walletConnect', 'metamask', 'Stays in this browser: MetaMask opens to approve, then you come back here.']);
  assert.equal(result.choices[2]!.detail, 'Opens this page inside the MetaMask app instead, where your MetaMask wallet connects.');
  // Never where a wallet is already in the page, on a desktop, or inside an app that hosts the page.
  for (const input of [
    { hasWindowProvider: true, mobile: true, connectors: [GENERIC, BASE_ACCOUNT, METAMASK, WALLET_CONNECT] },
    { hasWindowProvider: false, mobile: false, connectors: [GENERIC, BASE_ACCOUNT, WALLET_CONNECT] },
  ]) {
    assert.equal(walletChoicesV1({ ...input, inBaseApp: false, pageUrl: PAGE }).choices.some((choice) => choice.kind === 'connector' && choice.pairWith), false);
  }
  assert.equal(walletChoicesV1({ connectors: [GENERIC, WALLET_CONNECT], inBaseApp: true, hasWindowProvider: true, mobile: true, pageUrl: PAGE })
    .choices.some((choice) => choice.kind === 'connector' && choice.pairWith), false);
});

test('a wallet paired by WalletConnect is named MetaMask, whose link paired it', () => {
  assert.equal(walletDisplayNameV1(WALLET_CONNECT, false), 'MetaMask');
});

test('MetaMask’s pairing links carry the WalletConnect link whole, and bringing it forward names no request', () => {
  const uri = 'wc:7f6e5d4c@2?relay-protocol=irn&symKey=0a1b2c&expiryTimestamp=1793740000';
  assert.equal(metaMaskPairHrefV1(uri), `https://link.metamask.io/wc?uri=${encodeURIComponent(uri)}`);
  assert.equal(metaMaskPairSchemeV1(uri), `metamask://wc?uri=${encodeURIComponent(uri)}`);
  assert.equal(decodeURIComponent(new URL(metaMaskPairHrefV1(uri)).searchParams.get('uri') ?? ''), decodeURIComponent(uri));
  assert.equal(METAMASK_OPEN_HREF_V1, 'metamask://');
});

test('inside a wallet app’s own browser the links are not offered — its wallet is already here', () => {
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT, METAMASK],
    inBaseApp: false,
    hasWindowProvider: true,
    mobile: true,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(result), ['MetaMask', 'Base Account']);
});

test('inside Base App: its own wallet only, and the way to use another one', () => {
  // main.tsx builds this list without baseAccount() inside Base App.
  assert.equal(detectBaseAppEarly({ userAgent: BASE_APP_UA }), true);
  const announced = walletChoicesV1({
    connectors: [GENERIC, COINBASE],
    inBaseApp: true,
    hasWindowProvider: true,
    mobile: true,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(announced), ['Coinbase Wallet']);
  assert.equal(announced.choices[0]!.detail, 'The wallet Base App gives this page.');
  assert.match(announced.note ?? '', /open miorail\.xyz in your phone’s browser/);
  // Even a baseAccount connector that slipped into the list is not offered there.
  const leaked = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT],
    inBaseApp: true,
    hasWindowProvider: true,
    mobile: true,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(leaked), ['Base App wallet']);
});

test('inside Farcaster: the wallet Farcaster announces, no Base Account popup and no app links', () => {
  // The mini app SDK relays Farcaster's EIP-6963 announcement; no window.ethereum.
  const FARCASTER: WalletConnectorViewV1 = { id: 'farcaster', name: 'Farcaster Wallet', type: 'injected', icon: 'data:image/png;base64,AA==' };
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT, FARCASTER],
    inBaseApp: false,
    inFarcaster: true,
    hasWindowProvider: false,
    mobile: true,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(result), ['Farcaster Wallet']);
  assert.equal(result.choices[0]!.detail, 'The wallet Farcaster gives this page.');
  assert.equal(
    result.note,
    'Inside Farcaster a page can use only the wallet Farcaster gives it. To connect MetaMask or a Base Account, open miorail.xyz in your phone’s browser.',
  );
});

test('a desktop browser with nothing installed says so, and still offers Base Account', () => {
  const result = walletChoicesV1({
    connectors: [GENERIC, BASE_ACCOUNT],
    inBaseApp: false,
    hasWindowProvider: false,
    mobile: false,
    pageUrl: PAGE,
  });
  assert.deepEqual(names(result), ['Base Account']);
  assert.match(result.note ?? '', /Install MetaMask or Coinbase Wallet and reload, or use Base Account/);
});

test('names and devices', () => {
  assert.equal(walletDisplayNameV1(GENERIC, false), 'Browser wallet');
  assert.equal(walletDisplayNameV1(GENERIC, true), 'Base App wallet');
  assert.equal(walletDisplayNameV1(METAMASK, false), 'MetaMask');
  assert.equal(walletDisplayNameV1(null, false), 'your wallet');
  assert.equal(openInMetaMaskHrefV1('http://localhost:5173/signin?next=%2Fstocks'), 'https://link.metamask.io/dapp/localhost:5173/signin?next=%2Fstocks');
  assert.equal(openInBaseAppHrefV1('https://miorail.xyz/'), 'https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fmiorail.xyz%2F');
  assert.equal(isMobileBrowserV1({ userAgent: BASE_APP_UA }), true);
  assert.equal(isMobileBrowserV1({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile Safari/537.36' }), true);
  assert.equal(isMobileBrowserV1({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowserV1({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', maxTouchPoints: 0 }), false);
  assert.equal(isMobileBrowserV1({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' }), false);
});
