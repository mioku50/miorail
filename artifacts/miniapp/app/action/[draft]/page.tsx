"use client";
import { useParams } from "next/navigation";
import { useAccount, useConfig, useSendCalls } from "wagmi";
import { useStatus } from "@mioagent/api-client-react";
import {
  StockActionReviewScreen,
  useStockActionReviewConsoleV1,
} from "@mioagent/ui";
import { builderCodeFromEnvV1 } from "@mioagent/route-domain/builder-code";
import { SubmissionRecoveryRail, attributedCallsV1, builderCodeToDataSuffix, requireLiveWalletAccountV1, useWalletBatchSupportV1 } from "@mioagent/wallet-actions";

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

  const reviewConsole = useStockActionReviewConsoleV1({
    draft,
    sendCalls: async ({ calls, atomicRequired, from }) => {
      // A restored connection is brought back before the wallet is asked (2026-11-09), and the send names
      // the account the server released these calls for, from the session that reviewed them. It was the
      // account the wallet had selected: a review made for one was asked of another (audit N13-3).
      await requireLiveWalletAccountV1(config, from);
      // A wallet that drops `dataSuffix` gets the code in each call's own data, as on the web (audit WAL-5).
      const { capabilities } = await walletBatches.readNow();
      const result = await sendCalls.mutateAsync({
        account: from,
        calls: attributedCallsV1({ calls: calls as { data?: string }[], suffix: BUILDER_SUFFIX_V1, capabilities }) as never,
        chainId: 8453,
        forceAtomic: atomicRequired,
        capabilities: BUILDER_SUFFIX_V1
          ? { dataSuffix: { value: BUILDER_SUFFIX_V1, optional: true } }
          : undefined,
      });
      return typeof result === "string" ? result : ((result as { id?: string })?.id ?? null);
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
