"use client";
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAccount, useSendCalls } from 'wagmi';
import { useSession } from '@mioagent/api-client-react';
import { LendingReviewScreen, useLendingReviewConsoleV1 } from '@mioagent/ui';
import { useStillSkyV1 } from '@mioagent/ui/still';
import { builderCodeFromEnvV1 } from '@mioagent/route-domain/builder-code';
import { builderCodeToDataSuffix } from '@mioagent/wallet-actions';
import { WalletConnect } from '../../components/WalletConnect';
import '@mioagent/ui/still.css';

const LENDING_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeFromEnvV1({
  NEXT_PUBLIC_BASE_BUILDER_CODE: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE,
  NEXT_PUBLIC_BUILDER_CODE: process.env.NEXT_PUBLIC_BUILDER_CODE,
}));

export default function BaseAppLendingReviewPage() {
  const params = useParams<{ draft?: string }>();
  const draft = typeof params?.draft === 'string' ? params.draft : null;
  const session = useSession({ retry: false, staleTime: 0 }), sky = useStillSkyV1();
  const { address } = useAccount(), sendCalls = useSendCalls();
  const review = useLendingReviewConsoleV1({ draft, walletAddress: address ?? null,
    sessionWalletAddress: session.data?.user?.address ?? null,
    sendCalls: async ({ calls }) => {
      const result = await sendCalls.mutateAsync({ chainId: 8453, forceAtomic: true,
        calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
        capabilities: LENDING_BUILDER_SUFFIX_V1 ? { dataSuffix: { value: LENDING_BUILDER_SUFFIX_V1, optional: true } } : undefined,
      });
      return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
    },
  });
  return <main className="still" data-sky={sky.phase} style={{ minHeight: '100dvh', padding: '16px 0 32px' }}>
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header className="still-section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Link href="/">Back to Miorail</Link><WalletConnect />
      </header>
      {!session.data?.user && !session.isPending ? <p className="still-section still-note">
        Connecting is separate from signing in. <a href={`/signin?next=${encodeURIComponent(`/app/lending/${draft ?? ''}`)}`}>Sign in to this review</a>.
      </p> : null}
      <LendingReviewScreen model={review.model} />
    </div>
  </main>;
}
