import React, { type ReactNode } from 'react';

void React;

// ---------------------------------------------------------------------------
// T70 §2/§3 — everything that used to sit in the way.
//
// Budget & payments was the first card on Routes and the largest block in the
// mobile drawer. Route adapters were a scrolling list of provider names beneath
// it. Both are things a user reads once, when something is wrong, and never
// again — and both were occupying the first screen of a product whose first
// screen should be an opportunity or an action.
//
// Nothing is deleted. It is one page down, in the place people already look for
// things they configure.
//
// 2026-09-04 — and then one fold further. Moving the spend-permission panel to
// Settings put it at the TOP of Settings, which is the place a person looks
// for the plan they are on: the page opened on a monthly limit, a spent
// figure, allowed categories, a permission recipient and three buttons, for a
// feature almost nobody has enabled. It is an agent's spending budget, so it
// now sits under Advanced and says so.
//
// The order of this page is the order of the questions people arrive with:
// who else can act as me, is the server working, what do I quote in a bug
// report — and then everything else.
// ---------------------------------------------------------------------------

export interface SettingsAdapterRowV1 {
  name: string;
  label: string;
  live: boolean;
  usable?: boolean;
}

export interface SettingsProviderRowV1 {
  name: string;
  label: string;
  tone?: 'ok' | 'off';
}

export interface SettingsScreenModelV1 {
  /**
   * Agent spending budget — the Base Spend Permission panel.
   *
   * It was the FIRST and largest block on this page: a monthly limit, a spent
   * figure, a reserved figure, allowed categories, a permission recipient, two
   * amount fields and three buttons — occupying the place where a person looks
   * for the plan they are on. Almost nobody has a spend permission, and the
   * ones who do set it once.
   *
   * So it is one fold down, under Advanced, and its state travels with the
   * summary so a collapsed fold can never hide a charge that needs attention.
   * Nothing is removed.
   */
  budget: ReactNode;
  /**
   * The one line the Advanced fold shows while it is closed.
   *
   * A fold that says only "Advanced" over a permission in `Paid, not
   * delivered` hides the one state on this page where the user has lost money.
   * The label comes from the same view the panel inside renders, so the two
   * cannot disagree.
   */
  budgetStatus?: { label: string; needsAttention: boolean } | null;
  /**
   * Connect Miorail to your AI — the grants a wallet handed to an assistant.
   *
   * First, above adapters and providers: those describe how the server works,
   * and this is the only card on the page that answers "who else can act as
   * me". A person looking for it is looking for it urgently.
   */
  connectedApps?: ReactNode;
  adapters: { rows: readonly SettingsAdapterRowV1[]; summary: string };
  adaptersUnavailableReason: string | null;
  providers: readonly SettingsProviderRowV1[];
  providersUnavailableReason: string | null;
  network: readonly { label: string; value: string; tone?: 'ok' | 'off' }[];
  /** Build, chain env, server flags — the things a bug report needs. */
  technical: readonly { label: string; value: string }[];
}

export function SettingsScreen(model: SettingsScreenModelV1) {
  return (
    <>
      {model.connectedApps}

      <div className="panel">
        <div className="ph">
          <h3>Route adapters</h3>
          <span className="rt">
            <span className="sub mono">{model.adapters.summary}</span>
          </span>
        </div>
        <div className="pb">
          {model.adapters.rows.length === 0 ? (
            <p className="empty">
              {model.adaptersUnavailableReason ??
                'No adapters reported. Route comparison cannot run until at least one answers.'}
            </p>
          ) : (
            model.adapters.rows.map((row) => (
              <div className="qrow" key={row.name}>
                <span>{row.name}</span>
                {/* A configured adapter that has not answered yet is not dimmed
                    like a switched-off one — only one of those is a problem. */}
                <span className={`v${row.live ? ' ok' : (row.usable ?? row.live) ? '' : ' off'}`}>{row.label}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Providers</h3>
        </div>
        <div className="pb">
          {model.providers.length === 0 ? (
            <p className="empty">
              {model.providersUnavailableReason ?? 'No external providers are configured on this server.'}
            </p>
          ) : (
            model.providers.map((row) => (
              <div className="qrow" key={row.name}>
                <span>{row.name}</span>
                <span className={`v${row.tone === 'ok' ? ' ok' : row.tone === 'off' ? ' off' : ''}`}>{row.label}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Network status</h3>
        </div>
        <div className="pb">
          {model.network.map((row) => (
            <div className="qrow" key={row.label}>
              <span>{row.label}</span>
              <span className={`v mono${row.tone === 'ok' ? ' ok' : row.tone === 'off' ? ' off' : ''}`}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Technical details</h3>
          <span className="rt">
            <span className="sub">for bug reports</span>
          </span>
        </div>
        <div className="pb">
          {model.technical.map((row) => (
            <div className="kv" key={row.label}>
              <span className="k">{row.label}</span>
              <span className="v mono">{row.value}</span>
            </div>
          ))}
          {/* Never an endpoint URL and never a key: both have leaked from a
              "technical details" block before, in every product that has one. */}
          <p className="lnote">Endpoints and credentials are deliberately not listed here.</p>
        </div>
      </div>

      {/* Advanced. One fold, at the end, holding the things this page used to
          open with. The summary names what is inside and carries its state:
          folded is not hidden, and a permission that needs attention says so
          from the closed row. */}
      <details className="settings-advanced" aria-label="Advanced settings">
        <summary>
          <span className="settings-advanced-k">Advanced</span>
          <span className="settings-advanced-v">Agent spending budget</span>
          {model.budgetStatus ? (
            <span
              className="pill cr-status"
              data-tone={model.budgetStatus.needsAttention ? 'warn' : 'neutral'}
            >
              {model.budgetStatus.label}
            </span>
          ) : null}
        </summary>
        {model.budget}
      </details>
    </>
  );
}
