"use client";
import { useRef } from "react";
import { useParams } from "next/navigation";
import { useAccount, useConfig, useSendCalls } from "wagmi";
import { useStatus } from "@mioagent/api-client-react";
import {
  StockActionReviewScreen,
  useStockActionReviewConsoleV1,
} from "@mioagent/ui";
import { builderCodeFromEnvV1 } from "@mioagent/route-domain/builder-code";
import { SubmissionRecoveryRail, attributedCallsV1, builderCodeToDataSuffix, gasLimitedCallsV1, isWalletRejectionError, publicGasMeterV1, requireLiveWalletAccountV1,
  sendCallsKeepingCallCapabilitiesV1, useWalletBatchSupportV1 } from "@mioagent/wallet-actions";

// ---------------------------------------------------------------------------
// Phase 17.7 — the review, in Base App.
//
// This surface had no review tab at all. An assistant could prepare an action
// for somebody sitting in Base App — the one place where a wallet is ALREADY in
// their hand — and there was nowhere to confirm it or sign what it authorised.
// The link opened a browser instead, which then had to connect a wallet the
// reader was already inside of.
//
// Not a port. `useStockActionReviewConsoleV1` holds every read and every
// refusal sentence, and `StockActionReviewScreen` holds every word, so this
// file is only what genuinely differs here: the wallet, and the absence of a
// comparison board (that lives on the Stocks tab, which this reader can open).
// ---------------------------------------------------------------------------

const BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(
  builderCodeFromEnvV1({
    NEXT_PUBLIC_BASE_BUILDER_CODE: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE,
    NEXT_PUBLIC_BUILDER_CODE: process.env.NEXT_PUBLIC_BUILDER_CODE,
  }),
);

export default function BaseAppStockActionReviewPage() {
  const params = useParams<{ draft?: string }>();
  const draft = typeof params?.draft === "string" ? decodeURIComponent(params.draft) : null;
  const { address, chainId } = useAccount();
  const sendCalls = useSendCalls();
  const config = useConfig();
  const walletBatches = useWalletBatchSupportV1();
  const status = useStatus();
  // Set once a send that carried measured gas failed for a reason but the person's own No: the next press
  // goes with the wallet's own estimate.
  const gasLimitsDeclined = useRef(false);

  const reviewConsole = useStockActionReviewConsoleV1({
    draft,
    sendCalls: async ({ calls, atomicRequired, from }) => {
      // A restored connection is brought back before the wallet is asked (2026-11-09), and the send names
      // the account the server released these calls for, from the session that reviewed them. It was the
      // account the wallet had selected: a review made for one was asked of another (audit N13-3).
      await requireLiveWalletAccountV1(config, from);
      const { capabilities } = await walletBatches.readNow();
      // Each call's gas, measured, for a wallet that takes it, as on the web: Base Account gives a batch none
      // to spare (2026-11-12), and a stock bought or sold here is the same multi-pool swap (audit WAL-6).
      const sized = await gasLimitedCallsV1({ from, ...publicGasMeterV1(config),
        // A wallet that drops `dataSuffix` gets the code in each call's own data, as on the web (audit WAL-5).
        calls: attributedCallsV1({ calls: calls as { to: string; data?: string }[], suffix: BUILDER_SUFFIX_V1, capabilities }),
        capabilities: atomicRequired && !gasLimitsDeclined.current ? capabilities : undefined });
      const requestCapabilities = BUILDER_SUFFIX_V1
        ? { dataSuffix: { value: BUILDER_SUFFIX_V1, optional: true } }
        : undefined;
      try {
        const result = sized.limits
          // viem drops a call's own capabilities, so calls carrying their gas go as the same request, sent directly.
          ? await sendCallsKeepingCallCapabilitiesV1(config, { account: from, chainId: 8453, forceAtomic: atomicRequired, calls: sized.calls, capabilities: requestCapabilities })
          : await sendCalls.mutateAsync({
            account: from,
            calls: sized.calls as never,
            chainId: 8453,
            forceAtomic: atomicRequired,
            capabilities: requestCapabilities,
          });
        return typeof result === "string" ? result : ((result as { id?: string })?.id ?? null);
      } catch (error) {
        if (sized.limits && !isWalletRejectionError(error)) gasLimitsDeclined.current = true;
        throw error;
      }
    },
  });

  return (
    <main className="mio-console">
      {/* A purchase whose wallet answer was never heard is held until the person has checked the wallet (audit N13-2). */}
      <SubmissionRecoveryRail
        compact
        walletAddress={address ?? null}
        chainId={chainId ?? null}
        enabled={Boolean(status.data?.productMigration?.submissionRecoveryV1)}
      />
      <StockActionReviewScreen model={reviewConsole.model} />
    </main>
  );
}
