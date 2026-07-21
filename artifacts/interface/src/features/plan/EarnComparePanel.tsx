import { useState, type FormEvent } from 'react';
import { useAccount } from 'wagmi';
import { EarnRouteCardView, deriveEarnRouteCardViewV1 } from '@mioagent/ui';
import { useEarnCompare } from '@mioagent/api-client-react';

// T61 §6: the Earn Route Card surface for /plan, rendered ONLY behind the
// server flag (status.productMigration.earnRouteV1). It is a plain authenticated
// comparison — NO wallet signature, NO x402 — and maps the wire EarnRouteCardV1
// into lib/ui's surface-agnostic view model (lib/ui never imports api types).
// The deposit execution flow reuses the existing Blueprint approval + Route
// Proof surfaces and is wired separately.

const EARN_EXAMPLES = [
  'Deposit 500 USDC for yield.',
  'Размести 500 USDC под доходность.',
  'Find the best net yield, prefer easier withdrawals.',
  'Deposit 500 USDC for yield, use Moonwell only.',
];

export function EarnComparePanel() {
  const { address } = useAccount();
  const [message, setMessage] = useState('');
  const earn = useEarnCompare();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !message.trim() || earn.isPending) return;
    earn.mutate({ message, walletAddress: address.toLowerCase() as `0x${string}` });
  };

  const result = earn.data;

  return (
    <section className="mt-6" aria-label="Earn Route Card">
      <div className="rounded-2xl border border-line bg-panel p-5 sm:p-7">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-pop">Earn routes · Base · USDC</p>
        <h2 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">Put USDC to work</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-2">
          Describe a deposit goal. Miorail compares the pinned Moonwell and Morpho USDC routes and shows what the
          evidence can—and cannot—support. No transaction is prepared here.
        </p>
        <form onSubmit={submit} className="mt-5">
          <label htmlFor="earn-goal" className="sr-only">Earn goal</label>
          <div className="rounded-xl border border-line bg-bg/60 p-2 focus-within:border-accent/70">
            <textarea
              id="earn-goal"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                if (earn.data || earn.error) earn.reset();
              }}
              rows={2}
              maxLength={4000}
              placeholder="Deposit 500 USDC for yield."
              className="w-full resize-none bg-transparent px-3 py-2 text-base leading-relaxed text-ink outline-none placeholder:text-ink-3"
            />
            <div className="flex items-center justify-between gap-3 border-t border-line px-2 pt-2">
              <span className="font-mono text-[10px] text-ink-3">{message.length}/4000 · read-only comparison</span>
              <button
                type="submit"
                disabled={!message.trim() || !address || earn.isPending}
                className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {earn.isPending ? 'Comparing…' : 'Compare earn routes'}
              </button>
            </div>
          </div>
        </form>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Example earn goals">
          {EARN_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => { setMessage(example); earn.reset(); }}
              className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-left text-[11px] text-ink-2 hover:border-accent/45 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4" aria-live="polite">
        {earn.isError && (
          <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6">
            <h3 className="font-display text-lg font-semibold text-ink">The comparison could not be completed</h3>
            <p className="mt-2 text-sm text-ink-2">{earn.error?.message}</p>
          </div>
        )}
        {result?.outcome === 'needs_clarification' && (
          <div className="rounded-2xl border border-warn/35 bg-warn-soft p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-warn">Clarification needed</p>
            <p className="mt-2 text-sm text-ink-2">
              Update the goal above — {result.issues.join(', ')}.
            </p>
          </div>
        )}
        {result?.outcome === 'unsupported' && (
          <div className="rounded-2xl border border-risk/35 bg-risk-soft p-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-risk">Not supported</p>
            <p className="mt-2 text-sm text-ink-2">{result.reason}</p>
          </div>
        )}
        {result?.outcome === 'compared' && (
          <EarnRouteCardView view={deriveEarnRouteCardViewV1(result.routeCard)} onRefresh={() => submit()} />
        )}
      </div>
    </section>
  );
}
