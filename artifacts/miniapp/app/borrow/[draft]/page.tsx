"use client";
import { useParams } from "next/navigation";
import { useSendCalls } from "wagmi";
import { BorrowReviewScreen, useBorrowReviewConsoleV1 } from "@mioagent/ui";
import { builderCodeFromEnvV1 } from "@mioagent/route-domain/builder-code";
import { builderCodeToDataSuffix } from "@mioagent/wallet-actions";

// ---------------------------------------------------------------------------
// The borrow review, in Base App.
//
// The same shared screen the web mounts. Not a port: `useBorrowReviewConsoleV1`
// holds the read and every refusal sentence, `BorrowReviewScreen` holds every
// word, and this file is only what genuinely differs here — the wallet.
//
// Base App is where a reader already has a wallet in their hand, so it is the
// surface where the distance between "I read what this does" and "I signed it"
// is shortest. That is a reason for the screen to be identical, not lighter.
// ---------------------------------------------------------------------------

const BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(
  builderCodeFromEnvV1({
    NEXT_PUBLIC_BASE_BUILDER_CODE: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE,
    NEXT_PUBLIC_BUILDER_CODE: process.env.NEXT_PUBLIC_BUILDER_CODE,
  }),
);

export default function BaseAppBorrowReviewPage() {
  const params = useParams<{ draft?: string }>();
  const draft = typeof params?.draft === "string" ? decodeURIComponent(params.draft) : null;
  const sendCalls = useSendCalls();

  const reviewConsole = useBorrowReviewConsoleV1({
    draft,
    sendCalls: async ({ calls }) => {
      const result = await sendCalls.mutateAsync({
        calls: calls as never,
        chainId: 8453,
        // A batch with no dataSuffix loses Builder Code attribution silently.
        capabilities: BUILDER_SUFFIX_V1
          ? { dataSuffix: { value: BUILDER_SUFFIX_V1, optional: true } }
          : undefined,
      });
      return typeof result === "string" ? result : ((result as { id?: string })?.id ?? null);
    },
  });

  return (
    <main className="mio-console">
      <BorrowReviewScreen model={reviewConsole.model} />
    </main>
  );
}
