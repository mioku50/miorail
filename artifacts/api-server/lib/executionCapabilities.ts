// T19.1: single source of truth for the split execution-capability flags.
// `status.ts` returns these to the UI; the legacy `/execute` route gates on
// `serverBroadcastEnabled`. The user-confirmed Base Account flow
// (`userConfirmedEnabled`) is a SEPARATE concern and must never be used to
// authorize a server broadcast.
//
// Production baseline: CHAIN_ENV=mainnet-readonly, MAINNET_EXECUTION_ENABLED=false
//  → serverBroadcastEnabled=false, mainnetExecutionEnabled=false,
//    userConfirmedEnabled=true, mode='user-confirmed'.

export type ExecutionMode = 'read-only' | 'user-confirmed' | 'server-execution';

export interface ExecutionCapabilities {
  mode: ExecutionMode;
  /** Base Account wallet_sendCalls flow is available (always true today). */
  userConfirmedEnabled: boolean;
  /** Legacy /execute server-broadcast capability (testnet, or mainnet+flag). */
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
  // Server may broadcast only off-mainnet-readonly AND (not mainnet, or the
  // mainnet flag is explicitly on). This is the ONLY flag that authorizes a
  // server-side broadcast.
  const serverBroadcastEnabled = !isReadonly && (chainEnv !== 'mainnet' || mainnetExecutionEnabled);
  const userConfirmedEnabled = true;

  const mode: ExecutionMode = serverBroadcastEnabled
    ? 'server-execution'
    : userConfirmedEnabled
      ? 'user-confirmed'
      : 'read-only';

  const reason = isReadonly
    ? 'User-confirmed flow via Base Account; server never broadcasts'
    : serverBroadcastEnabled
      ? 'Server-broadcast enabled (testnet/dev); user-confirmed flow also available'
      : 'User-confirmed flow via Base Account; server-broadcast disabled';

  return {
    mode,
    userConfirmedEnabled,
    serverBroadcastEnabled,
    mainnetExecutionEnabled,
    broadcastEnabled: serverBroadcastEnabled,
    reason,
  };
}
