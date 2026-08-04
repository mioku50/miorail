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
  /** The full Budget & payments panel. §2: it opens from here and nowhere else. */
  budget: ReactNode;
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
      {model.budget}

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
    </>
  );
}
