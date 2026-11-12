// ---------------------------------------------------------------------------
// Which wallets a person can connect HERE, from what the page can actually see.
//
// Until 2026-09-24 the page chose for them: the first wallet a browser
// announced, else Base Account. A MetaMask user got MetaMask whether they
// wanted it or not, a phone browser offered Base Account and nothing else, and
// nothing on the screen said another wallet was possible — "this cuts off many
// people", as the operator put it after opening it in Base App.
//
// Offered, in order:
//   1. every wallet this browser announces (EIP-6963), by its own name — or,
//      when a host injects one without announcing it, that one;
//   2. Base Account, which needs nothing installed (never inside Base App or
//      Farcaster, where its popup cannot open — see main.tsx);
//   3. on a phone with no wallet in the page: MetaMask by WalletConnect, which
//      keeps the page in this browser (2026-11-03, the operator: "Open in
//      MetaMask" opened the page inside MetaMask, where it should come back to
//      Safari), then links that reopen this same page inside MetaMask or Base
//      App, where their wallet connects.
// ---------------------------------------------------------------------------

export interface WalletConnectorViewV1 {
  id: string;
  name: string;
  type: string;
  icon?: string | undefined;
}

export type WalletChoiceV1 =
  | { kind: 'connector'; key: string; connectorId: string; name: string; icon: string | null; detail: string;
      /** A WalletConnect pairing this wallet app is opened to approve. */
      pairWith?: 'metamask' }
  | { kind: 'open_in'; key: string; name: string; href: string; detail: string };

export interface WalletChoicesV1 {
  choices: WalletChoiceV1[];
  /** What the list cannot offer here, and what to do instead. */
  note: string | null;
}

/** wagmi's generic connector for whatever sits at `window.ethereum`. */
const GENERIC_INJECTED_ID = 'injected';

/** A wallet's name as a person knows it — never wagmi's "Injected" or "WalletConnect". */
export function walletDisplayNameV1(connector: { id: string; name: string; type?: string } | null | undefined, inBaseApp: boolean): string {
  if (!connector) return 'your wallet';
  if (connector.id === GENERIC_INJECTED_ID) return inBaseApp ? 'Base App wallet' : 'Browser wallet';
  // The page pairs WalletConnect only through MetaMask's own link (choice 3 below).
  if (connector.type === 'walletConnect') return 'MetaMask';
  return connector.name.trim() || 'your wallet';
}

/** MetaMask's documented deeplink: the page's own URL, less its scheme, as the path. */
export function openInMetaMaskHrefV1(pageUrl: string): string {
  return `https://link.metamask.io/dapp/${pageUrl.replace(/^https?:\/\//i, '')}`;
}

/** MetaMask's WalletConnect deeplink: the app opens on the pairing, and the page stays in this browser. */
export function metaMaskPairHrefV1(uri: string): string {
  return `https://link.metamask.io/wc?uri=${encodeURIComponent(uri)}`;
}

/** The same pairing by MetaMask's own scheme, which a page can open without leaving itself when the app is not there. */
export function metaMaskPairSchemeV1(uri: string): string {
  return `metamask://wc?uri=${encodeURIComponent(uri)}`;
}

/** Brings MetaMask forward for a request already sent to it over WalletConnect. */
export const METAMASK_OPEN_HREF_V1 = 'metamask://';

/** Coinbase Wallet's documented deeplink; Base App is the same app. */
export function openInBaseAppHrefV1(pageUrl: string): string {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(pageUrl)}`;
}

/** The Base Account connector, where main.tsx built one: never inside Base App or Farcaster. */
export function baseAccountConnectorV1<T extends WalletConnectorViewV1>(connectors: readonly T[]): T | null {
  return connectors.find((connector) => connector.type === 'baseAccount' || connector.id === 'baseAccount') ?? null;
}

/**
 * The connector a "Create a wallet" press opens, or null where the button has
 * nothing to do (2026-11-12).
 *
 * It is Base Account: its window creates a wallet with a passkey, or opens the
 * one a person already has. There is none to open inside Base App or Farcaster,
 * where main.tsx builds no Base Account and the host's own wallet is the page's.
 * A wallet already connected here is one the person has: they sign in with it.
 */
export function createWalletConnectorIdV1(input: { connectors: readonly WalletConnectorViewV1[]; connected: boolean }): string | null {
  if (input.connected) return null;
  return baseAccountConnectorV1(input.connectors)?.id ?? null;
}

/** A phone or tablet, where wallets are apps rather than extensions. */
export function isMobileBrowserV1(input: { userAgent: string; maxTouchPoints?: number }): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(input.userAgent)) return true;
  // iPadOS asks for the desktop site and says "Macintosh".
  return /Macintosh/i.test(input.userAgent) && (input.maxTouchPoints ?? 0) > 1;
}

export function walletChoicesV1(input: {
  connectors: readonly WalletConnectorViewV1[];
  inBaseApp: boolean;
  /** Running as a Farcaster mini app (lib/miniAppHost.ts). */
  inFarcaster?: boolean;
  hasWindowProvider: boolean;
  mobile: boolean;
  pageUrl: string;
}): WalletChoicesV1 {
  const choices: WalletChoiceV1[] = [];
  const seen = new Set<string>();
  // An app that hosts the page gives it one wallet, and only that one.
  const host = input.inBaseApp ? 'Base App' : input.inFarcaster ? 'Farcaster' : null;

  // 1. What this browser announced. The generic connector reaches the same
  // wallet a second time, so it is offered only when nothing announced itself
  // and something really is at window.ethereum — a configured connector is not
  // an injected provider.
  const announced = input.connectors.filter(
    (connector) => connector.type === 'injected' && connector.id !== GENERIC_INJECTED_ID,
  );
  for (const connector of announced) {
    if (seen.has(connector.id)) continue;
    seen.add(connector.id);
    choices.push({
      kind: 'connector',
      key: `connector:${connector.id}`,
      connectorId: connector.id,
      name: walletDisplayNameV1(connector, input.inBaseApp),
      icon: connector.icon?.trim() ? connector.icon : null,
      detail: host ? `The wallet ${host} gives this page.` : 'Found in this browser.',
    });
  }
  const generic = input.connectors.find((connector) => connector.id === GENERIC_INJECTED_ID);
  if (announced.length === 0 && input.hasWindowProvider && generic) {
    choices.push({
      kind: 'connector',
      key: `connector:${generic.id}`,
      connectorId: generic.id,
      name: walletDisplayNameV1(generic, input.inBaseApp),
      icon: null,
      detail: host ? `The wallet ${host} gives this page.` : 'The wallet this browser gives the page.',
    });
  }
  const walletInPage = choices.length > 0;

  if (host) {
    return {
      choices,
      note: `Inside ${host} a page can use only the wallet ${host} gives it. To connect MetaMask or a Base Account, open miorail.xyz in your phone’s browser.`,
    };
  }

  // 2. Base Account: a passkey, nothing to install, works in any browser. Its
  // window makes a new wallet as readily as it opens one, so this row is also
  // where a person with no wallet at all begins.
  const baseAccount = baseAccountConnectorV1(input.connectors);
  if (baseAccount) {
    choices.push({
      kind: 'connector',
      key: `connector:${baseAccount.id}`,
      connectorId: baseAccount.id,
      name: 'Base Account',
      icon: baseAccount.icon?.trim() ? baseAccount.icon : null,
      detail: 'Create one with a passkey, or use yours: nothing to install. Miorail offers to pay its network fee on stock trades and Still loans.',
    });
  }

  // 3. A phone browser has no wallet of its own; the wallet apps do.
  if (!walletInPage && input.mobile) {
    // WalletConnect keeps the page here: MetaMask opens only to approve.
    const paired = input.connectors.find((connector) => connector.type === 'walletConnect');
    if (paired) {
      choices.push({
        kind: 'connector',
        key: `connector:${paired.id}`,
        connectorId: paired.id,
        name: 'MetaMask',
        icon: null,
        detail: 'Stays in this browser: MetaMask opens to approve, then you come back here.',
        pairWith: 'metamask',
      });
    }
    choices.push(
      {
        kind: 'open_in',
        key: 'open_in:metamask',
        name: 'MetaMask',
        href: openInMetaMaskHrefV1(input.pageUrl),
        detail: paired
          ? 'Opens this page inside the MetaMask app instead, where your MetaMask wallet connects.'
          : 'Opens this page in the MetaMask app, where your MetaMask wallet connects.',
      },
      {
        kind: 'open_in',
        key: 'open_in:base-app',
        name: 'Base App (Coinbase Wallet)',
        href: openInBaseAppHrefV1(input.pageUrl),
        detail: 'Opens this page in Base App, where its wallet connects.',
      },
    );
  }

  return {
    choices,
    note:
      !walletInPage && !input.mobile
        ? 'No wallet extension found in this browser. Install MetaMask or Coinbase Wallet and reload, or use Base Account.'
        : null,
  };
}
