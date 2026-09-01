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
//   1. "Active". New temporary credentials and OAuth grants have stored expiry,
//      but legacy issuance rows do not. The UI therefore says current, expired,
//      revoked or unknown only when the corresponding evidence exists.
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
  grantKind: 'oauth' | 'temporary_bearer';
  clientKind: string | null;
  clientName: string | null;
  scopes: readonly string[];
  walletAddress: string;
  issuedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
  expiresAt: string | null;
  status: 'current' | 'expired' | 'revoked' | 'unknown';
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
  oauth: {
    endpointUrl: string;
    accessTokenTtlMinutes: number;
    grantTtlDays: number;
    refreshTokenRotation: true;
  } | null;
  /** Shown exactly once, immediately after minting. */
  issued: { token: string; tokenId: string; expiresAt: string; notice: string } | null;
  issuing: boolean;
  revokingTokenId: string | null;
  onIssueTemporary: (clientKind: ConnectedAppClientKindV1) => void;
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

function expiryV1(iso: string | null, status: ConnectedAppGrantViewV1['status'], now: Date): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  if (status === 'expired') return `expired ${ageV1(iso, now)}`;
  const seconds = Math.max(0, Math.round((then - now.getTime()) / 1000));
  if (seconds < 60) return `expires in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires in ${Math.round(hours / 24)}d`;
}

function shortV1(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function ConnectedAppsCard(model: ConnectedAppsCardModelV1) {
  const [pressed, setPressed] = useState<ConnectedAppClientKindV1 | null>(null);
  const now = new Date();
  const usableNow = model.grants.filter((grant) => grant.status === 'current').length;
  const uncertain = model.grants.filter((grant) => grant.status === 'unknown').length;

  return (
    <div className="panel">
      <div className="ph">
        <h3>Connect Miorail to your AI</h3>
        <span className="rt">
          <span className="sub mono">
            {usableNow > 0
              ? `${usableNow} usable now`
              : uncertain > 0
                ? `${uncertain} expiry unknown`
                : 'no usable grants'}
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
              Authorize an assistant to read what you have already reviewed in Miorail. It can
              never sign or send a transaction — every transaction is still approved in your own
              Base Account.
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

            <p className="sub">Connect with OAuth</p>
            <div className="card-actions">
              {CONNECTED_APP_CHOICES_V1.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  className="btn sec"
                  onClick={() => {
                    setPressed(option.kind);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {pressed && model.oauth ? (
              <div className="card-evidence" data-testid="connected-app-oauth-guide">
                <div className="card-evidence-body">
                  <p className="cr-verdict">Connect from {connectedAppLabelV1(pressed)}</p>
                  <ol>
                    <li>Open that client&apos;s Connectors or MCP settings.</li>
                    <li>Add this remote MCP server:</li>
                  </ol>
                  <p className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {model.oauth.endpointUrl}
                  </p>
                  <p className="lnote">
                    The client creates the redirect and PKCE proof, then opens Miorail for your
                    approval. Access expires in {model.oauth.accessTokenTtlMinutes} minutes;
                    refresh tokens rotate and the grant expires in {model.oauth.grantTtlDays} days.
                  </p>
                </div>
              </div>
            ) : null}

            {/* The console's own disclosure vocabulary, not a bare browser
                triangle: `.mcp-tech` is what every other "quieter, foldable,
                technical" block on these screens uses. A `<details>` with no
                class rendered unstyled and wedged against the buttons above. */}
            <details className="mcp-tech">
              <summary>Advanced: temporary bearer key</summary>
              <p className="lnote">
                Use this only for a client that cannot perform MCP OAuth. It requires manual
                copy/paste and does not refresh.
              </p>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn sec"
                  disabled={model.issuing}
                  onClick={() => model.onIssueTemporary(pressed ?? 'other')}
                >
                  {model.issuing ? 'Issuing…' : 'Issue temporary key'}
                </button>
              </div>
              {model.issued ? (
                <div className="card-evidence" data-testid="connected-app-issued">
                  <div className="card-evidence-body">
                    <p className="cr-verdict">Temporary key — copy it now; it is shown once.</p>
                    <p className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {model.issued.token}
                    </p>
                    <p className="lnote">{model.issued.notice}</p>
                    <p className="lnote">
                      Expires <span className="mono">{model.issued.expiresAt}</span>
                    </p>
                    <button type="button" className="btn sec" onClick={model.onDismissIssued}>
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </details>

            {model.error ? (
              <p className="lnote warn">{model.error}</p>
            ) : model.loading ? (
              <p className="empty">Reading your connected apps…</p>
            ) : model.grants.length === 0 ? (
              <p className="empty">
                No grants have been issued for this wallet.
              </p>
            ) : (
              /* One card per grant, with its action as a SIBLING of the text.
                 The first version put Revoke inside the <dd> of a definition
                 list, so the button sat on top of "connected 18s ago". This is
                 the shape Radar already uses for a watch. */
              <div className="console-card-grid" aria-label="Connected apps">
                {model.grants.map((grant) => (
                  <article
                    className={grant.status === 'current' || grant.status === 'unknown' ? 'cardrow' : 'cardrow off'}
                    key={grant.tokenId}
                  >
                    <div className="cr-top">
                      <span className="cr-name">
                        {grant.clientName ?? connectedAppLabelV1(grant.clientKind)}
                      </span>
                      <span
                        className="pill cr-status"
                        data-tone={grant.status === 'current' ? 'measured' : grant.status === 'unknown' ? 'neutral' : 'off'}
                      >
                        {grant.status === 'revoked'
                          ? `Revoked ${ageV1(grant.revokedAt, now)}`
                          : grant.status === 'expired'
                            ? `Expired ${ageV1(grant.expiresAt, now)}`
                            : grant.status === 'unknown'
                              ? 'Expiry not recorded'
                              : grant.lastUsedAt
                            ? `Last used ${ageV1(grant.lastUsedAt, now)}`
                            : 'Never used'}
                      </span>
                    </div>
                    <p className="lnote">
                      {grant.grantKind === 'oauth' ? 'OAuth grant' : 'Temporary bearer key'}
                      {' · '}
                      {grant.walletAddress ? `${shortV1(grant.walletAddress)} · ` : ''}
                      {grant.issuedAt
                        ? `issued ${ageV1(grant.issuedAt, now)}`
                        : 'issued before this list began'}
                      {grant.expiresAt ? ` · ${expiryV1(grant.expiresAt, grant.status, now)}` : ''}
                      {grant.useCount > 0 ? ` · ${grant.useCount} calls` : ''}
                    </p>
                    {grant.status === 'revoked' || grant.status === 'expired' ? null : (
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
              Revoking takes effect immediately. Expired and revoked grants remain visible as
              history; older grants whose expiry was never recorded are labelled explicitly.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
