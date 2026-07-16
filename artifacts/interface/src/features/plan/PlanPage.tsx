import { useState, type FormEvent } from 'react';
import { useAccount } from 'wagmi';
import { RoutePlanView, routePlanSurfaceState } from '@mioagent/ui';
import { useEvaluateSwapRoute, usePrepareSwapBlueprint } from '@mioagent/api-client-react';

const EXAMPLES = [
  'Swap 100 USDC to ETH using the best net result.',
  'Обменяй 100 USDC на ETH с минимальными комиссиями.',
  'Compare Uniswap and KyberSwap.',
  'Use only Uniswap and verify the quote.',
];

export function PlanPage() {
  const { address } = useAccount();
  const [message, setMessage] = useState('');
  const [selectedCandidateHash, setSelectedCandidateHash] = useState<string | null>(null);
  const evaluation = useEvaluateSwapRoute();
  const prepare = usePrepareSwapBlueprint();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !message.trim() || evaluation.isPending) return;
    prepare.reset();
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
    prepare.mutate({
      walletAddress: address.toLowerCase() as `0x${string}`,
      routeRunId: result.routeRunId,
      routeCardHash: result.routeCard.routeCardHash,
      selectedCandidateHash: candidateHash,
    });
  };
  return (
    <main className="flex-1 overflow-y-auto bg-bg px-4 pb-24 pt-6 sm:px-7 lg:px-10 lg:pb-10">
      <div className="mx-auto w-full max-w-[1180px]">
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-5 sm:p-7">
          <div className="absolute bottom-0 left-7 top-0 w-px bg-accent/35" aria-hidden="true" />
          <div className="relative pl-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-pop">Route intelligence · Base</p>
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
            />
          )}
        </section>
      </div>
    </main>
  );
}
