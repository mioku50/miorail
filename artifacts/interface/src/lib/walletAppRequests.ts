// ---------------------------------------------------------------------------
// A wallet app paired by WalletConnect approves in another app. On a phone,
// a request the page sends there (the sign-in, a loan, a payment) waits in
// MetaMask until the person opens it, and nothing on the page said so. This
// counts the requests that need the person's approval, so the page can say
// "approve in MetaMask" with a link that brings it forward, and tries once to
// bring it forward itself.
//
// Only what a wallet asks the person about is counted: reading accounts,
// chains or call status needs nobody.
// ---------------------------------------------------------------------------

export const WALLET_APP_APPROVALS_V1: ReadonlySet<string> = new Set([
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_sendCalls',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_grantPermissions',
]);

export interface WalletAppProviderV1 {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

let pending = 0;
const listeners = new Set<() => void>();
const tracked = new WeakSet<object>();
const emit = () => { for (const listener of listeners) listener(); };

/** How many requests are waiting for the person in the wallet app now. */
export function walletAppPendingV1(): number {
  return pending;
}

export function subscribeWalletAppPendingV1(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Counts this provider's requests that need approval, once per provider. `onApproval` runs as each is sent. */
export function trackWalletAppRequestsV1(provider: WalletAppProviderV1, onApproval?: (method: string) => void): void {
  if (tracked.has(provider)) return;
  tracked.add(provider);
  const request = provider.request.bind(provider);
  provider.request = async (args) => {
    if (!WALLET_APP_APPROVALS_V1.has(args.method)) return request(args);
    pending += 1;
    emit();
    try {
      const answer = request(args);
      onApproval?.(args.method);
      return await answer;
    } finally {
      pending = Math.max(0, pending - 1);
      emit();
    }
  };
}
