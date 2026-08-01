// T19.1: single source of truth for the split execution-capability flags.
// `status.ts` returns these to the UI; the legacy `/execute` route gates on
// `serverBroadcastEnabled`. The user-confirmed Base Account flow
// (`userConfirmedEnabled`) is a SEPARATE concern and must never be used to
// authorize a server broadcast.
//
// Production baseline: CHAIN_ENV=mainnet-readonly, MAINNET_EXECUTION_ENABLED=false
//  → serverBroadcastEnabled=false, mainnetExecutionEnabled=false,
//    userConfirmedEnabled=false, mode='read-only'.
//
// T67X-B2: mainnet execution additionally requires a usable Builder Code. See
// `attributionBlockedReason` below for why that is a gate and not a warning,
// and for why it stops at EXECUTION rather than at the server.

import { builderCodeAdviceV1, resolveBuilderCodeV1 } from '@mioagent/route-domain';

export type ExecutionMode = 'read-only' | 'user-confirmed' | 'server-execution';

export type ExecutionBlockedReasonV1 =
  | 'builder_code_missing'
  | 'builder_code_invalid'
  | 'builder_code_conflict';

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
  /** T67X-B2: a Builder Code resolves and every batch this server hands to a
   * wallet can be attributed. False does NOT mean the server is unhealthy —
   * every read-only capability is unaffected. */
  attributionReady: boolean;
  /** Why execution is withheld, when it is withheld for attribution. */
  attributionBlockedReason?: ExecutionBlockedReasonV1;
  reason: string;
}

/**
 * T67X-B2 — why a missing Builder Code blocks mainnet execution.
 *
 * Attribution failure is silent. An unattributed transaction is accepted by the
 * chain, confirmed, and indistinguishable from an attributed one at every point
 * a human would look. There is no error to notice and no metric that moves. The
 * only moment the configuration can be caught is before the first batch goes
 * out, which is here.
 *
 * It stops at execution and nowhere else. Quotes, comparison, evidence,
 * scoring, B20 inspection, history and public proofs do not touch a wallet, so
 * none of them is worse off for the code being absent, and taking the whole
 * server down over an attribution identifier would be a far larger outage than
 * the problem.
 *
 * Testnet is exempt. A developer running sepolia locally has no attribution to
 * lose, and refusing to execute would make a clean checkout unusable for the
 * one thing it is for.
 */
function attributionGateV1(env: NodeJS.ProcessEnv): {
  ready: boolean;
  reason?: ExecutionBlockedReasonV1;
  advice: string | null;
} {
  const resolution = resolveBuilderCodeV1(env);
  if (resolution.status === 'resolved') return { ready: true, advice: builderCodeAdviceV1(resolution) };
  const reason: ExecutionBlockedReasonV1 =
    resolution.status === 'conflict'
      ? 'builder_code_conflict'
      : resolution.status === 'invalid'
        ? 'builder_code_invalid'
        : 'builder_code_missing';
  return { ready: false, reason, advice: builderCodeAdviceV1(resolution) };
}

export function getExecutionCapabilities(
  chainEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionCapabilities {
  const isReadonly = chainEnv === 'mainnet-readonly';
  const mainnetExecutionEnabled = env.MAINNET_EXECUTION_ENABLED === 'true';
  const isMainnet = chainEnv === 'mainnet';
  // Mainnet is never server-broadcast by design. Activation only exposes the
  // Base Account user-confirmed EIP-5792 flow.
  const serverBroadcastEnabled = chainEnv === 'sepolia';
  const wantsUserConfirmed = chainEnv === 'sepolia' || (isMainnet && mainnetExecutionEnabled);

  const attribution = attributionGateV1(env);
  // Only mainnet execution is gated — see attributionGateV1.
  const attributionBlocks = isMainnet && wantsUserConfirmed && !attribution.ready;
  const userConfirmedEnabled = wantsUserConfirmed && !attributionBlocks;

  const mode: ExecutionMode = serverBroadcastEnabled
    ? 'server-execution'
    : userConfirmedEnabled
      ? 'user-confirmed'
      : 'read-only';

  const reason = attributionBlocks
    ? `Mainnet execution is withheld: ${attribution.advice} Read-only route intelligence is unaffected.`
    : isReadonly
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
    attributionReady: attribution.ready,
    ...(attributionBlocks ? { attributionBlockedReason: attribution.reason } : {}),
    reason,
  };
}
