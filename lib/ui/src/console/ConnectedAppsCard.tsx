import React, { useState } from 'react';

void React;

// ---------------------------------------------------------------------------
// Connect Miorail to your AI.
//
// A wallet can hand an assistant a credential for the private MCP surface. Until
// now there was no way to see that you had, which assistant holds it, what it
// has done, or how to take it back — the server minted grants, the private MCP
// told refused callers to "issue one from Settings", and Settings had no such
// control. This is that control.
//
// FOUR THINGS THIS CARD DOES NOT SAY
//
//   1. "Active". Nothing knows: a handoff token carries its own expiry, signed,
//      and the server stores neither the token nor the date. What is knowable
//      is whether it was REVOKED, so that is what is shown, and the card says
//      out loud that tokens also lapse on their own.
//
//   2. That issuing is using. A grant minted and never touched reads "never
//      used", because that is the one an owner most wants to find.
//
//   3. A per-grant permission. A handoff token carries no scopes. What it can
//      do is whatever this deployment allows while it is used, and the
//      executable half can be turned off under a token that already exists. So
//      permissions are stated ONCE, for the server, above the list.
//
//   4. The token, ever again. It is shown once, at the moment it is minted,
//      and never returned by any read. Revoking takes the grant's id, so an
//      owner who lost the token can still end it.
// ---------------------------------------------------------------------------

export type ConnectedAppClientKindV1 = 'claude' | 'chatgpt' | 'hermes' | 'other';

/** The three an owner picks from, in the order the product names them. `other`
 * exists so a client we do not list is still recorded as something the user
 * named, rather than as an absence. */
export const CONNECTED_APP_CHOICES_V1: readonly {
  kind: ConnectedAppClientKindV1;
  label: string;
}[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'chatgpt', label: 'ChatGPT' },
  { kind: 'hermes', label: 'Hermes' },
  { kind: 'other', label: 'Another client' },
];

const CLIENT_LABEL_V1: Readonly<Record<ConnectedAppClientKindV1, string>> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  hermes: 'Hermes',
  other: 'Another client',
};

/** Null is not a client called "unknown" — it is a grant nobody recorded one
 * for, which every grant issued before this card existed is. */
export function connectedAppLabelV1(kind: string | null): string {
  if (kind === null) return 'Not recorded';
  return CLIENT_LABEL_V1[kind as ConnectedAppClientKindV1] ?? 'Another client';
}

export interface ConnectedAppGrantViewV1 {
  tokenId: string;
  clientKind: string | null;
  walletAddress: string;
  issuedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
  historyComplete: boolean;
}

export interface ConnectedAppsCardModelV1 {
  /** False when the private MCP surface is off on this server. */
  available: boolean;
  unavailableReason: string | null;
  grants: readonly ConnectedAppGrantViewV1[];
  loading: boolean;
  /** Never rendered as an empty list: "we could not read this" and "you have
   * none" are the two states an owner must not confuse. */
  error: string | null;
  permissions: { read: boolean; executableHandoff: boolean } | null;
  /** Shown exactly once, immediately after minting. */
  issued: { token: string; tokenId: string; expiresAt: string; notice: string } | null;
  issuing: boolean;
  revokingTokenId: string | null;
  onConnect: (clientKind: ConnectedAppClientKindV1) => void;
  onRevoke: (tokenId: string) => void;
  onDismissIssued: () => void;
}

function ageV1(iso: string | null, now: Date): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortV1(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function ConnectedAppsCard(model: ConnectedAppsCardModelV1) {
  const [pressed, setPressed] = useState<ConnectedAppClientKindV1 | null>(null);
  const now = new Date();

  return (
    <div className="panel">
      <div className="ph">
        <h3>Connect Miorail to your AI</h3>
        <span className="rt">
          <span className="sub mono">
            {model.grants.length === 0 ? 'none connected' : `${model.grants.length} connected`}
          </span>
        </span>
      </div>
      <div className="pb">
        {!model.available ? (
          <p className="empty">
            {model.unavailableReason ??
              'This server does not offer the private MCP surface, so there is nothing to connect to.'}
          </p>
        ) : (
          <>
            <p className="lnote">
              Give an assistant a key to your Miorail account. It reads what you have already
              reviewed and can never sign or send a transaction — every transaction is still
              approved in your own Base Account.
            </p>

            {/* Stated once, for the server. A grant carries no scopes of its own. */}
            {model.permissions ? (
              <dl className="cr-facts" aria-label="What a connected app may do">
                <div>
                  <dt>Can read</dt>
                  <dd>
                    <strong className="cr-v">Your reviewed plans and measurements</strong>
                  </dd>
                </div>
                <div>
                  <dt>Can prepare</dt>
                  <dd>
                    <strong className={model.permissions.executableHandoff ? 'cr-v warn' : 'cr-v'}>
                      {model.permissions.executableHandoff
                        ? 'Unsigned transactions, for you to approve'
                        : 'Nothing — switched off on this server'}
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt>Can never</dt>
                  <dd>
                    <strong className="cr-v good">Sign or send anything</strong>
                  </dd>
                </div>
              </dl>
            ) : null}

            {model.issued ? (
              <div className="card-evidence" data-testid="connected-app-issued">
                <div className="card-evidence-body">
                  <p className="cr-verdict">Copy this key now — it is shown once.</p>
                  <p className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {model.issued.token}
                  </p>
                  <p className="lnote">{model.issued.notice}</p>
                  <button type="button" className="btn sec" onClick={model.onDismissIssued}>
                    Done
                  </button>
                </div>
              </div>
            ) : null}

            {/* One button per client, not a dropdown. This card carried the
                only <select> in the whole console, and the console has no
                vocabulary for one — it rendered as a raw browser control
                wedged into a row meant for buttons. Four buttons use the
                styling that already exists and save a click. */}
            <p className="sub">Connect an assistant</p>
            <div className="card-actions">
              {CONNECTED_APP_CHOICES_V1.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  className="btn sec"
                  disabled={model.issuing}
                  onClick={() => {
                    // Remembered only so THIS button reads "Connecting…" while
                    // the others stay legible. It selects nothing.
                    setPressed(option.kind);
                    model.onConnect(option.kind);
                  }}
                >
                  {model.issuing && pressed === option.kind ? 'Connecting…' : option.label}
                </button>
              ))}
            </div>

            {model.error ? (
              <p className="lnote warn">{model.error}</p>
            ) : model.loading ? (
              <p className="empty">Reading your connected apps…</p>
            ) : model.grants.length === 0 ? (
              <p className="empty">
                Nothing is connected to your wallet. Connect one above to use Miorail from an
                assistant.
              </p>
            ) : (
              /* One card per grant, with its action as a SIBLING of the text.
                 The first version put Revoke inside the <dd> of a definition
                 list, so the button sat on top of "connected 18s ago". This is
                 the shape Radar already uses for a watch. */
              <div className="console-card-grid" aria-label="Connected apps">
                {model.grants.map((grant) => (
                  <article
                    className={grant.revokedAt ? 'cardrow off' : 'cardrow'}
                    key={grant.tokenId}
                  >
                    <div className="cr-top">
                      <span className="cr-name">{connectedAppLabelV1(grant.clientKind)}</span>
                      <span
                        className="pill cr-status"
                        data-tone={grant.revokedAt ? 'off' : grant.lastUsedAt ? 'measured' : 'neutral'}
                      >
                        {grant.revokedAt
                          ? `Revoked ${ageV1(grant.revokedAt, now)}`
                          : grant.lastUsedAt
                            ? `Last used ${ageV1(grant.lastUsedAt, now)}`
                            : 'Never used'}
                      </span>
                    </div>
                    <p className="lnote">
                      {grant.walletAddress ? `${shortV1(grant.walletAddress)} · ` : ''}
                      {grant.issuedAt
                        ? `connected ${ageV1(grant.issuedAt, now)}`
                        : 'connected before this list began'}
                      {grant.useCount > 0 ? ` · ${grant.useCount} calls` : ''}
                    </p>
                    {grant.revokedAt ? null : (
                      <div className="card-actions">
                        <button
                          type="button"
                          className="btn sec"
                          disabled={model.revokingTokenId === grant.tokenId}
                          onClick={() => model.onRevoke(grant.tokenId)}
                        >
                          {model.revokingTokenId === grant.tokenId ? 'Revoking…' : 'Revoke'}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}

            <p className="lnote">
              Revoking takes effect immediately. A key also expires on its own, so a connection
              you no longer see used may already have lapsed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
