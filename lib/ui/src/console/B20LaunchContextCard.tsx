import React from 'react';

// ---------------------------------------------------------------------------
// Launch Context — who sent the transaction, and what that does not establish.
//
// Rendered on request, inside a card, never as a tab. A tab has to be filled,
// and the honest content for almost every launch on this chain is "an address
// sent a transaction and Miorail knows nothing else about it". That is a fine
// answer to a question somebody asked and a terrible thing to put a permanent
// heading over.
//
// The layout puts the REFUSAL where the eye lands. For a relayed launch the
// most important line is not the sender address — it is that the address is a
// bundler and counting its launches together would group strangers.
// ---------------------------------------------------------------------------

void React;

export type B20SenderRelationViewV1 = 'direct' | 'bundler' | 'intermediary' | 'contract_creation';
export type B20ClaimLinkViewV1 = 'launch_sender' | 'domain_file' | 'project_publication';

export const B20_CLAIM_LINK_LABEL_V1: Readonly<Record<B20ClaimLinkViewV1, string>> = {
  launch_sender: 'Launch sender',
  domain_file: 'File on the project’s domain',
  project_publication: 'Published by the project',
};

export interface B20LaunchContextViewV1 {
  schemaVersion: 'b20-launch-context/v1';
  tokenAddress: string;
  headline: string;
  reading:
    | { status: 'not_read' }
    | { status: 'read'; deployerAddress: string; relation: B20SenderRelationViewV1; readAt: string }
    | { status: 'transaction_absent'; readAt: string };
  /** Null whenever the sender cannot carry a count. Most of the time. */
  corpus: {
    launchCount: number;
    standingCounts: readonly { kind: string; count: number }[];
    coverage: { launchesRead: number; launchesTotal: number };
  } | null;
  claim: {
    status: 'no_claim' | 'unverified' | 'verified' | 'refuted';
    headline: string;
    detail: string;
    verifiedLinks: readonly B20ClaimLinkViewV1[];
    refutedLinks: readonly B20ClaimLinkViewV1[];
    uncheckedLinks: readonly B20ClaimLinkViewV1[];
    verifiedLabel: string;
  };
  caveats: readonly string[];
  serverTime: string;
}

export interface B20LaunchContextModelV1 {
  /** The token whose context is loaded or loading. Null when none is open. */
  tokenAddress: string | null;
  loading: boolean;
  context: B20LaunchContextViewV1 | null;
  error: string | null;
  onOpen: (tokenAddress: string) => void;
}

const SHORT_V1 = (address: string) => `${address.slice(0, 10)}…${address.slice(-8)}`;

export function B20LaunchContextCard({
  tokenAddress,
  model,
}: {
  tokenAddress: string;
  model: B20LaunchContextModelV1;
}) {
  const owns = model.tokenAddress === tokenAddress;
  const context = owns ? model.context : null;

  return (
    <details
      className="card-evidence"
      onToggle={(event) => {
        // Fetched when opened, not when the feed renders. A page that loaded
        // this for every card would spend a query per launch to show a
        // sentence almost nobody opened.
        if ((event.currentTarget as HTMLDetailsElement).open && !owns) model.onOpen(tokenAddress);
      }}
    >
      <summary>Launch context</summary>
      <div className="card-evidence-body">
        {owns && model.loading && <p className="lnote">Reading the launch transaction…</p>}
        {owns && model.error && <p className="note warn">{model.error}</p>}
        {context && (
          <>
            <p className="cr-verdict">{context.headline}</p>

            {context.reading.status === 'read' && (
              <div className="kv">
                <span className="k">Sent by</span>
                <span className="v mono">{SHORT_V1(context.reading.deployerAddress)}</span>
              </div>
            )}

            {/* Present only when the sender can carry it. There is no branch
                here that renders a count for a relayed launch, because the
                server does not send one. */}
            {context.corpus && (
              <div className="kv">
                <span className="k">Launches from this address</span>
                <span className="v">
                  {context.corpus.launchCount} · of {context.corpus.coverage.launchesRead} read so far
                </span>
              </div>
            )}

            <div className="kv">
              <span className="k">Project identity</span>
              <span className="v">{context.claim.headline}</span>
            </div>
            <div className="kv">
              <span className="k">Links verified</span>
              <span className="v mono">{context.claim.verifiedLabel}</span>
            </div>
            {/* The checklist, not a score. Every link is listed with what
                happened to it, so "0 of 3" is readable rather than a grade. */}
            <ul className="claim-links">
              {(['launch_sender', 'domain_file', 'project_publication'] as const).map((link) => {
                const state = context.claim.verifiedLinks.includes(link)
                  ? 'verified'
                  : context.claim.refutedLinks.includes(link)
                    ? 'did not hold'
                    : 'not checked';
                return (
                  <li key={link} className={state === 'verified' ? 'ok' : state === 'did not hold' ? 'warn' : ''}>
                    {B20_CLAIM_LINK_LABEL_V1[link]} — {state}
                  </li>
                );
              })}
            </ul>

            <ul className="claim-links">
              {context.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}
