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
//   2. Base Account, which needs nothing installed (never inside Base App,
//      where its popup cannot open — see main.tsx);
//   3. on a phone with no wallet in the page, links that reopen this same page
//      inside MetaMask or Base App, where their wallet connects.
// ---------------------------------------------------------------------------

export interface WalletConnectorViewV1 {
  id: string;
  name: string;
  type: string;
  icon?: string | undefined;
}

export type WalletChoiceV1 =
  | { kind: 'connector'; key: string; connectorId: string; name: string; icon: string | null; detail: string }
  | { kind: 'open_in'; key: string; name: string; href: string; detail: string };

export interface WalletChoicesV1 {
  choices: WalletChoiceV1[];
  /** What the list cannot offer here, and what to do instead. */
  note: string | null;
}

/** wagmi's generic connector for whatever sits at `window.ethereum`. */
const GENERIC_INJECTED_ID = 'injected';

/** A wallet's name as a person knows it — never wagmi's "Injected". */
export function walletDisplayNameV1(connector: { id: string; name: string } | null | undefined, inBaseApp: boolean): string {
  if (!connector) return 'your wallet';
  if (connector.id === GENERIC_INJECTED_ID) return inBaseApp ? 'Base App wallet' : 'Browser wallet';
  return connector.name.trim() || 'your wallet';
}

/** MetaMask's documented deeplink: the page's own URL, less its scheme, as the path. */
export function openInMetaMaskHrefV1(pageUrl: string): string {
  return `https://link.metamask.io/dapp/${pageUrl.replace(/^https?:\/\//i, '')}`;
}

/** Coinbase Wallet's documented deeplink; Base App is the same app. */
export function openInBaseAppHrefV1(pageUrl: string): string {
  return `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(pageUrl)}`;
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
  hasWindowProvider: boolean;
  mobile: boolean;
  pageUrl: string;
}): WalletChoicesV1 {
  const choices: WalletChoiceV1[] = [];
  const seen = new Set<string>();

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
      detail: input.inBaseApp ? 'The wallet Base App gives this page.' : 'Found in this browser.',
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
      detail: input.inBaseApp ? 'The wallet Base App gives this page.' : 'The wallet this browser gives the page.',
    });
  }
  const walletInPage = choices.length > 0;

  if (input.inBaseApp) {
    return {
      choices,
      note: 'Inside Base App a page can use only the wallet Base App gives it. To connect MetaMask or a Base Account, open miorail.xyz in your phone’s browser.',
    };
  }

  // 2. Base Account: a passkey, nothing to install, works in any browser.
  const baseAccount = input.connectors.find((connector) => connector.type === 'baseAccount' || connector.id === 'baseAccount');
  if (baseAccount) {
    choices.push({
      kind: 'connector',
      key: `connector:${baseAccount.id}`,
      connectorId: baseAccount.id,
      name: 'Base Account',
      icon: baseAccount.icon?.trim() ? baseAccount.icon : null,
      detail: 'A passkey wallet — nothing to install. Miorail offers to pay its network fee on stock trades.',
    });
  }

  // 3. A phone browser has no wallet of its own; the wallet apps do.
  if (!walletInPage && input.mobile) {
    choices.push(
      {
        kind: 'open_in',
        key: 'open_in:metamask',
        name: 'MetaMask',
        href: openInMetaMaskHrefV1(input.pageUrl),
        detail: 'Opens this page in the MetaMask app, where your MetaMask wallet connects.',
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
