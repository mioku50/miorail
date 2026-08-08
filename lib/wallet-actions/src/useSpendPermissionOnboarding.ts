import { useCallback, useRef, useState } from 'react';
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
// T71.1 — AND A SIGNED PERMISSION IS NOT THROWN AWAY.
//
// A real grant went: prepare 200, wallet approved, confirm 200, budget null,
// screen "Not configured". The 200 was a typed non-activated outcome —
// `not_approved_onchain`, the chain not having caught up with a permission that
// had just been signed — and the flow treated it as the end of the road. The
// user's only route back was the button that opens the wallet again, to sign a
// second permission for a grant that already existed.
//
// So the grant is kept, and verification is retried against it: three checks
// over about ten seconds, then a button. Nothing re-signs, nothing re-prepares,
// and only outcomes the SERVER marked retryable are ever tried again.
//
// Every dependency is injected, including the clock. That is not test
// convenience — it is what keeps this file free of a wallet SDK, an RPC
// endpoint and a network client, so the only thing it can do wrong is call them
// in the wrong order.
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

export interface SpendPermissionLimitsV1 {
  periodLimitUsdc: string;
  maxPerCallUsdc: string;
}

export interface ConfirmResultV1 {
  outcome: 'activated' | 'refused' | 'verification_unavailable';
  refusal: string | null;
  detail: string;
  retryable: boolean;
  /** The activated budget, so the caller can show it without waiting for a
   * refetch. Absent on every non-activated outcome. */
  budget?: unknown;
}

/**
 * A permission the wallet has already signed, with the limits it was signed
 * for. Held so verification can be retried WITHOUT reopening the wallet — a
 * second prompt would ask the user to sign a second permission for a grant that
 * already exists on chain.
 */
export interface SpendPermissionGrantV1 {
  permission: WalletGrantedPermissionV1;
  limits: SpendPermissionLimitsV1;
}

/** Three checks over about ten seconds. Enough for a permission that is simply
 * not indexed yet; short enough that a user is not left watching a spinner
 * while the real answer is "this will never work". */
export const SPEND_PERMISSION_VERIFY_ATTEMPTS_V1 = 3;
export const SPEND_PERMISSION_VERIFY_INTERVAL_MS_V1 = 3_500;

export interface SpendPermissionFlowStateV1 {
  status: SpendPermissionFlowStatusV1;
  detail: string | null;
  consent: string[];
  /** The server's own last word. `null` until confirm has answered once. */
  outcome: ConfirmResultV1['outcome'] | null;
  refusal: string | null;
  grant: SpendPermissionGrantV1 | null;
  /** Which verification check we are on, 1-based. */
  attempt: number;
  budget: unknown | null;
}

export const SPEND_PERMISSION_INITIAL_STATE_V1: SpendPermissionFlowStateV1 = {
  status: 'idle',
  detail: null,
  consent: [],
  outcome: null,
  refusal: null,
  grant: null,
  attempt: 0,
  budget: null,
};

export type SpendPermissionEmitV1 = (patch: Partial<SpendPermissionFlowStateV1>) => void;

export interface UseSpendPermissionOnboardingArgs {
  prepare: (limits: SpendPermissionLimitsV1) => Promise<PreparedPermissionV1>;
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
  /** Injected so a test does not wait ten real seconds. */
  wait?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export interface UseSpendPermissionOnboardingResultV1 {
  status: SpendPermissionFlowStatusV1;
  /** One sentence for the user. Never a raw wallet or server message. */
  detail: string | null;
  /** The consent lines the server produced, once prepare has answered. */
  consent: string[];
  pending: boolean;
  outcome: ConfirmResultV1['outcome'] | null;
  refusal: string | null;
  attempt: number;
  /** True when a signed permission is in hand and the server called its own
   * answer retryable. The panel offers "Retry verification", never a wallet. */
  canRetryVerification: boolean;
  enable: (limits: SpendPermissionLimitsV1) => Promise<void>;
  /** Re-runs confirm against the SAME permission. Opens no wallet. */
  retryVerification: () => Promise<void>;
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

/** The sentence shown between checks. Says what is happening and what is not:
 * "checking" without "your permission is signed" reads like the grant failed. */
export function verifyingAgainCopyV1(attempt: number, attempts: number): string {
  return `Your permission is signed. Base has not confirmed it yet — checking again (${attempt} of ${attempts}). Nothing has been charged.`;
}

const defaultWaitV1 = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms an already-signed permission, retrying only what the server says may
 * be retried.
 *
 * Pure and injectable end to end: no React, no timers of its own, no wallet. The
 * whole sequence a user can experience is therefore testable in milliseconds,
 * which is the only reason the retry behaviour can be trusted at all.
 */
export async function verifySpendPermissionGrantV1(
  deps: Pick<UseSpendPermissionOnboardingArgs, 'confirm'> & {
    wait: (ms: number) => Promise<void>;
    attempts: number;
    intervalMs: number;
  },
  grant: SpendPermissionGrantV1,
  emit: SpendPermissionEmitV1,
): Promise<void> {
  const attempts = Math.max(1, deps.attempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    emit({
      status: 'verifying',
      attempt,
      detail: attempt === 1 ? SPEND_PERMISSION_FLOW_COPY_V1.verifying : verifyingAgainCopyV1(attempt, attempts),
    });

    let result: ConfirmResultV1;
    try {
      result = await deps.confirm({ permission: grant.permission, ...grant.limits });
    } catch {
      // The wallet DID sign. Saying "nothing happened" here would be wrong — the
      // permission may well exist on chain — so this is the retryable state,
      // and the grant is kept so the user can try again without signing again.
      if (attempt < attempts) {
        await deps.wait(deps.intervalMs);
        continue;
      }
      emit({
        status: 'verification_retryable',
        outcome: null,
        refusal: null,
        detail:
          'Your wallet signed, but Miorail could not reach the server to confirm it. Nothing has been charged — try the check again.',
      });
      return;
    }

    if (result.outcome === 'activated') {
      emit({
        status: 'active',
        outcome: 'activated',
        refusal: null,
        detail: result.detail || SPEND_PERMISSION_FLOW_COPY_V1.active,
        budget: result.budget ?? null,
        // Nothing left to retry, and nothing left to re-sign.
        grant: null,
      });
      return;
    }

    // Only the SERVER decides what may be tried again. A client that decided for
    // itself would eventually retry a permission for the wrong token forever.
    if (!result.retryable) {
      emit({
        status: 'verification_failed',
        outcome: result.outcome,
        refusal: result.refusal,
        detail: result.detail,
        // Kept anyway: the panel shows what was refused, and a user who fixes
        // nothing should not be offered a retry — `canRetryVerification` is
        // gated on the status, not on the presence of a grant.
        grant,
      });
      return;
    }

    if (attempt < attempts) {
      await deps.wait(deps.intervalMs);
      continue;
    }

    emit({
      status: 'verification_retryable',
      outcome: result.outcome,
      refusal: result.refusal,
      detail: result.detail,
      grant,
    });
  }
}

/**
 * The whole flow: prepare, wallet, verify.
 *
 * Also pure. The hook below is a thin state container around it.
 */
export async function runSpendPermissionOnboardingV1(
  deps: UseSpendPermissionOnboardingArgs & {
    wait: (ms: number) => Promise<void>;
    attempts: number;
    intervalMs: number;
  },
  limits: SpendPermissionLimitsV1,
  emit: SpendPermissionEmitV1,
): Promise<void> {
  emit({ status: 'preparing', detail: SPEND_PERMISSION_FLOW_COPY_V1.preparing, outcome: null, refusal: null, grant: null });

  let prepared: PreparedPermissionV1;
  try {
    prepared = await deps.prepare(limits);
    emit({ consent: prepared.consent });
  } catch {
    // Before the wallet: nothing was asked of the user at all.
    emit({ status: 'failed', detail: SPEND_PERMISSION_FLOW_COPY_V1.failed });
    return;
  }

  emit({ status: 'awaiting_wallet', detail: SPEND_PERMISSION_FLOW_COPY_V1.awaiting_wallet });
  let granted: WalletGrantedPermissionV1;
  try {
    granted = await deps.requestPermission({
      // Every field is the server's. Nothing here is derived, defaulted or
      // adjusted — a client that "fixed" one of these would produce a permission
      // the server then refuses.
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
    emit({
      status: rejected ? 'wallet_rejected' : 'failed',
      detail: rejected ? SPEND_PERMISSION_FLOW_COPY_V1.wallet_rejected : SPEND_PERMISSION_FLOW_COPY_V1.failed,
    });
    return;
  }

  const grant: SpendPermissionGrantV1 = { permission: granted, limits };
  emit({ grant });
  await verifySpendPermissionGrantV1(deps, grant, emit);
}

export function useSpendPermissionOnboarding(
  args: UseSpendPermissionOnboardingArgs,
): UseSpendPermissionOnboardingResultV1 {
  const [state, setState] = useState<SpendPermissionFlowStateV1>(SPEND_PERMISSION_INITIAL_STATE_V1);
  // The grant has to be readable from inside a callback that was created before
  // it existed, so it is mirrored here. `state` remains the thing rendered.
  const grantRef = useRef<SpendPermissionGrantV1 | null>(null);

  const emit = useCallback<SpendPermissionEmitV1>((patch) => {
    if ('grant' in patch) grantRef.current = patch.grant ?? null;
    setState((current) => ({ ...current, ...patch }));
  }, []);

  const deps = {
    ...args,
    wait: args.wait ?? defaultWaitV1,
    attempts: args.attempts ?? SPEND_PERMISSION_VERIFY_ATTEMPTS_V1,
    intervalMs: args.intervalMs ?? SPEND_PERMISSION_VERIFY_INTERVAL_MS_V1,
  };
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const reset = useCallback(() => {
    grantRef.current = null;
    setState(SPEND_PERMISSION_INITIAL_STATE_V1);
  }, []);

  const enable = useCallback(
    async (limits: SpendPermissionLimitsV1) => {
      await runSpendPermissionOnboardingV1(depsRef.current, limits, emit);
    },
    [emit],
  );

  const retryVerification = useCallback(async () => {
    const grant = grantRef.current;
    // No grant means no signature, and a "retry" that opened the wallet would
    // be a different action wearing this one's label.
    if (!grant) return;
    await verifySpendPermissionGrantV1(depsRef.current, grant, emit);
  }, [emit]);

  return {
    status: state.status,
    detail: state.detail,
    consent: state.consent,
    pending: state.status === 'preparing' || state.status === 'awaiting_wallet' || state.status === 'verifying',
    outcome: state.outcome,
    refusal: state.refusal,
    attempt: state.attempt,
    canRetryVerification: state.status === 'verification_retryable' && state.grant !== null,
    enable,
    retryVerification,
    reset,
  };
}
