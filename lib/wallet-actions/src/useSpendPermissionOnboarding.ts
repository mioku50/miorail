import { useCallback, useState } from 'react';
import { isWalletRejectionError } from './useSubmitApprovedBlueprint';

// ---------------------------------------------------------------------------
// T71 — granting a Base Spend Permission, from the client's side.
//
// Three steps and one rule: the CLIENT decides nothing.
//
//   prepare  — the server says which spender, token, chain, allowance and
//              period to ask for.
//   wallet   — the user's Base Account signs exactly that. Miorail never signs,
//              and there is no key in this process.
//   confirm  — the server re-derives the permission hash on chain, re-checks
//              every binding against its own values, and only then creates a
//              budget.
//
// A wallet rejection ends the flow HERE. Nothing is sent to the server, because
// there is nothing to send: a declined prompt produced no permission, and a
// server that heard about it would have to be told by a client it cannot
// verify.
//
// Every dependency is injected. That is not test convenience — it is what keeps
// this file free of a wallet SDK, an RPC endpoint and a network client, so the
// only thing it can do wrong is call them in the wrong order.
// ---------------------------------------------------------------------------

export type SpendPermissionFlowStatusV1 =
  | 'idle'
  /** Asking the server what to request. */
  | 'preparing'
  /** The wallet prompt is open. The user has not answered. */
  | 'awaiting_wallet'
  /** The wallet signed; the server is checking the chain. */
  | 'verifying'
  | 'active'
  /** The user declined. Nothing exists anywhere. */
  | 'wallet_rejected'
  /** The chain or the binding said no. Retrying the same grant will not help. */
  | 'verification_failed'
  /** The chain could not be asked, or the permission is not visible yet. */
  | 'verification_retryable'
  /** Something else went wrong before a wallet was ever opened. */
  | 'failed';

/** What the server told us to ask for. Passed to the wallet unchanged. */
export interface PreparedPermissionV1 {
  account: string;
  spender: string;
  token: string;
  chainId: number;
  allowanceAtomic: string;
  periodInDays: number;
  consent: string[];
  recipientLabel: string;
}

/** Exactly what `requestSpendPermission` returns. */
export interface WalletGrantedPermissionV1 {
  signature: string;
  chainId?: number;
  permissionHash?: string;
  permission: {
    account: string;
    spender: string;
    token: string;
    allowance: string;
    period: number;
    start: number;
    end: number;
    salt: string;
    extraData: string;
  };
}

export interface ConfirmResultV1 {
  outcome: 'activated' | 'refused' | 'verification_unavailable';
  refusal: string | null;
  detail: string;
  retryable: boolean;
}

export interface UseSpendPermissionOnboardingArgs {
  prepare: (limits: { periodLimitUsdc: string; maxPerCallUsdc: string }) => Promise<PreparedPermissionV1>;
  /** The Base Account call. Injected so this module imports no wallet SDK. */
  requestPermission: (request: {
    account: string;
    spender: string;
    token: string;
    chainId: number;
    allowance: bigint;
    periodInDays: number;
  }) => Promise<WalletGrantedPermissionV1>;
  confirm: (input: {
    permission: WalletGrantedPermissionV1;
    periodLimitUsdc: string;
    maxPerCallUsdc: string;
  }) => Promise<ConfirmResultV1>;
}

export interface UseSpendPermissionOnboardingResultV1 {
  status: SpendPermissionFlowStatusV1;
  /** One sentence for the user. Never a raw wallet or server message. */
  detail: string | null;
  /** The consent lines the server produced, once prepare has answered. */
  consent: string[];
  pending: boolean;
  enable: (limits: { periodLimitUsdc: string; maxPerCallUsdc: string }) => Promise<void>;
  reset: () => void;
}

/** What a user is told at each stop. The wallet's own text is never shown:
 * wallet errors are written for developers and read like a fault. */
export const SPEND_PERMISSION_FLOW_COPY_V1: Record<SpendPermissionFlowStatusV1, string | null> = {
  idle: null,
  preparing: 'Checking what Miorail needs to ask your wallet for…',
  awaiting_wallet: 'Approve the spending permission in your Base Account. Miorail cannot sign it for you.',
  verifying: 'Your wallet signed. Miorail is checking the permission on Base before switching anything on.',
  active: 'Paid evidence is active. Miorail can now buy evidence within the limits you set.',
  wallet_rejected:
    'You declined the permission, so nothing was created and nothing was charged. Free route comparison is unaffected.',
  verification_failed: null,
  verification_retryable: null,
  failed:
    'Miorail could not start the permission flow, so your wallet was never asked. Nothing was created and free route comparison is unaffected.',
};

export function useSpendPermissionOnboarding(
  args: UseSpendPermissionOnboardingArgs,
): UseSpendPermissionOnboardingResultV1 {
  const [status, setStatus] = useState<SpendPermissionFlowStatusV1>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [consent, setConsent] = useState<string[]>([]);

  const reset = useCallback(() => {
    setStatus('idle');
    setDetail(null);
  }, []);

  const enable = useCallback(
    async (limits: { periodLimitUsdc: string; maxPerCallUsdc: string }) => {
      setStatus('preparing');
      setDetail(SPEND_PERMISSION_FLOW_COPY_V1.preparing);

      let prepared: PreparedPermissionV1;
      try {
        prepared = await args.prepare(limits);
        setConsent(prepared.consent);
      } catch {
        // Before the wallet: nothing was asked of the user at all.
        setStatus('failed');
        setDetail(SPEND_PERMISSION_FLOW_COPY_V1.failed);
        return;
      }

      let granted: WalletGrantedPermissionV1;
      setStatus('awaiting_wallet');
      setDetail(SPEND_PERMISSION_FLOW_COPY_V1.awaiting_wallet);
      try {
        granted = await args.requestPermission({
          // Every field is the server's. Nothing here is derived, defaulted or
          // adjusted — a client that "fixed" one of these would produce a
          // permission the server then refuses.
          account: prepared.account,
          spender: prepared.spender,
          token: prepared.token,
          chainId: prepared.chainId,
          // `BigInt(...)`, never a literal: this package is compiled at a target
          // where `0n` is a syntax error.
          allowance: BigInt(prepared.allowanceAtomic),
          periodInDays: prepared.periodInDays,
        });
      } catch (error) {
        // A decline is not a failure, and the two must never share a message.
        // Nothing is reported to the server: a declined prompt produced no
        // permission, so there is nothing to report.
        const rejected = isWalletRejectionError(error);
        setStatus(rejected ? 'wallet_rejected' : 'failed');
        setDetail(
          rejected ? SPEND_PERMISSION_FLOW_COPY_V1.wallet_rejected : SPEND_PERMISSION_FLOW_COPY_V1.failed,
        );
        return;
      }

      setStatus('verifying');
      setDetail(SPEND_PERMISSION_FLOW_COPY_V1.verifying);
      let result: ConfirmResultV1;
      try {
        result = await args.confirm({ permission: granted, ...limits });
      } catch {
        // The wallet DID sign. Saying "nothing happened" here would be wrong —
        // the permission may well exist on chain — so this is the retryable
        // state, not the failed one.
        setStatus('verification_retryable');
        setDetail(
          'Your wallet signed, but Miorail could not confirm it just now. Nothing has been charged — try again in a moment.',
        );
        return;
      }

      if (result.outcome === 'activated') {
        setStatus('active');
        setDetail(result.detail || SPEND_PERMISSION_FLOW_COPY_V1.active);
        return;
      }
      setStatus(result.retryable ? 'verification_retryable' : 'verification_failed');
      setDetail(result.detail);
    },
    [args],
  );

  return {
    status,
    detail,
    consent,
    pending: status === 'preparing' || status === 'awaiting_wallet' || status === 'verifying',
    enable,
    reset,
  };
}
