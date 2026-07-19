import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { useAccount } from 'wagmi';
import { DeepVerification, ExecutionProofPanel, RoutePlanView, SubmissionStatus, routePlanSurfaceState, type DeepVerificationResultV1 } from '@mioagent/ui';
import {
  useBoundedProofReconciliation,
  useEvaluateSwapRoute,
  usePrepareSwapBlueprint,
  useStatus,
} from '@mioagent/api-client-react';
import { BlueprintSubmitButton, type BlueprintSubmitStatus } from '@mioagent/wallet-actions';
import { SimulateButton, type SimulateBlueprintResponseV1 } from '@mioagent/x402-actions';

// T59: adapts the wire SimulateBlueprintResponseV1 into lib/ui's
// surface-agnostic DeepVerificationResultV1 — lib/ui deliberately never
// imports api-zod/api-spec, so this mapping lives at the surface layer.
function toDeepVerificationResult(response: SimulateBlueprintResponseV1): DeepVerificationResultV1 | null {
  if (response.outcome === 'simulated' || response.outcome === 'cached') {
    return {
      outcome: response.outcome,
      provider: response.evidence.provider,
      blockNumber: response.evidence.blockNumber,
      simulationStatus: response.simulation.status === 'passed' || response.simulation.status === 'failed'
        ? response.simulation.status
        : 'unavailable',
      gasUsed: response.evidence.gasUsed,
      stateChanges: response.evidence.stateChanges,
      paidCostUsdc: response.evidence.paidCostUsdc,
      x402TxHash: response.evidence.x402TxHash,
      evidenceHash: response.evidence.evidenceHash,
      transactionSafety: 'not_scored',
      missingEvidence: response.scoreNote.missingEvidence,
    };
  }
  if (response.outcome === 'paid_service_failed' || response.outcome === 'invalid_response') {
    return {
      outcome: response.outcome,
      transactionSafety: 'not_scored',
      missingEvidence: [],
      reason: response.reason,
    };
  }
  // blueprint_expired / blocked: not rendered via DeepVerification — the
  // review projection itself already surfaces a blocked/expired state.
  return null;
}

const BUILDER_CODE = import.meta.env.VITE_BUILDER_CODE;

const EXAMPLES = [
  'Swap 100 USDC to ETH using the best net result.',
  'Обменяй 100 USDC на ETH с минимальными комиссиями.',
  'Compare Uniswap and KyberSwap.',
  'Use only Uniswap and verify the quote.',
];

interface BlueprintSubmissionState {
  status: BlueprintSubmitStatus;
  batchId: string | null;
  txHashes: string[];
  error: string | null;
  // T58: Route Proof handle captured from the submission record — enables
  // bounded reconciliation once the wallet flow is terminal.
  proofId: string | null;
  recordedFinalStatus: string | null;
}

/** Submission statuses after which reconciliation may start (the wallet flow
 * reported an outcome the server can now verify onchain). */
const RECONCILABLE_SUBMISSION_STATUSES: BlueprintSubmitStatus[] = ['confirmed', 'failed', 'submitted_unknown'];

export function PlanPage() {
  const { address } = useAccount();
  const [message, setMessage] = useState('');
  const [selectedCandidateHash, setSelectedCandidateHash] = useState<string | null>(null);
  const [submission, setSubmission] = useState<BlueprintSubmissionState | null>(null);
  const [simulateResponse, setSimulateResponse] = useState<SimulateBlueprintResponseV1 | null>(null);
  const evaluation = useEvaluateSwapRoute();
  const prepare = usePrepareSwapBlueprint();
  // T59: paid transaction simulation is gated on BOTH the server flag
  // (/api/status.productMigration.paidIntelligence) and a configured price
  // (prepare.data.simulationPriceUsdc) — never assumed available.
  const status = useStatus();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !message.trim() || evaluation.isPending) return;
    prepare.reset();
    setSubmission(null);
    setSimulateResponse(null);
    evaluation.mutate({ message, walletAddress: address.toLowerCase() as `0x${string}` });
  };

  const result = evaluation.data;
  const surfaceState = routePlanSurfaceState({
    isPending: evaluation.isPending,
    isError: evaluation.isError,
    outcome: result?.outcome,
  });

  const reviewTransaction = (candidateHash: string) => {
    if (!address || result?.outcome !== 'evaluated' || !result.routeCard) return;
    setSubmission(null);
    setSimulateResponse(null);
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: result.routeCard.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };

  // T58: bounded reconciliation starts only once the wallet flow is terminal
  // AND a Route Proof id was recorded. One reconcile POST + a strictly
  // bounded GET poll; the wallet hook itself never reconciles.
  const reconciliation = useBoundedProofReconciliation({
    proofId: submission?.proofId ?? null,
    routeRunId: prepare.data?.outcome === 'prepared' ? prepare.data.routeRunId : null,
    walletAddress: address ? (address.toLowerCase() as `0x${string}`) : null,
    enabled: Boolean(
      submission && submission.proofId && RECONCILABLE_SUBMISSION_STATUSES.includes(submission.status),
    ),
  });

  // T57: submission block for a prepared review. The server approve response
  // is the only source of the wallet payload; this only mounts the button and
  // mirrors its reported state into the read-only status panel.
  const transactionSubmission =
    prepare.data?.outcome === 'prepared' ? (
      <div className="space-y-3">
        <BlueprintSubmitButton
          routeRunId={prepare.data.routeRunId}
          blueprintId={prepare.data.blueprint.id}
          blueprintHash={prepare.data.blueprint.blueprintHash}
          quoteExpiry={prepare.data.blueprint.quoteExpiry}
          builderCode={BUILDER_CODE}
          onStateChange={setSubmission}
        />
        {submission && submission.status !== 'idle' && (
          <SubmissionStatus
            state={submission.status}
            batchId={submission.batchId}
            transactionHashes={submission.txHashes}
            error={submission.error}
          />
        )}
        {reconciliation.proof && (
          <ExecutionProofPanel proof={reconciliation.proof} lifecycle={reconciliation.lifecycle ?? 'approved'} />
        )}
      </div>
    ) : null;

  // T59: Deep verification only ever appears under a 'prepared' outcome,
  // only behind the server flag, and only when the server actually priced
  // the feature (simulationPriceUsdc non-null) — no client-invented price.
  const deepVerification =
    prepare.data?.outcome === 'prepared' && status.data?.productMigration.paidIntelligence && prepare.data.simulationPriceUsdc
      ? (() => {
          const priceLabel = `${prepare.data.simulationPriceUsdc} USDC`;
          return (
            <DeepVerification
              pending={
                simulateResponse
                  ? null
                  : {
                      priceLabel,
                      payButton: (
                        <SimulateButton
                          priceLabel={priceLabel}
                          routeRunId={prepare.data.routeRunId}
                          blueprintId={prepare.data.blueprint.id}
                          blueprintHash={prepare.data.blueprint.blueprintHash}
                          onSuccess={(response) => setSimulateResponse(response)}
                          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                      ),
                    }
              }
              result={simulateResponse ? toDeepVerificationResult(simulateResponse) : null}
            />
          );
        })()
      : null;
  return (
    <main className="flex-1 overflow-y-auto bg-bg px-4 pb-24 pt-6 sm:px-7 lg:px-10 lg:pb-10">
      <div className="mx-auto w-full max-w-[1180px]">
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-5 sm:p-7">
          <div className="absolute bottom-0 left-7 top-0 w-px bg-accent/35" aria-hidden="true" />
          <div className="relative pl-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-pop">Route intelligence · Base</p>
              <Link
                href="/plan/history"
                className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-accent/45 hover:text-ink"
              >
                History
              </Link>
            </div>
            <h1 className="mt-3 max-w-3xl font-display text-3xl font-semibold tracking-[-0.03em] text-ink sm:text-4xl">What do you want to do on Base?</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">Describe one swap goal. Miorail will compare current Uniswap and KyberSwap routes, then show exactly what the evidence can—and cannot—support.</p>
          </div>
          <form onSubmit={submit} className="relative mt-6 pl-5">
            <label htmlFor="route-goal" className="sr-only">Swap goal</label>
            <div className="rounded-xl border border-line bg-bg/60 p-2 focus-within:border-accent/70">
              <textarea
                id="route-goal"
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  if (evaluation.data || evaluation.error) evaluation.reset();
                  if (prepare.data || prepare.error) prepare.reset();
                  setSelectedCandidateHash(null);
                }}
                rows={3}
                maxLength={4000}
                placeholder="Swap 100 USDC to ETH using the best net result."
                className="w-full resize-none bg-transparent px-3 py-2 text-base leading-relaxed text-ink outline-none placeholder:text-ink-3"
              />
              <div className="flex items-center justify-between gap-3 border-t border-line px-2 pt-2">
                <span className="font-mono text-[10px] text-ink-3">{message.length}/4000 · no transaction will be prepared</span>
                <button type="submit" disabled={!message.trim() || !address || evaluation.isPending} className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  {evaluation.isPending ? 'Comparing…' : 'Compare routes'}
                </button>
              </div>
            </div>
          </form>
          <div className="relative mt-4 flex flex-wrap gap-2 pl-5" aria-label="Example route goals">
            {EXAMPLES.map((example) => <button key={example} type="button" onClick={() => { setMessage(example); evaluation.reset(); }} className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-left text-[11px] text-ink-2 hover:border-accent/45 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{example}</button>)}
          </div>
        </section>

        <section className="mt-6" aria-live="polite">
          {surfaceState === 'loading' && <div className="rounded-2xl border border-line bg-panel p-6"><p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-2">Comparing providers</p><p className="mt-2 text-sm text-ink-2">Validating quotes, evidence freshness and provenance…</p></div>}
          {surfaceState === 'error' && <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6"><h2 className="font-display text-lg font-semibold text-ink">The comparison could not be completed</h2><p className="mt-2 text-sm text-ink-2">{evaluation.error?.message}</p><button type="button" onClick={() => submit()} className="mt-4 rounded-full border border-risk px-4 py-2 text-sm font-semibold text-risk">Retry comparison</button></div>}
          {surfaceState === 'clarification' && result?.outcome === 'needs_clarification' && <div className="rounded-2xl border border-warn/35 bg-warn-soft p-6"><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-warn">Clarification needed</p><h2 className="mt-2 font-display text-xl font-semibold text-ink">{result.clarification.message}</h2><p className="mt-2 text-sm text-ink-2">Update the goal above with: {result.clarification.missingFields.join(', ')}.</p></div>}
          {surfaceState === 'rejection' && result?.outcome === 'rejected' && <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6"><p className="font-mono text-[10px] uppercase tracking-[0.18em] text-risk">Request rejected</p><ul className="mt-3 space-y-2 text-sm text-ink-2">{result.issues.map((issue) => <li key={`${issue.code}:${issue.field}`}>{issue.message}</li>)}</ul></div>}
          {surfaceState === 'evaluated' && result?.outcome === 'evaluated' && (
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
              deepVerification={deepVerification}
            />
          )}
        </section>
      </div>
    </main>
  );
}
