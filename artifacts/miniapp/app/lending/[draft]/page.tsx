"use client";
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAccount, useCapabilities, useSendCalls } from 'wagmi';
import { useSession, useSponsoredGasStatus } from '@mioagent/api-client-react';
import { LendingReviewScreen, lendingFeeNoteV1, useLendingReviewConsoleV1 } from '@mioagent/ui';
import { useStillSkyV1, useStillClientPaletteV1 } from '@mioagent/ui/still';
import { builderCodeFromEnvV1 } from '@mioagent/route-domain/builder-code';
import { builderCodeToDataSuffix, isWalletRejectionError, paymasterServiceSupportV1, sendCallsCapabilitiesV1, sponsoredGasPlanV1 } from '@mioagent/wallet-actions';
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
  const palette = useStillClientPaletteV1(sky);
  const { address } = useAccount(), sendCalls = useSendCalls();
  // Still pays a batch's network fee when the arm offers it and the wallet takes a fee sponsor
  // (2026-11-08), as on the web; after the wallet failed with the sponsor, the next press goes without one.
  const capabilities = useCapabilities({ account: address, query: { enabled: Boolean(address), retry: false, staleTime: Number.POSITIVE_INFINITY } });
  const sponsoredGas = useSponsoredGasStatus({ enabled: Boolean(session.data?.user) });
  const [sponsorDeclined, setSponsorDeclined] = useState(false);
  const feeNote = lendingFeeNoteV1({
    loansSponsored: sponsoredGas.data?.sponsoredGas === 'on' && sponsoredGas.data.scope === 'reviewed_stock_swaps_and_still_loans',
    walletTakesSponsor: sponsorDeclined ? false : paymasterServiceSupportV1(capabilities.data),
    dailyLimitPerWallet: sponsoredGas.data?.dailyLimitPerWallet ?? null,
  });
  const review = useLendingReviewConsoleV1({ draft, walletAddress: address ?? null,
    sessionWalletAddress: session.data?.user?.address ?? null, feeNote,
    sendCalls: async ({ calls, sponsorship }) => {
      const gas = sponsoredGasPlanV1({ offer: sponsorship ?? null, capabilities: capabilities.data, declinedBefore: sponsorDeclined });
      try {
        const result = await sendCalls.mutateAsync({ chainId: 8453, forceAtomic: true,
          calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
          capabilities: sendCallsCapabilitiesV1({ suffix: LENDING_BUILDER_SUFFIX_V1, sponsor: gas.capability }),
        });
        return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
      } catch (error) {
        // Whatever else failed, the next press must not depend on the sponsor; the person's own No is not the sponsor's.
        if (gas.capability && !isWalletRejectionError(error)) setSponsorDeclined(true);
        throw error;
      }
    },
  });
  return <main className="still" data-sky={palette} style={{ minHeight: '100dvh', padding: '16px 0 32px' }}>
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
