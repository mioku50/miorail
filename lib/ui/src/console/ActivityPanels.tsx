import React from 'react';

// Referenced so the classic JSX transform the test runner uses finds it. Vite
// and Next compile this file with the automatic runtime and need no import, so
// without this line the component builds and renders in the app while being
// unrenderable by the only suite that proves it renders at all.
void React;

// ---------------------------------------------------------------------------
// Activity — what has actually happened, including the parts that did not.
//
// This surface was called Proofs and showed a list of route runs. In
// production every one of those runs sits at `ready`: prepared, compared,
// never signed. Zero rows in route_proofs, nft_proofs, commerce_proofs,
// ai_inference_proofs. The tab was named after its rarest row and, on the one
// deployment that exists, its non-existent one.
//
// Three things follow from that, and they are the whole design:
//
//   * A run says WHERE IT STOPPED, in words. "ready" is a database value, not
//     an explanation; "prepared, never signed, so there is no proof" is the
//     fact the reader came for. A list of statuses looks like a list of
//     things that happened.
//
//   * Paid intelligence is shown, because it is the one thing this product
//     has provably done: settled USDC on Base, with a transaction hash anyone
//     can check. It was invisible while a page called Proofs showed twenty-five
//     runs that produced none.
//
//   * Development smoke payments are separated from real spend. They are
//     settled transactions and they belong in the ledger, but counting them as
//     product usage would be dressing up a number.
//
// Nothing here reconciles, retries or re-runs. It reads.
// ---------------------------------------------------------------------------

export interface ActivityRunRowV1 {
  routeRunId: string;
  createdAt: string;
  runStatus: string;
  intentSummary: string;
  provider: string | null;
  proofId: string | null;
  proofFinalStatus: string | null;
}

/** Where a run got to, in one sentence, keyed by the stored status. */
const RUN_STAGE_COPY_V1: Readonly<Record<string, string>> = {
  draft: 'Started and left as a draft. Nothing was compared.',
  needs_clarification: 'Stopped for a question the goal did not answer.',
  collecting_candidates: 'Stopped while gathering routes.',
  collecting_evidence: 'Stopped while gathering evidence for the comparison.',
  scoring: 'Stopped while scoring the candidates.',
  ready: 'Prepared and compared. Never signed, so there is no proof.',
  card_ready: 'A Route Card was produced. Never signed, so there is no proof.',
  blueprint_ready: 'An Execution Blueprint was built. Never signed, so there is no proof.',
  awaiting_approval: 'Waiting on approval in Base Account. Nothing was submitted.',
  executing: 'Submitted. Receipts have not been reconciled yet.',
  reconciling: 'Submitted. Expected and actual are being compared.',
  completed: 'Executed and reconciled.',
  partial_failure: 'Executed, and part of it did not do what was expected.',
  failed: 'Failed. Nothing was left half-applied that this run knows about.',
  cancelled: 'Cancelled before signing.',
  rejected: 'Refused. The route did not pass its own checks.',
};

export function activityRunStageCopyV1(runStatus: string): string {
  return RUN_STAGE_COPY_V1[runStatus] ?? 'This run is in a state this build does not have words for.';
}

/** True while a run has not reached a wallet. Most of them, today. */
export function activityRunUnsignedV1(runStatus: string): boolean {
  return [
    'draft',
    'needs_clarification',
    'collecting_candidates',
    'collecting_evidence',
    'scoring',
    'ready',
    'card_ready',
    'blueprint_ready',
    'awaiting_approval',
    'cancelled',
    'rejected',
  ].includes(runStatus);
}

/** console.css gives `.pill` four tones — br, g, a, n. Anything else is
 * unstyled text, which makes a failure look like a success. */
export function activityRunToneV1(runStatus: string): string {
  if (runStatus === 'completed') return 'g';
  if (runStatus === 'executing' || runStatus === 'reconciling' || runStatus === 'partial_failure') return 'a';
  return 'n';
}

/**
 * The line above the list.
 *
 * Says how many runs never reached a signature, because a reader scanning
 * twenty rows of `ready` should not have to work that out themselves — and
 * because it is the honest headline for this surface today.
 */
export function activityRunsSummaryV1(runs: readonly ActivityRunRowV1[]): string {
  if (runs.length === 0) return 'No route runs yet.';
  const unsigned = runs.filter((run) => activityRunUnsignedV1(run.runStatus)).length;
  const withProof = runs.filter((run) => run.proofId).length;
  if (withProof === 0) {
    return `${runs.length} run${runs.length === 1 ? '' : 's'}, ${unsigned} of them never signed. No proofs yet — a proof exists only after a route is signed and reconciled.`;
  }
  return `${runs.length} run${runs.length === 1 ? '' : 's'}, ${withProof} with an execution proof.`;
}

export interface ActivityRunsModelV1 {
  loading: boolean;
  runs: readonly ActivityRunRowV1[];
  selectedRunId: string | null;
  onSelect: (run: ActivityRunRowV1) => void;
  onLoadMore?: () => void;
  hasMore: boolean;
  /** Rendered INSTEAD of the list. */
  unavailableReason: string | null;
}

export function ActivityRunsCard(model: ActivityRunsModelV1) {
  return (
    <div className="rp">
      <div className="rph">
        <b>Route runs</b>
        <span className="rt mono">{model.runs.length || '—'}</span>
      </div>
      <div className="rpb">
        {model.loading && model.runs.length === 0 ? (
          <p className="empty">Reading route history…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : model.runs.length === 0 ? (
          <p className="empty">
            No route runs yet. One appears here as soon as you compare routes for a goal.
          </p>
        ) : (
          <>
            <p className="lnote">{activityRunsSummaryV1(model.runs)}</p>
            {model.runs.map((run) => (
              <div key={run.routeRunId}>
                <div className="qrow">
                  <button
                    type="button"
                    className="btn sec"
                    onClick={() => model.onSelect(run)}
                    disabled={model.selectedRunId === run.routeRunId}
                  >
                    {run.intentSummary || run.routeRunId}
                  </button>
                  <span className={`pill ${activityRunToneV1(run.runStatus)}`}>
                    {run.proofFinalStatus ?? run.runStatus}
                  </span>
                </div>
                <p className="lnote">{activityRunStageCopyV1(run.runStatus)}</p>
                <p className="lnote">
                  {new Date(run.createdAt).toLocaleString()}
                  {run.provider ? ` · ${run.provider}` : ''}
                </p>
              </div>
            ))}
            {model.hasMore && model.onLoadMore && (
              <div className="ctarow">
                <button type="button" className="btn sec" onClick={model.onLoadMore} disabled={model.loading}>
                  {model.loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- paid intelligence ------------------------------------------------------

export interface ActivitySpendEntryV1 {
  id: string;
  actionType: string;
  category?: string;
  direction?: string;
  cost: string | null;
  txHash: string | null;
  status?: string;
  createdAt: string;
}

export interface ActivitySpendSummaryV1 {
  totalSpentUsdc: string;
  devSmokeSpentUsdc?: string;
  devSmokeCallsCount?: number;
  failedBuyerAttemptsCount?: number;
  pendingBuyerAttemptsCount?: number;
  summaryScope?: 'latest_100_tenant_receipts';
  recordsConsidered?: number;
  truncated?: boolean;
}

/** `$0.0002`, keeping the small denominations this product actually charges.
 * `toFixed(2)` would round every B20 exit proof to zero. */
export function activitySpendLabelV1(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '$0';
  // Ordinary amounts keep the cents they are read with — `$1.50`, not `$1.5`.
  // Only the sub-cent range trims, so `0.000200` becomes `0.0002` instead of
  // rounding to `$0.00` and claiming the user was not charged.
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/**
 * What the total actually covers.
 *
 * The one thing this must not do is present development smoke payments as
 * product revenue or product usage. They are real settled transactions and
 * they belong in the ledger — they are just not somebody buying something.
 */
export function activitySpendSummaryCopyV1(summary: ActivitySpendSummaryV1 | null): string {
  if (!summary) return 'No paid intelligence has been recorded on this account.';
  const smokeCount = summary.devSmokeCallsCount ?? 0;
  const parts: string[] = [`${activitySpendLabelV1(summary.totalSpentUsdc)} settled in USDC on Base.`];
  if (summary.summaryScope === 'latest_100_tenant_receipts') {
    parts.push(
      summary.truncated
        ? 'This total covers only the latest 100 payment receipts, not lifetime spend.'
        : `This total covers the ${summary.recordsConsidered ?? 0} payment receipt(s) currently in this ledger window.`,
    );
  }
  if (smokeCount > 0) {
    parts.push(
      `${activitySpendLabelV1(summary.devSmokeSpentUsdc)} of that is ${smokeCount} development smoke payment${
        smokeCount === 1 ? '' : 's'
      } — real transactions, but not a purchase anybody made.`,
    );
  }
  if ((summary.failedBuyerAttemptsCount ?? 0) > 0) {
    parts.push(`${summary.failedBuyerAttemptsCount} attempt(s) failed and are not counted in the total.`);
  }
  if ((summary.pendingBuyerAttemptsCount ?? 0) > 0) {
    parts.push(`${summary.pendingBuyerAttemptsCount} still pending, so not counted either.`);
  }
  return parts.join(' ');
}

/** `0x1234abcd…9f0e`, short enough for a row and long enough to recognise. */
export function activityShortHashV1(hash: string | null): string {
  if (!hash) return '—';
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

export function activityBaseScanTxUrlV1(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

export interface ActivitySpendModelV1 {
  loading: boolean;
  entries: readonly ActivitySpendEntryV1[];
  summary: ActivitySpendSummaryV1 | null;
  unavailableReason: string | null;
}

/**
 * One receipt, drawn the same way wherever it appears.
 *
 * Extracted because the dev-smoke group renders the identical row and a second
 * copy is how two lists of the same thing start disagreeing about what a
 * missing hash means.
 */
/**
 * How many receipts a group holds, and how many of them actually settled.
 *
 * A count of receipts and a count of payments are different numbers whenever
 * anything failed, and this card carries both: the summary sentence totals what
 * settled, the group lists everything. Naming the group after "payments" made
 * "6 development smoke payments" sit under "1 development smoke payment".
 */
export function spendGroupSummaryV1(
  noun: string,
  entries: readonly ActivitySpendEntryV1[],
): string {
  const settled = entries.filter((entry) => entry.status === 'settled').length;
  const head = `${entries.length} ${noun}${entries.length === 1 ? '' : 's'}`;
  return settled === entries.length ? head : `${head} · ${settled} settled`;
}

function SpendReceiptRow({ entry }: { entry: ActivitySpendEntryV1 }) {
  return (
    <div>
      <div className="qrow">
        <span className="mono">{entry.category ?? entry.actionType}</span>
        <span className="v mono">{activitySpendLabelV1(entry.cost)}</span>
      </div>
      <p className="lnote">
        {entry.status ?? 'unknown'} · {new Date(entry.createdAt).toLocaleString()}
      </p>
      {entry.txHash ? (
        <p className="lnote">
          <a
            className="mono"
            href={activityBaseScanTxUrlV1(entry.txHash)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {activityShortHashV1(entry.txHash)}
          </a>
        </p>
      ) : (
        // A charge with no hash is not a charge anybody can check.
        <p className="lnote">No transaction hash, so this one cannot be verified onchain.</p>
      )}
    </div>
  );
}

/**
 * Paid intelligence, below the wallet's own actions and grouped.
 *
 * On production this card opened the page with six `dev_smoke` receipts of
 * $0.001, five of them failed — so the first thing a reader met was a list of
 * our own test transactions, above the result of a real one. Development smoke
 * is real settled USDC and belongs in the ledger; it is not what somebody came
 * to Activity to read.
 *
 * The two groups fold. The NUMBERS do not: the header total and the summary
 * sentence — which already names the dev-smoke share, the failed attempts and
 * the pending ones — sit outside both, so nothing measured needs a press to be
 * seen. What folds is six near-identical rows.
 */
export function ActivitySpendCard(model: ActivitySpendModelV1) {
  // Seller-side diagnostics are not money this account spent, and mixing them
  // into a spend list is how a ledger stops meaning anything.
  const outgoing = model.entries.filter((entry) => entry.direction !== 'incoming_seller_smoke');
  // The same marker the server totals on, so the card and the summary sentence
  // can never disagree about which receipts are ours.
  const smoke = outgoing.filter((entry) => entry.category === 'dev_smoke');
  const purchases = outgoing.filter((entry) => entry.category !== 'dev_smoke');

  return (
    <div className="rp">
      <div className="rph">
        <b>Paid intelligence</b>
        <span className="rt mono">{activitySpendLabelV1(model.summary?.totalSpentUsdc)}</span>
      </div>
      <div className="rpb">
        {model.loading && outgoing.length === 0 ? (
          <p className="empty">Reading the payment ledger…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : (
          <>
            {/* Every number the page has, unexpanded. */}
            <p className="lnote">{activitySpendSummaryCopyV1(model.summary)}</p>
            {outgoing.length === 0 ? (
              <p className="empty">Nothing has been paid for from this account.</p>
            ) : (
              <>
                {purchases.length > 0 && (
                  <details className="card-evidence">
                    <summary>{spendGroupSummaryV1('purchase', purchases)}</summary>
                    <div className="card-evidence-body">
                      {purchases.map((entry) => (
                        <SpendReceiptRow key={entry.id} entry={entry} />
                      ))}
                    </div>
                  </details>
                )}
                {smoke.length > 0 && (
                  <details className="card-evidence">
                    {/* Counts RECEIPTS and says how many settled, because the
                        sentence above counts only what is in the total. Shipped
                        for four minutes saying "6 development smoke payments"
                        under a sentence saying "1 development smoke payment" —
                        both true, one word, two numbers. */}
                    <summary>
                      {spendGroupSummaryV1('development smoke receipt', smoke)} ·{' '}
                      {activitySpendLabelV1(model.summary?.devSmokeSpentUsdc)}
                    </summary>
                    <div className="card-evidence-body">
                      <p className="lnote">
                        Real settled transactions from our own tests. Not a purchase anybody made.
                      </p>
                      {smoke.map((entry) => (
                        <SpendReceiptRow key={entry.id} entry={entry} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- the proof, when there is one -------------------------------------------

export interface ActivityProofModelV1 {
  /** The run the reader picked, so an absent proof can say which run. */
  runLabel: string;
  loading: boolean;
  /** Null when the run never produced one. */
  proof: {
    finalStatus: string;
    reconciliationState: string;
    provider: string | null;
    expectedOutput: { amountAtomic: string; asset: { symbol: string; decimals: number } };
    actualOutput: string | null;
    outputDeviationBps: number | null;
    minimumSatisfied: boolean | null;
    transactionHashes: readonly string[];
    blueprintHash: string;
    approvedCallsHash: string;
  } | null;
  lifecycle: string | null;
  unavailableReason: string | null;
}

/** `+0.12%` / `-0.40%`, or nothing when the deviation was never computed. */
export function activityDeviationLabelV1(bps: number | null): string | null {
  if (bps === null) return null;
  const percent = (bps / 100).toFixed(2);
  return bps > 0 ? `+${percent}%` : `${percent}%`;
}

const PROOF_TONE_V1: Readonly<Record<string, string>> = {
  completed: 'g',
  partial_failure: 'a',
  reconciliation_required: 'a',
  pending: 'n',
  failed: 'n',
  cancelled: 'n',
};

function atomicLabelV1(amountAtomic: string, decimals: number, symbol: string): string {
  const negative = amountAtomic.startsWith('-');
  const digits = (negative ? amountAtomic.slice(1) : amountAtomic).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

export function ActivityProofCard(model: ActivityProofModelV1) {
  const proof = model.proof;
  const deviation = proof ? activityDeviationLabelV1(proof.outputDeviationBps) : null;

  return (
    <div className="rp">
      <div className="rph">
        <b>Execution proof</b>
        <span className="rt mono">{model.runLabel}</span>
      </div>
      <div className="rpb">
        {model.loading ? (
          <p className="empty">Reading the execution proof…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : !proof ? (
          <p className="empty">
            This run has no execution proof. It never reached an approved submission, so there is
            nothing to reconcile — that is a fact about the run, not a missing file.
          </p>
        ) : (
          <>
            <div className="qrow">
              <span className={`pill ${PROOF_TONE_V1[proof.finalStatus] ?? 'n'}`}>{proof.finalStatus}</span>
              <span className="v mono">{proof.reconciliationState}</span>
            </div>
            {proof.finalStatus === 'pending' && (
              <p className="lnote">
                Receipts have not been verified onchain yet. Nothing is assumed successful until they
                are.
              </p>
            )}
            <div className="qrow">
              <span>Expected out</span>
              <span className="v mono">
                {atomicLabelV1(
                  proof.expectedOutput.amountAtomic,
                  proof.expectedOutput.asset.decimals,
                  proof.expectedOutput.asset.symbol,
                )}
              </span>
            </div>
            <div className="qrow">
              <span>Actual out</span>
              <span className="v mono">
                {proof.actualOutput === null
                  ? 'not verified'
                  : atomicLabelV1(
                      proof.actualOutput,
                      proof.expectedOutput.asset.decimals,
                      proof.expectedOutput.asset.symbol,
                    )}
              </span>
            </div>
            {deviation !== null && (
              <div className="qrow">
                <span>Deviation</span>
                <span className={`v mono${proof.minimumSatisfied === false ? ' warn' : ''}`}>
                  {deviation}
                  {proof.minimumSatisfied === false ? ' · below minimum' : ''}
                </span>
              </div>
            )}
            {proof.provider && (
              <div className="qrow">
                <span>Provider</span>
                <span className="v mono">{proof.provider}</span>
              </div>
            )}
            {proof.transactionHashes.map((hash) => (
              <div className="qrow" key={hash}>
                <span>Receipt</span>
                <span className="v mono">
                  <a href={activityBaseScanTxUrlV1(hash)} target="_blank" rel="noopener noreferrer">
                    {activityShortHashV1(hash)}
                  </a>
                </span>
              </div>
            ))}
            <p className="lnote">
              blueprint {activityShortHashV1(proof.blueprintHash)} · calls{' '}
              {activityShortHashV1(proof.approvedCallsHash)}
              {model.lifecycle ? ` · lifecycle ${model.lifecycle}` : ''}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
