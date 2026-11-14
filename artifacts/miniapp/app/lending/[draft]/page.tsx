"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAccount, useCapabilities, useConfig, useSendCalls } from 'wagmi';
import { useSession, useSponsoredGasStatus } from '@mioagent/api-client-react';
import { LendingReviewScreen, lendingFeeNoteV1, useLendingReviewConsoleV1 } from '@mioagent/ui';
import { useStillSkyV1, useStillClientPaletteV1 } from '@mioagent/ui/still';
import { builderCodeFromEnvV1 } from '@mioagent/route-domain/builder-code';
import { builderCodeToDataSuffix, attributedCallsV1, gasLimitedCallsV1, isWalletRejectionError, paymasterServiceSupportV1, publicGasMeterV1, requireLiveWalletAccountV1,
  sendCallsCapabilitiesV1, sendCallsKeepingCallCapabilitiesV1, sponsoredGasPlanV1 } from '@mioagent/wallet-actions';
import { WalletConnect } from '../../components/WalletConnect';
import { MiniStillEligibilityLine, useMiniStillEligibilityV1 } from '../../components/StillEligibilityLine';
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
  const { address } = useAccount(), sendCalls = useSendCalls(), config = useConfig();
  // Still pays a batch's network fee when the arm offers it and the wallet takes a fee sponsor
  // (2026-11-08), as on the web; after the wallet failed with the sponsor, the next press goes without one.
  const capabilities = useCapabilities({ account: address, query: { enabled: Boolean(address), retry: false, staleTime: Number.POSITIVE_INFINITY } });
  const sponsoredGas = useSponsoredGasStatus({ enabled: Boolean(session.data?.user) });
  const [sponsorDeclined, setSponsorDeclined] = useState(false);
  const [gasLimitsDeclined, setGasLimitsDeclined] = useState(false);
  const feeNote = lendingFeeNoteV1({
    loansSponsored: sponsoredGas.data?.sponsoredGas === 'on' && sponsoredGas.data.scope === 'reviewed_stock_swaps_and_still_loans',
    walletTakesSponsor: sponsorDeclined ? false : paymasterServiceSupportV1(capabilities.data),
    dailyLimitPerWallet: sponsoredGas.data?.dailyLimitPerWallet ?? null,
  });
  // A new loan's review waits for this sign-in's confirmation, given in the line above it; once that lands,
  // a review refused for want of it is read again, once, as on the web (audit UI-15).
  const eligibility = useMiniStillEligibilityV1();
  const [reread, setReread] = useState(0);
  const review = useLendingReviewConsoleV1({ draft, walletAddress: address ?? null,
    sessionWalletAddress: session.data?.user?.address ?? null, feeNote, rereadKey: reread,
    sendCalls: async ({ calls, sponsorship, beforeWallet }) => {
      // A restored connection is brought back before the wallet is asked, and outside the try below:
      // a connection that was not ready is not the sponsor's failure (2026-11-09). The send names the
      // signed-in wallet, so a wallet that answers as another account is not asked (audit WAL-1).
      const owner = session.data?.user?.address as `0x${string}` | undefined;
      if (!owner) throw new Error('lending_identity_changed');
      const { restored } = await requireLiveWalletAccountV1(config, owner);
      // What was read through a restored record is no answer: it is asked again (audit WAL-5).
      const walletCapabilities = restored ? (await capabilities.refetch()).data : capabilities.data;
      const gas = sponsoredGasPlanV1({ offer: sponsorship ?? null, capabilities: walletCapabilities, declinedBefore: sponsorDeclined });
      // Each call's gas, measured, for a wallet that takes it: Base Account gives a batch none to spare (2026-11-12).
      const sized = await gasLimitedCallsV1({ from: owner, ...publicGasMeterV1(config),
        // A wallet that drops `dataSuffix` (MetaMask) gets the code in each call's own data.
        calls: attributedCallsV1({ calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
          suffix: LENDING_BUILDER_SUFFIX_V1, capabilities: walletCapabilities, sponsored: gas.state === 'sponsored' }),
        // After a send that carried them failed, the wallet's own estimate again.
        capabilities: gasLimitsDeclined ? undefined : walletCapabilities });
      const requestCapabilities = sendCallsCapabilitiesV1({ suffix: LENDING_BUILDER_SUFFIX_V1, sponsor: gas.capability });
      // The last step before the wallet opens, after every wait above: a person who left in them is not asked (audit WAL-3).
      await beforeWallet();
      try {
        const result = sized.limits
          // viem drops a call's own capabilities, so calls carrying their gas go as the same request, sent directly.
          ? await sendCallsKeepingCallCapabilitiesV1(config, { account: owner, chainId: 8453, forceAtomic: true, calls: sized.calls, capabilities: requestCapabilities })
          : await sendCalls.mutateAsync({ account: owner, chainId: 8453, forceAtomic: true, calls: sized.calls, capabilities: requestCapabilities });
        return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
      } catch (error) {
        // Whatever else failed, the next press must not depend on the sponsor; the person's own No is not the sponsor's.
        if (gas.capability && !isWalletRejectionError(error)) setSponsorDeclined(true);
        // Nor on the measured gas.
        if (sized.limits && !isWalletRejectionError(error)) setGasLimitsDeclined(true);
        throw error;
      }
    },
  });
  const waitingForConfirmation = review.model.body?.state === 'refused' && review.model.body.refusal === 'eligibility_required';
  useEffect(() => { if (eligibility.clear && waitingForConfirmation && reread === 0) setReread(1); }, [eligibility.clear, waitingForConfirmation, reread]);
  return <main className="still" data-sky={palette} style={{ minHeight: '100dvh', padding: '16px 0 32px' }}>
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header className="still-section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Link href="/">Back to Miorail</Link><WalletConnect />
      </header>
      {!session.data?.user && !session.isPending ? <p className="still-section still-note">
        Connecting is separate from signing in. <a href={`/signin?next=${encodeURIComponent(`/app/lending/${draft ?? ''}`)}`}>Sign in to this review</a>.
      </p> : null}
      <MiniStillEligibilityLine />
      <LendingReviewScreen model={review.model} />
    </div>
  </main>;
}
