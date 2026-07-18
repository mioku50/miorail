"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import {
  logoutWalletSession,
  useBoundedProofReconciliation,
  useEvaluateSwapRoute,
  usePrepareSwapBlueprint,
  useSession,
  useVerifyWallet,
  useWalletChallenge,
} from "@mioagent/api-client-react";
import { ExecutionProofPanel, RoutePlanView, SubmissionStatus, routePlanSurfaceState } from "@mioagent/ui";
import { BlueprintSubmitButton, type BlueprintSubmitStatus } from "@mioagent/wallet-actions";
import { WalletConnect } from "./WalletConnect";

const BUILDER_CODE = process.env.NEXT_PUBLIC_BUILDER_CODE;

const EXAMPLES = [
  "Swap 100 USDC to ETH using the best net result.",
  "Обменяй 100 USDC на ETH с минимальными комиссиями.",
];

interface BlueprintSubmissionState {
  status: BlueprintSubmitStatus;
  batchId: string | null;
  txHashes: string[];
  error: string | null;
  // T58: Route Proof handle captured from the submission record.
  proofId: string | null;
  recordedFinalStatus: string | null;
}

/** Submission statuses after which bounded reconciliation may start. */
const RECONCILABLE_SUBMISSION_STATUSES: BlueprintSubmitStatus[] = ["confirmed", "failed", "submitted_unknown"];

function routeSessionMatches(
  sessionAddress: string | undefined,
  walletAddress: string | undefined,
  chainId: number | undefined,
): boolean {
  return Boolean(
    sessionAddress &&
      walletAddress &&
      chainId === 8453 &&
      sessionAddress.toLowerCase() === walletAddress.toLowerCase(),
  );
}

export function RoutePlanHome() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync, isPending: switchingChain } = useSwitchChain();
  const queryClient = useQueryClient();
  const session = useSession({ retry: false, staleTime: 0 });
  const challenge = useWalletChallenge();
  const verify = useVerifyWallet();
  const evaluation = useEvaluateSwapRoute();
  const prepare = usePrepareSwapBlueprint();
  const [message, setMessage] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedCandidateHash, setSelectedCandidateHash] = useState<string | null>(null);
  const [submission, setSubmission] = useState<BlueprintSubmissionState | null>(null);

  const sessionReady = routeSessionMatches(session.data?.user?.address, address, chainId);
  const signing = challenge.isPending || verify.isPending;

  const continueWithWallet = async () => {
    if (!address || chainId !== 8453 || signing) return;
    setAuthError(null);
    try {
      if (session.data?.user) await logoutWalletSession();
      const nextChallenge = await challenge.mutateAsync({ address });
      const signature = await signMessageAsync({ message: nextChallenge.message });
      const authenticated = await verify.mutateAsync({
        message: nextChallenge.message,
        signature,
      });
      queryClient.setQueryData(["session"], authenticated);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Wallet authentication failed");
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    }
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!sessionReady || !address || !message.trim() || evaluation.isPending) return;
    prepare.reset();
    setSubmission(null);
    evaluation.mutate({
      message,
      walletAddress: address.toLowerCase() as `0x${string}`,
    });
  };

  const result = evaluation.data;
  const surfaceState = routePlanSurfaceState({
    isPending: evaluation.isPending,
    isError: evaluation.isError,
    outcome: result?.outcome,
  });

  const reviewTransaction = (candidateHash: string) => {
    if (!address || result?.outcome !== "evaluated" || !result.routeCard) return;
    setSubmission(null);
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: result.routeCard.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  // T58: bounded reconciliation — starts only once the wallet flow is
  // terminal AND a Route Proof id was recorded; one reconcile + a strictly
  // bounded GET poll (same hook as the web interface).
  const reconciliation = useBoundedProofReconciliation({
    proofId: submission?.proofId ?? null,
    routeRunId: prepare.data?.outcome === "prepared" ? prepare.data.routeRunId : null,
    walletAddress: address ? (address.toLowerCase() as `0x${string}`) : null,
    enabled: Boolean(
      submission && submission.proofId && RECONCILABLE_SUBMISSION_STATUSES.includes(submission.status),
    ),
  });

  // T57: submission block for a prepared review — the same hook/components as
  // the web interface. The server approve response is the only source of the
  // wallet payload; this only mounts the button and mirrors its state.
  const transactionSubmission =
    prepare.data?.outcome === "prepared" ? (
      <div className="space-y-3">
        <BlueprintSubmitButton
          routeRunId={prepare.data.routeRunId}
          blueprintId={prepare.data.blueprint.id}
          blueprintHash={prepare.data.blueprint.blueprintHash}
          quoteExpiry={prepare.data.blueprint.quoteExpiry}
          builderCode={BUILDER_CODE}
          onStateChange={setSubmission}
        />
        {submission && submission.status !== "idle" && (
          <SubmissionStatus
            state={submission.status}
            batchId={submission.batchId}
            transactionHashes={submission.txHashes}
            error={submission.error}
          />
        )}
        {reconciliation.proof && (
          <ExecutionProofPanel proof={reconciliation.proof} lifecycle={reconciliation.lifecycle ?? "approved"} />
        )}
      </div>
    ) : null;
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line px-4"
        style={{
          background: "rgba(14,18,38,0.82)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-pop">Miorail · Base</p>
          <p className="font-display text-base font-semibold">Plan</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/history"
            className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink-2"
            style={{ textDecoration: "none" }}
          >
            History
          </Link>
          <WalletConnect />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {!isConnected && (
          <section className="rounded-2xl border border-line bg-panel p-5 text-center">
            <h1 className="font-display text-xl font-semibold">Connect a wallet to compare routes</h1>
            <p className="mt-2 text-sm text-ink-2">The comparison is private and read-only. It never prepares a transaction.</p>
            <div className="mt-4 flex justify-center"><WalletConnect /></div>
          </section>
        )}

        {isConnected && chainId !== 8453 && (
          <section className="rounded-2xl border border-warn/40 bg-warn-soft p-5 text-center">
            <h1 className="font-display text-xl font-semibold">Base Mainnet required</h1>
            <button
              type="button"
              disabled={switchingChain}
              onClick={() => void switchChainAsync({ chainId: 8453 })}
              className="mt-4 rounded-full border border-warn px-4 py-2 text-sm font-semibold text-warn disabled:opacity-40"
            >
              {switchingChain ? "Switching…" : "Switch to Base Mainnet"}
            </button>
          </section>
        )}

        {isConnected && chainId === 8453 && !sessionReady && (
          <section className="rounded-2xl border border-line bg-panel p-5 text-center">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">Private route plan</p>
            <h1 className="mt-2 font-display text-xl font-semibold">Continue with your wallet</h1>
            <p className="mt-2 text-sm text-ink-2">One identity signature opens the plan. It does not approve or send a transaction.</p>
            <button
              type="button"
              disabled={session.isPending || signing}
              onClick={() => void continueWithWallet()}
              className="mt-4 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {session.isPending ? "Checking session…" : signing ? "Waiting for wallet…" : "Continue with current wallet"}
            </button>
            {authError && <p className="mt-3 text-xs text-risk">{authError}</p>}
          </section>
        )}

        {sessionReady && (
          <>
            <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-5">
              <div className="absolute bottom-0 left-5 top-0 w-px bg-accent/40" aria-hidden="true" />
              <div className="pl-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-pop">Route intelligence</p>
                <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">What do you want to do on Base?</h1>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">Compare current Uniswap and KyberSwap evidence without preparing a transaction.</p>
              </div>
              <form onSubmit={submit} className="mt-5 pl-4">
                <label htmlFor="mini-route-goal" className="sr-only">Swap goal</label>
                <textarea
                  id="mini-route-goal"
                  rows={4}
                  maxLength={4000}
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    if (evaluation.data || evaluation.error) evaluation.reset();
                    if (prepare.data || prepare.error) prepare.reset();
                    setSelectedCandidateHash(null);
                  }}
                  placeholder="Swap 100 USDC to ETH using the best net result."
                  className="w-full resize-none rounded-xl border border-line bg-bg/60 px-3 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-accent"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="font-mono text-[9px] text-ink-3">Read-only · {message.length}/4000</span>
                  <button
                    type="submit"
                    disabled={!message.trim() || evaluation.isPending}
                    className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {evaluation.isPending ? "Comparing…" : "Compare routes"}
                  </button>
                </div>
              </form>
              <div className="mt-4 flex flex-wrap gap-2 pl-4">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => {
                      setMessage(example);
                      evaluation.reset();
                    }}
                    className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-left text-[10px] text-ink-2"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </section>

            <section aria-live="polite">
              {surfaceState === "loading" && (
                <div className="rounded-2xl border border-line bg-panel p-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent-2">Comparing providers</p>
                  <p className="mt-2 text-sm text-ink-2">Checking quote freshness, score evidence and liquidity provenance…</p>
                </div>
              )}
              {surfaceState === "error" && (
                <div className="rounded-2xl border border-risk/35 bg-risk-soft p-5">
                  <h2 className="font-display text-lg font-semibold">The comparison could not be completed</h2>
                  <p className="mt-2 text-sm text-ink-2">{evaluation.error?.message}</p>
                  <button type="button" onClick={() => submit()} className="mt-4 rounded-full border border-risk px-4 py-2 text-sm font-semibold text-risk">Retry comparison</button>
                </div>
              )}
              {surfaceState === "clarification" && result?.outcome === "needs_clarification" && (
                <div className="rounded-2xl border border-warn/35 bg-warn-soft p-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-warn">Clarification needed</p>
                  <h2 className="mt-2 font-display text-lg font-semibold">{result.clarification.message}</h2>
                  <p className="mt-2 text-sm text-ink-2">Add: {result.clarification.missingFields.join(", ")}.</p>
                </div>
              )}
              {surfaceState === "rejection" && result?.outcome === "rejected" && (
                <div className="rounded-2xl border border-risk/35 bg-risk-soft p-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-risk">Request rejected</p>
                  <ul className="mt-3 space-y-2 text-sm text-ink-2">
                    {result.issues.map((issue) => <li key={`${issue.code}:${issue.field}`}>{issue.message}</li>)}
                  </ul>
                </div>
              )}
              {surfaceState === "evaluated" && result?.outcome === "evaluated" && (
                <RoutePlanView
                  projection={result.projection}
                  onRefresh={() => submit()}
                  selectedCandidateHash={selectedCandidateHash}
                  onSelectCandidate={setSelectedCandidateHash}
                  onReviewTransaction={reviewTransaction}
                  reviewPending={prepare.isPending}
                  transactionReview={prepare.data ?? null}
                  transactionReviewError={prepare.isError ? prepare.error : null}
                  transactionSubmission={transactionSubmission}
                />
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export const routePlanMiniappState = { routeSessionMatches };
