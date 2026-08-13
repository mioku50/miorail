"use client";

import { useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { EarnRouteCardView, deriveEarnRouteCardViewV1, earnUnsupportedReasonLabelV1 } from "@mioagent/ui";
import { useEarnCompare } from "@mioagent/api-client-react";
import { EarnDepositFlow } from "@mioagent/wallet-actions";

// T61 §6 / T62.1 §2: the miniapp Earn Route Card surface, rendered ONLY behind
// the server flag and only inside the session-ready block of RoutePlanHome. The
// comparison is a plain authenticated request (NO wallet signature, NO x402);
// when the server returns a persisted routeRunId, the SHARED EarnDepositFlow
// (the same one the web /plan uses) drives select → prepare → review → Base
// Account submit → Route Proof. The panel chrome stays miniapp-local, the
// execution flow is shared.

const EARN_EXAMPLES = [
  "Deposit 500 USDC for yield.",
  "Размести 500 USDC под доходность.",
];

export function EarnComparePanel() {
  const { address } = useAccount();
  const [message, setMessage] = useState("");
  const earn = useEarnCompare();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!address || !message.trim() || earn.isPending) return;
    earn.mutate({ message, walletAddress: address.toLowerCase() as `0x${string}` });
  };

  const result = earn.data;

  return (
    <section aria-label="Earn Route Card">
      <div className="rounded-2xl border border-line bg-panel p-5">
        <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-pop">Earn · Base · USDC</p>
        <h2 className="mt-2 font-display text-xl font-semibold">Put USDC to work</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Compare pinned Moonwell, Morpho, and YO USDC routes. YO APY stays Not scored until a canonical source exists.
          Read-only — no transaction is prepared here.
        </p>
        <form onSubmit={submit} className="mt-4">
          <label htmlFor="mini-earn-goal" className="sr-only">Earn goal</label>
          <textarea
            id="mini-earn-goal"
            rows={3}
            maxLength={4000}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              if (earn.data || earn.error) earn.reset();
            }}
            placeholder="Deposit 500 USDC for yield."
            className="w-full resize-none rounded-xl border border-line bg-bg/60 px-3 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="font-mono text-[9px] text-ink-3">Read-only · {message.length}/4000</span>
            <button
              type="submit"
              disabled={!message.trim() || !address || earn.isPending}
              className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {earn.isPending ? "Comparing…" : "Compare earn routes"}
            </button>
          </div>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {EARN_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => { setMessage(example); earn.reset(); }}
              className="rounded-full border border-line bg-panel-2 px-3 py-1.5 text-left text-[10px] text-ink-2"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4" aria-live="polite">
        {earn.isError && (
          <div className="rounded-2xl border border-risk/35 bg-risk-soft p-5">
            <h3 className="font-display text-lg font-semibold">The comparison could not be completed</h3>
            <p className="mt-2 text-sm text-ink-2">{earn.error?.message}</p>
          </div>
        )}
        {result?.outcome === "needs_clarification" && (
          <div className="rounded-2xl border border-warn/35 bg-warn-soft p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-warn">Clarification needed</p>
            <p className="mt-2 text-sm text-ink-2">Update the goal — {result.issues.join(", ")}.</p>
          </div>
        )}
        {result?.outcome === "unsupported" && (
          <div className="rounded-2xl border border-risk/35 bg-risk-soft p-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-risk">Not supported</p>
            <p className="mt-2 text-sm text-ink-2">{earnUnsupportedReasonLabelV1(result.reason)}</p>
          </div>
        )}
        {result?.outcome === "compared" && (
          result.routeRunId ? (
            <EarnDepositFlow routeRunId={result.routeRunId} routeCard={result.routeCard} onRefresh={() => submit()} />
          ) : (
            <EarnRouteCardView view={deriveEarnRouteCardViewV1(result.routeCard)} onRefresh={() => submit()} />
          )
        )}
      </div>
    </section>
  );
}
