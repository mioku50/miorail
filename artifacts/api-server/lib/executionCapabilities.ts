// T19.1: single source of truth for the split execution-capability flags.
// `status.ts` returns these to the UI; the legacy `/execute` route gates on
// `serverBroadcastEnabled`. The user-confirmed Base Account flow
// (`userConfirmedEnabled`) is a SEPARATE concern and must never be used to
// authorize a server broadcast.
//
// Production baseline: CHAIN_ENV=mainnet-readonly, MAINNET_EXECUTION_ENABLED=false
//  → serverBroadcastEnabled=false, mainnetExecutionEnabled=false,
//    userConfirmedEnabled=false, mode='read-only'.

export type ExecutionMode = 'read-only' | 'user-confirmed' | 'server-execution';

export interface ExecutionCapabilities {
  mode: ExecutionMode;
  /** Base Account wallet_sendCalls flow is activated for this environment. */
  userConfirmedEnabled: boolean;
  /** Legacy /execute server-broadcast capability (testnet only). */
  serverBroadcastEnabled: boolean;
  /** === MAINNET_EXECUTION_ENABLED === 'true'. Stays false in production. */
  mainnetExecutionEnabled: boolean;
  /** Back-compat alias === serverBroadcastEnabled. */
  broadcastEnabled: boolean;
  reason: string;
}

export function getExecutionCapabilities(chainEnv: string): ExecutionCapabilities {
  const isReadonly = chainEnv === 'mainnet-readonly';
  const mainnetExecutionEnabled = process.env.MAINNET_EXECUTION_ENABLED === 'true';
  const isMainnet = chainEnv === 'mainnet';
  // Mainnet is never server-broadcast by design. Activation only exposes the
  // Base Account user-confirmed EIP-5792 flow.
  const serverBroadcastEnabled = chainEnv === 'sepolia';
  const userConfirmedEnabled = chainEnv === 'sepolia' || (isMainnet && mainnetExecutionEnabled);

  const mode: ExecutionMode = serverBroadcastEnabled
    ? 'server-execution'
    : userConfirmedEnabled
      ? 'user-confirmed'
      : 'read-only';

  const reason = isReadonly
    ? 'Mainnet read-only; transaction preparation is disabled'
    : serverBroadcastEnabled
      ? 'Server-broadcast enabled (testnet/dev); user-confirmed flow also available'
      : userConfirmedEnabled
        ? 'Mainnet user-confirmed via Base Account; server never signs or broadcasts'
        : 'Transaction preparation is disabled';

  return {
    mode,
    userConfirmedEnabled,
    serverBroadcastEnabled,
    mainnetExecutionEnabled,
    broadcastEnabled: serverBroadcastEnabled,
    reason,
  };
}
