import { useCallback, useMemo } from 'react';
import { useAccount } from 'wagmi';
import {
  useConfirmSpendPermission,
  usePrepareSpendPermission,
} from '@mioagent/api-client-react';
import {
  useSpendPermissionOnboarding,
  type WalletGrantedPermissionV1,
} from './useSpendPermissionOnboarding';

// ---------------------------------------------------------------------------
// T71 — the binding between the generic onboarding flow and a wagmi wallet.
//
// ONE implementation, used by both the web console and the Base App miniapp.
// Two would be two payment paths, and the second one is always the one that
// skips a check.
//
// `useSpendPermissionOnboarding` takes its three effects as arguments so it can
// be tested without a wallet, a network or a browser. This file supplies them,
// and is therefore the only place that touches the Base Account SDK.
//
// The SDK is imported LAZILY, inside the call. `@base-org/account` pulls in
// provider, store and popup code that has no business in the bundle of a user
// who never opens Settings — and the same dynamic-import treatment is already
// how the wallet-actions bundle is kept out of the initial load.
// ---------------------------------------------------------------------------

export interface SpendPermissionGrantV1 {
  status: ReturnType<typeof useSpendPermissionOnboarding>['status'];
  detail: string | null;
  consent: string[];
  pending: boolean;
  /** T71.1 — a signed permission is in hand and the server said its own answer
   * may be retried. The panel offers a check, never a second wallet prompt. */
  canRetryVerification: boolean;
  /** Re-runs confirm against the permission the wallet already signed. */
  retryVerification: () => void;
  enable: (limits: { monthlyLimitUsdc: string; maxPerRequestUsdc: string }) => void;
}

export function useSpendPermissionGrant(): SpendPermissionGrantV1 {
  const { connector } = useAccount();
  const prepare = usePrepareSpendPermission();
  const confirm = useConfirmSpendPermission();

  const flow = useSpendPermissionOnboarding(
    useMemo(
      () => ({
        prepare: (limits: { periodLimitUsdc: string; maxPerCallUsdc: string }) =>
          prepare.mutateAsync(limits),

        requestPermission: async (request) => {
          if (!connector || typeof connector.getProvider !== 'function') {
            // No wallet, so nothing is asked and nothing is claimed. The flow
            // turns this into its `failed` state, which says the wallet was
            // never opened.
            throw new Error('no_wallet_connected');
          }
          const provider = await connector.getProvider();
          const { requestSpendPermission } = await import('@base-org/account/spend-permission');
          const granted = await requestSpendPermission({
            ...request,
            provider: provider as never,
          });
          return granted as unknown as WalletGrantedPermissionV1;
        },

        confirm: async (input) => {
          const result = await confirm.mutateAsync({
            // The wallet's own object. The chain id and hash are optional in
            // the SDK's type and required on the wire, so they are filled from
            // what the wallet returned — and the server recomputes the hash on
            // chain regardless, so a wrong one is refused rather than believed.
            permission: {
              signature: input.permission.signature,
              chainId: input.permission.chainId ?? 8453,
              permissionHash: input.permission.permissionHash ?? '0x',
              permission: input.permission.permission,
            },
            periodLimitUsdc: input.periodLimitUsdc,
            maxPerCallUsdc: input.maxPerCallUsdc,
          } as never);
          return {
            outcome: result.outcome,
            refusal: result.refusal,
            detail: result.detail,
            retryable: result.retryable,
            // Carried through so the flow can hand the activated budget straight
            // to the panel. The mutation has already written it to the query
            // cache; this is what stops the panel rendering "Not configured" for
            // the one render before the refetch lands.
            budget: result.budget ?? null,
          };
        },
      }),
      [connector, prepare, confirm],
    ),
  );

  const enable = useCallback(
    (limits: { monthlyLimitUsdc: string; maxPerRequestUsdc: string }) => {
      void flow.enable({
        periodLimitUsdc: limits.monthlyLimitUsdc,
        maxPerCallUsdc: limits.maxPerRequestUsdc,
      });
    },
    [flow],
  );

  const retryVerification = useCallback(() => {
    void flow.retryVerification();
  }, [flow]);

  return {
    status: flow.status,
    detail: flow.detail,
    consent: flow.consent,
    pending: flow.pending,
    canRetryVerification: flow.canRetryVerification,
    retryVerification,
    enable,
  };
}
