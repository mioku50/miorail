import { useRoute } from 'wouter';
import { useAccount, useSendCalls } from 'wagmi';
import { LendingReviewScreen, useLendingReviewConsoleV1 } from '@mioagent/ui';
import { StillFrame } from '@mioagent/ui/still';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from '../still/useStillSky';

const LENDING_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
}));

/** The host supplies the wallet; the shared controller owns fresh review,
 * changed-terms confirmation, submission locking and status reading. */
export function LendingReviewPage() {
  const [, params] = useRoute('/lending/:draft');
  const [, legacyParams] = useRoute('/borrow/:draft');
  const sky = useStillSky(), session = useStillWallet();
  const { address } = useAccount(), sendCalls = useSendCalls();
  const review = useLendingReviewConsoleV1({ draft: params?.draft ?? legacyParams?.draft ?? null,
    sessionWalletAddress: session.signedIn ? session.wallet : null, walletAddress: address ?? null,
    sendCalls: async ({ calls }) => {
      const result = await sendCalls.mutateAsync({ chainId: 8453, forceAtomic: true,
        calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
        capabilities: LENDING_BUILDER_SUFFIX_V1 ? { dataSuffix: { value: LENDING_BUILDER_SUFFIX_V1, optional: true } } : undefined,
      });
      return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
    },
  });
  return <StillFrame tab="assets" sky={sky}>{session.booting
    ? <p className="still-section still-note" role="status">Checking your sign-in…</p>
    : <LendingReviewScreen model={review.model} />}</StillFrame>;
}
