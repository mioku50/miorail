export function isBaseAppEnvironment(input: {
  connectorId?: string;
  connectorName?: string;
  userAgent?: string;
  provider?: unknown;
}): boolean {
  const id = String(input.connectorId || '').toLowerCase();
  const userAgent = String(input.userAgent || '').toLowerCase();

  // The explicit baseAccount connector is the normal-web popup flow, not the
  // embedded BaseApp context. A normal Coinbase Wallet browser extension also
  // exposes `isCoinbaseWallet`, so provider branding alone is deliberately not
  // enough to select native BaseApp execution.
  if (id === 'baseaccount' || id === 'base-account') return false;
  if (id !== 'injected') return false;
  return /baseapp|coinbasewallet|cbwallet/.test(userAgent);
}
