import React from 'react';

// ---------------------------------------------------------------------------
// T67C.2 — the public proof page.
//
// This is the one Miorail surface a stranger sees. Two rules shape it:
//
//   1. A green tick is not the vocabulary. `completed`, `partial_failure`,
//      `failed`, `cancelled` and `reconciliation_required` are five different
//      things and each gets its own sentence. A cancelled process record is
//      not evidence that anything executed, and the page says so in words
//      rather than leaving a reassuring checkmark to imply otherwise.
//
//   2. Recomputing a hash proves the bundle is internally consistent. It is
//      NOT a Miorail signature and NOT an onchain anchor, and the page states
//      that next to the result — because a visitor who misreads it would be
//      trusting something that was never claimed.
//
// Presentational only, and console classes only.
// ---------------------------------------------------------------------------

export interface PublicProofReceiptLikeV1 {
  transactionHash: string;
  status: string;
  blockNumber: string | null;
  gasUsed: string | null;
}

export interface PublicProofViewV1 {
  publicProofId: string;
  proofFamily: 'route' | 'nft';
  issuedAt: string;
  bundleHash: string;
  proofHash: string;
  approvedCallsHash: string;
  finalStatus: string;
  schemaVersion: string;
  provider: string | null;
  expectedOutput: string | null;
  actualOutput: string | null;
  minimumOutput: string | null;
  deviationBps: number | null;
  estimatedGas: string | null;
  actualGas: string | null;
  receipts: readonly PublicProofReceiptLikeV1[];
  eventCount: number;
}

/** One sentence per terminal status. None of them is a tick.
 *
 * Keyed by FAMILY as well as status: both families use the word `failed` and
 * mean different things by it. For a route it is a failed execution; for an NFT
 * it means the transaction landed without producing ownership, which is a
 * separate state from the transaction reverting. */
export const PUBLIC_PROOF_HEADLINE_COPY_V1: Record<'route' | 'nft', Record<string, string>> = {
  route: {
    completed: 'Verified execution proof',
    partial_failure: 'Partial failure — part of this batch did not succeed',
    failed: 'Failed execution',
    cancelled: 'Cancelled — this record describes a route that was never executed',
    reconciliation_required: 'Manual reconciliation — the outcome has not been established',
  },
  nft: {
    completed: 'Verified purchase proof',
    transaction_failed: 'The transaction reverted — nothing was purchased',
    failed: 'Failed — the transaction landed but ownership was not established',
    reconciliation_required: 'Manual reconciliation — the outcome has not been established',
  },
};

export function publicProofHeadlineCopyV1(proofFamily: 'route' | 'nft', finalStatus: string): string {
  return PUBLIC_PROOF_HEADLINE_COPY_V1[proofFamily][finalStatus] ?? `Recorded outcome: ${finalStatus}`;
}

/** What the local check does and does not establish. Shown verbatim, always —
 * not only when verification passes. */
export const PUBLIC_PROOF_SCOPE_COPY_V1 = [
  'This verifies canonical bundle integrity.',
  'It is not a Miorail server signature and is not an onchain anchor.',
] as const;

export const PUBLIC_PROOF_VERIFIED_COPY_V1 = 'Canonical hash integrity verified locally in this browser.';
export const PUBLIC_PROOF_INVALID_COPY_V1 = 'This proof bundle is invalid or has been modified.';

export function baseScanTxUrlV1(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

export function shortPublicHashV1(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—';
}

export function PublicProofHeaderPanel({ view }: { view: PublicProofViewV1 }): React.ReactElement {
  return (
    <section className="panel">
      <h3>{publicProofHeadlineCopyV1(view.proofFamily, view.finalStatus)}</h3>
      <div className="kv">
        <span className="k">Proof family</span>
        <span className="v">{view.proofFamily}</span>
      </div>
      <div className="kv">
        <span className="k">Final status</span>
        <span className="v">{view.finalStatus}</span>
      </div>
      {view.provider && (
        <div className="kv">
          <span className="k">Provider</span>
          <span className="v">{view.provider}</span>
        </div>
      )}
      <div className="kv">
        <span className="k">Issued</span>
        <span className="v mono">{view.issuedAt}</span>
      </div>
      <div className="kv">
        <span className="k">Schema</span>
        <span className="v mono">{view.schemaVersion}</span>
      </div>
    </section>
  );
}

export function PublicProofResultPanel({ view }: { view: PublicProofViewV1 }): React.ReactElement {
  const row = (label: string, value: string | null) => (
    <div className="kv" key={label}>
      <span className="k">{label}</span>
      {/* A missing number shows why it is missing rather than an empty cell
          that could be read as zero. */}
      <span className={value ? 'v mono' : 'v'}>{value ?? 'not recorded'}</span>
    </div>
  );
  return (
    <section className="panel">
      <h3>Result</h3>
      {row('Expected output', view.expectedOutput)}
      {row('Minimum accepted', view.minimumOutput)}
      {row('Actual output', view.actualOutput)}
      {row('Deviation (bps)', view.deviationBps === null ? null : String(view.deviationBps))}
      {row('Estimated gas', view.estimatedGas)}
      {row('Actual gas', view.actualGas)}
    </section>
  );
}

export function PublicProofReceiptsPanel({ view }: { view: PublicProofViewV1 }): React.ReactElement | null {
  if (view.receipts.length === 0) {
    return (
      <section className="panel">
        <h3>Transactions</h3>
        <p className="note">No transaction was recorded for this proof.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h3>Transactions</h3>
      {view.receipts.map((receipt) => (
        <div className="kv" key={receipt.transactionHash}>
          <span className="k">
            <a className="mono" href={baseScanTxUrlV1(receipt.transactionHash)} target="_blank" rel="noreferrer">
              {shortPublicHashV1(receipt.transactionHash)}
            </a>
          </span>
          {/* The REAL receipt status, including reverted. */}
          <span className="v">{receipt.status}</span>
        </div>
      ))}
      <p className="note">
        These hashes can be checked on a block explorer independently of Miorail. That is a stronger
        check than anything on this page.
      </p>
    </section>
  );
}

export interface PublicProofCheckLikeV1 {
  key: string;
  label: string;
  outcome: 'passed' | 'failed' | 'skipped';
  detail: string | null;
}

export function PublicProofVerificationPanel({
  view,
  checks,
  valid,
}: {
  view: PublicProofViewV1;
  checks: readonly PublicProofCheckLikeV1[];
  /** Null while verification has not run — never rendered as a pass. */
  valid: boolean | null;
}): React.ReactElement {
  return (
    <section className="panel">
      <h3>Integrity</h3>
      <div className="kv">
        <span className="k">Bundle hash</span>
        <span className="v mono">{shortPublicHashV1(view.bundleHash)}</span>
      </div>
      <div className="kv">
        <span className="k">Proof hash</span>
        <span className="v mono">{shortPublicHashV1(view.proofHash)}</span>
      </div>
      <div className="kv">
        <span className="k">Approved calls hash</span>
        <span className="v mono">{shortPublicHashV1(view.approvedCallsHash)}</span>
      </div>
      <div className="kv">
        <span className="k">Recorded events</span>
        <span className="v mono">{String(view.eventCount)}</span>
      </div>

      {checks.map((check) => (
        <div className="kv" key={check.key}>
          <span className="k">{check.label}</span>
          <span className="v">{check.outcome === 'skipped' ? (check.detail ?? 'not applicable') : check.outcome}</span>
        </div>
      ))}

      {valid === null ? (
        <p className="note">Checking…</p>
      ) : (
        <p className="note">{valid ? PUBLIC_PROOF_VERIFIED_COPY_V1 : PUBLIC_PROOF_INVALID_COPY_V1}</p>
      )}
      {PUBLIC_PROOF_SCOPE_COPY_V1.map((line) => (
        <p className="note" key={line}>
          {line}
        </p>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The owner's side
// ---------------------------------------------------------------------------

/** Shown before anything is published. It names the three things that become
 * public, because "share proof" on its own does not tell a user what they are
 * about to reveal. */
export const PUBLIC_PROOF_SHARE_WARNING_V1 =
  'Publishing this proof makes its wallet address, transaction hashes and approved transaction data accessible to anyone with the link.';

export function ShareProofPanel({
  publicUrl,
  onShare,
  onRevoke,
  onCopy,
  onDownload,
  pending,
}: {
  publicUrl: string | null;
  onShare: () => void;
  onRevoke: () => void;
  onCopy?: () => void;
  onDownload?: () => void;
  pending?: boolean;
}): React.ReactElement {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <section className="panel">
      <h3>Share proof</h3>
      {publicUrl ? (
        <>
          <div className="kv">
            <span className="k">Public link</span>
            <span className="v mono">{publicUrl}</span>
          </div>
          <button type="button" onClick={onCopy}>
            Copy link
          </button>
          <a className="mono" href={publicUrl} target="_blank" rel="noreferrer">
            Open public proof
          </a>
          <button type="button" onClick={onDownload}>
            Download JSON
          </button>
          <button type="button" onClick={onRevoke} disabled={pending}>
            Revoke link
          </button>
          <p className="note">Revoking takes effect immediately. A revoked link is never reissued.</p>
        </>
      ) : confirming ? (
        <>
          <p className="note">{PUBLIC_PROOF_SHARE_WARNING_V1}</p>
          <button type="button" onClick={onShare} disabled={pending}>
            Publish proof
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="note">This proof is private. Nothing is published until you choose to publish it.</p>
          <button type="button" onClick={() => setConfirming(true)}>
            Share proof
          </button>
        </>
      )}
    </section>
  );
}
