"use client";
import { useParams } from "next/navigation";
import { useAccount, useSendCalls } from "wagmi";
import { useRecordBlueprintSubmission } from "@mioagent/api-client-react";
import {
  StockActionReviewScreen,
  useStockActionReviewConsoleV1,
} from "@mioagent/ui";
import { builderCodeFromEnvV1 } from "@mioagent/route-domain/builder-code";
import { builderCodeToDataSuffix } from "@mioagent/wallet-actions";

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
  const { address } = useAccount();
  const sendCalls = useSendCalls();
  const recordSubmission = useRecordBlueprintSubmission();

  const reviewConsole = useStockActionReviewConsoleV1({
    draft,
    sendCalls: async ({ calls, atomicRequired }) => {
      const result = await sendCalls.mutateAsync({
        calls: calls as never,
        chainId: 8453,
        forceAtomic: atomicRequired,
        // A batch with no dataSuffix loses Builder Code attribution silently.
        capabilities: BUILDER_SUFFIX_V1
          ? { dataSuffix: { value: BUILDER_SUFFIX_V1, optional: true } }
          : undefined,
      });
      return typeof result === "string" ? result : ((result as { id?: string })?.id ?? null);
    },
    // The same submission-record route the web uses. Without it a batch signed
    // in Base App left no record anywhere in the app — the surface nearest the
    // wallet was the one that forgot fastest.
    recordSubmission: async ({ routeRunId, blueprintId, approvedCallsHash, batchId }) => {
      if (!address) return;
      return recordSubmission.mutateAsync({
        blueprintId,
        routeRunId,
        walletAddress: address,
        approvedCallsHash: approvedCallsHash as `0x${string}`,
        status: "submitted",
        batchId,
      });
    },
  });

  return (
    <main className="mio-console">
      <StockActionReviewScreen model={reviewConsole.model} />
    </main>
  );
}
