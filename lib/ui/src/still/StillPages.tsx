import React, { useState, type ReactNode } from 'react';

import { MIORAIL_SOURCE_URL_V1 } from '../console/ConsoleShell';
import { MIORAIL_CONNECTED_MCP_URL_V1, MIORAIL_PUBLIC_MCP_URL_V1, MIORAIL_WALLET_MCP_PROMPT_V1 } from '../console/WalletMcpMiorailCard';
import type { AssetsViewV1 } from './assetsView';
import type { SkyStateV1 } from './skyState';
import { StillHeader, StillLink } from './StillFrame';

void React;

// ---------------------------------------------------------------------------
// Assets, More, and Still for assistants.
// ---------------------------------------------------------------------------

const CHEVRON_V1 = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export interface StillAssetsModelV1 {
  sky: SkyStateV1;
  view: AssetsViewV1 | null;
  loading: boolean;
  failed: string | null;
  onRetry: () => void;
  signedIn: boolean;
  signInHref: string;
}

export function StillAssets({ model }: { model: StillAssetsModelV1 }) {
  const [tab, setTab] = useState<'holdings' | 'loans'>('holdings');
  const view = model.view;
  return (
    <>
      <StillHeader title="Assets" sky={model.sky} />
      {!model.signedIn ? (
        <div className="still-section">
          <p className="still-sub">Sign in with your wallet to see what it holds and what hangs on it.</p>
          <a className="still-btn" href={model.signInHref}>Sign in</a>
        </div>
      ) : view ? (
        <>
          <div className="still-section">
            {view.total ? (
              <div className="still-big"><span className="d" style={{ fontSize: 48 }}>{view.total.split('.')[0]}</span><span className="c" style={{ fontSize: 24 }}>.{view.total.split('.')[1]}</span></div>
            ) : (
              <div className="still-sub">Total not read this time.</div>
            )}
            <div className="still-note" style={{ marginTop: 6 }}>{view.count} {view.count === 1 ? 'holding' : 'holdings'} Still can lend against · prices are each venue’s own</div>
          </div>
          <div className="still-tabs" role="tablist" aria-label="Assets">
            <button type="button" role="tab" aria-selected={tab === 'holdings'} onClick={() => setTab('holdings')}>Holdings</button>
            <button type="button" role="tab" aria-selected={tab === 'loans'} onClick={() => setTab('loans')}>Loans · {view.loans.length}</button>
          </div>
          {tab === 'holdings' ? (
            <>
              {view.rows.length === 0 ? <p className="still-section still-note">Nothing here Still can lend against: no Coinbase stocks on Aave V4, no cbBTC and no ETH.</p> : null}
              <ul className="still-rows" role="tabpanel" aria-label="Holdings">
                {view.rows.map((row) => (
                  <li key={row.id} className="still-row">
                    <span className={`still-dot ${row.kind}`} aria-hidden="true">{row.name[0]}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{row.name}</div>
                      <div className="mono amt">{row.amount}</div>
                      {row.lines.map((line, index) => (
                        <div key={index} className="line">{line.strong ? <strong>{line.strong}</strong> : null}{line.text}</div>
                      ))}
                    </div>
                    <div className="mono val">{row.value ?? 'Not read'}</div>
                  </li>
                ))}
              </ul>
              <div className="still-section">
                <StillLink href="/stocks/dividends" className="still-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                  <span>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Your dividends{view.receivedDividends ? ` · ${view.receivedDividends} reinvested` : ''}</span>
                    <span className="still-note">Calendar and every conversion, in Stocks</span>
                  </span>
                  {CHEVRON_V1}
                </StillLink>
              </div>
            </>
          ) : (
            <ul className="still-rows" role="tabpanel" aria-label="Loans">
              {view.loans.length === 0 ? <li className="still-note" style={{ paddingTop: 12 }}>No loans. Nothing hangs on the right.</li> : null}
              {view.loans.map((loan) => (
                <li key={loan.id} className="still-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{loan.label}</div>
                    {loan.rate ? <div className="mono amt">{loan.rate}</div> : null}
                    {loan.safety ? <div className={loan.state === 'act' || loan.state === 'liquidation' ? 'line still-warn' : 'line'}>{loan.safety}</div> : null}
                    {loan.liquidation.map((text) => <div key={text} className="line">{text}</div>)}
                    {loan.more ? <div className="line still-note">{loan.more}</div> : null}
                  </div>
                  <div className="mono val">{loan.owed}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : model.loading ? (
        <p className="still-section still-note" role="status">Reading your wallet on Base…</p>
      ) : model.failed ? (
        <div className="still-section">
          <p className="still-warn" role="status">Your wallet could not be read just now. This is our failure, not a fact about your wallet.</p>
          <button type="button" className="still-btn sec" onClick={model.onRetry}>Read again</button>
        </div>
      ) : null}
    </>
  );
}

export interface StillMoreModelV1 {
  sky: SkyStateV1;
  /** The Basename, or the short address. Null when signed out. */
  account: string | null;
  signInHref: string;
}

const MORE_GROUPS_V1: ReadonlyArray<{ label: string; rows: ReadonlyArray<{ title: string; blurb: string; href: string }> }> = [
  { label: 'Trade', rows: [{ title: 'Swap AI', blurb: 'Any token on Base, by a checked route', href: '/routes' }] },
  {
    label: 'Research',
    rows: [
      { title: 'Discover', blurb: 'Officially issued assets, and what getting back out costs', href: '/opportunities' },
      { title: 'Investigate', blurb: 'One address, read in full', href: '/investigate' },
      { title: 'Radar', blurb: 'Watches on exact markets, and what changed', href: '/radar' },
      { title: 'B20 controls', blurb: 'What an issuer can do to a token you hold', href: '/portfolio' },
      { title: 'Today', blurb: 'The classic first screen: balances, cash-out and your Aave card', href: '/today' },
    ],
  },
  {
    label: 'Assistants',
    rows: [
      { title: 'Still for assistants', blurb: 'Connect Claude, ChatGPT, Cursor or Codex', href: '/assistants' },
      { title: 'Wallet MCP', blurb: 'Coinbase’s wallet in your assistant, with Miorail inside', href: '/extensions' },
    ],
  },
];

export function StillMore({ model }: { model: StillMoreModelV1 }) {
  return (
    <>
      <StillHeader title="More" sky={model.sky} />
      <div className="still-section still-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="still-dot crypto" aria-hidden="true">{(model.account ?? '?')[0]?.toUpperCase()}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 600, overflowWrap: 'anywhere' }}>{model.account ?? 'Not signed in'}</span>
          <span className="still-note">{model.account ? 'Signed in with your wallet' : 'Sign in to read your own wallet'}</span>
        </span>
        {model.account ? null : <a className="still-btn" style={{ height: 40, fontSize: 15 }} href={model.signInHref}>Sign in</a>}
      </div>
      <div className="still-btns" style={{ marginTop: 10 }}>
        <StillLink href="/plan/history" className="still-btn sec" style={{ height: 44, fontSize: 15 }}>Activity</StillLink>
        <StillLink href="/settings" className="still-btn sec" style={{ height: 44, fontSize: 15 }}>Settings</StillLink>
      </div>
      {MORE_GROUPS_V1.map((group) => (
        <div key={group.label}>
          <div className="still-section still-eyebrow">{group.label}</div>
          <ul className="still-links">
            {group.rows.map((row) => (
              <li key={row.href}>
                <StillLink href={row.href}>
                  <span><span className="t">{row.title}</span><span className="b">{row.blurb}</span></span>
                  {CHEVRON_V1}
                </StillLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="still-section still-note">
        <a href="/metrics">Public metrics</a> · <a href={MIORAIL_SOURCE_URL_V1} target="_blank" rel="noopener noreferrer">Source (AGPL-3.0)</a>
      </p>
    </>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <div className="still-copy">
      <span className="mono v">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          const write = globalThis.navigator?.clipboard?.writeText(value);
          if (!write) {
            setState('failed');
            return;
          }
          void write.then(() => setState('done'), () => setState('failed'));
        }}
      >
        {state === 'done' ? 'Copied' : state === 'failed' ? 'Select and copy' : 'Copy'}
      </button>
    </div>
  );
}

export interface StillAssistantsModelV1 {
  sky: SkyStateV1;
}

// The addresses are the Wallet MCP card's own: the plugin file names the same
// ones, and a page that drifted from it would send people to a server the
// plugin does not describe.
export function StillAssistants({ model }: { model: StillAssistantsModelV1 }) {
  const commands: Array<[string, ReactNode]> = [
    ['Claude Code', <CopyRow key="claude" label="the Claude Code command" value={`claude mcp add --transport http miorail ${MIORAIL_CONNECTED_MCP_URL_V1}`} />],
    ['Codex CLI', <CopyRow key="codex" label="the Codex command" value={`codex mcp add miorail --url ${MIORAIL_CONNECTED_MCP_URL_V1}`} />],
    ['Cursor and other JSON clients', <pre key="json" className="still-pre">{`{\n  "mcpServers": {\n    "miorail": { "url": "${MIORAIL_CONNECTED_MCP_URL_V1}" }\n  }\n}`}</pre>],
  ];
  return (
    <>
      <StillHeader title="For assistants" sky={model.sky} />
      <div className="still-section">
        <div className="still-word">Still in your assistant.</div>
        <div className="still-sub">
          Your assistant reads the same numbers you see here, from Base: stock prices, what a buy or a sell would cost, your dividends.
          It prepares calls; you approve every one in your own wallet. No API key.
        </div>
      </div>
      <div className="still-section">
        <div className="still-eyebrow">One line, for an assistant with Wallet MCP</div>
        <CopyRow label="the plugin line" value={MIORAIL_WALLET_MCP_PROMPT_V1} />
      </div>
      <div className="still-section">
        <div className="still-eyebrow">The MCP server</div>
        <CopyRow label="the MCP address" value={MIORAIL_CONNECTED_MCP_URL_V1} />
        <p className="still-note" style={{ marginTop: 6 }}>
          It opens your wallet’s sign-in on first use. Reading without signing in: <span className="mono">{MIORAIL_PUBLIC_MCP_URL_V1}</span>
        </p>
      </div>
      {commands.map(([title, body]) => (
        <div key={title} className="still-section">
          <div className="still-eyebrow">{title}</div>
          {body}
        </div>
      ))}
      <p className="still-section still-note">
        Miorail measures; it gives no advice and never signs. Tokenized stocks are issued under their issuers’ terms and are not offered to US persons.
      </p>
    </>
  );
}
