import React, { useState, type ReactNode } from 'react';

import { MIORAIL_SOURCE_URL_V1 } from '../console/ConsoleShell';
import { MIORAIL_CONNECTED_MCP_URL_V1, addToClaudeUrlV1, askChatGptUrlV1, askClaudeUrlV1 } from '../console/WalletMcpMiorailCard';
import { STILL_PUBLIC_HOST_V1, STILL_PUBLIC_ORIGIN_V1 } from '../stillOrigin';
import type { AssetsViewV1 } from './assetsView';
import type { SkyStateV1 } from './skyState';
import { STILL_ASSISTANTS_V1, StillHeader, StillLink } from './StillFrame';
import { StillIconV1, type StillIconNameV1 } from './icons';

void React;

// ---------------------------------------------------------------------------
// Assets, More, and Still for assistants.
// ---------------------------------------------------------------------------

const CHEVRON_V1 = <svg className="still-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

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
    <div className="still-assets">
      <StillHeader title="Assets" sky={model.sky} />
      {!model.signedIn ? (
        <div className="still-section">
          <p className="still-sub">Sign in with your wallet to see what it holds and what hangs on it.</p>
          <a className="still-btn" href={model.signInHref}>Sign in</a>
        </div>
      ) : view ? (
        <>
          <div className="still-section still-balance">
            <div className="still-balance-label">Reviewed holdings</div>
            {view.total ? (
              <div className="still-big"><span className="d">{view.total.split('.')[0]}</span><span className="c">.{view.total.split('.')[1]}</span></div>
            ) : (
              <div className="still-sub">Total not read this time.</div>
            )}
            <div className="still-balance-note">{view.count} reviewed {view.count === 1 ? 'holding' : 'holdings'} · prices are each venue’s own</div>
            <div className="still-balance-actions">
              <StillLink href="/borrow" className="still-btn">Get money</StillLink>
              <StillLink href="/repay" className="still-btn sec">Repay</StillLink>
            </div>
            <p className="still-balance-note">Reviewed stocks through Aave V4; cbBTC and WETH through Morpho.</p>
          </div>
          <div className="still-tabs" role="tablist" aria-label="Assets">
            <button type="button" role="tab" aria-selected={tab === 'holdings'} onClick={() => setTab('holdings')}>Holdings</button>
            <button type="button" role="tab" aria-selected={tab === 'loans'} onClick={() => setTab('loans')}>Loans · {view.loansReadComplete ? view.loans.length : view.loans.length > 0 ? `${view.loans.length}+` : 'Not read'}</button>
          </div>
          {tab === 'holdings' ? (
            <div className="still-assets-layout">
              <div className="still-assets-primary">
                {view.count === 0 ? <p className="still-section still-note">No holdings were established in Still’s reviewed set: Coinbase stocks, cbBTC or ETH.</p> : null}
                <ul className="still-rows" role="tabpanel" aria-label="Holdings">
                  {view.rows.map((row) => (
                    <li key={row.id} className="still-row">
                      <span className={`still-dot ${row.kind}`} aria-hidden="true">{row.kind === 'cash' ? '$' : row.name[0]}</span>
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
                {view.others.length > 0 ? (
                  <p className="still-section still-note still-assets-others">
                    Also in the wallet:{' '}
                    {view.others.map((other, i) => (
                      <React.Fragment key={other.href}>
                        {i > 0 ? ' · ' : null}
                        <StillLink href={other.href}>{other.symbol} {other.amount}</StillLink>
                      </React.Fragment>
                    ))}
                    . Each is priced on its stock’s page.
                  </p>
                ) : null}
                <p className="still-section still-note still-assets-foot">Read from Base at block {view.block}. ETH includes WETH. Prices are the venues’ own oracles at that block; USDC counts at $1.</p>
              </div>
              <aside className="still-assets-aside still-section">
                <StillLink href="/stocks/dividends" className="still-card still-feature-link">
                  <span>
                    <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Your dividends{view.receivedDividends ? ` · ${view.receivedDividends} reinvested` : ''}</span>
                    <span className="still-note">Calendar and every conversion, in Stocks</span>
                  </span>
                  {CHEVRON_V1}
                </StillLink>
              </aside>
            </div>
          ) : (
            <ul className="still-rows" role="tabpanel" aria-label="Loans">
              {!view.loansReadComplete ? <li className="still-note" style={{ paddingTop: 12 }}>Some venue debts could not be read. This does not establish that no loan exists.</li>
                : view.loans.length === 0 ? <li className="still-note" style={{ paddingTop: 12 }}>No debt was recorded in the reviewed venues at this block.</li> : null}
              {view.loans.map((loan) => (
                <li key={loan.id} className="still-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{loan.label}</div>
                    {loan.rate ? <div className="mono amt">{loan.rate}</div> : null}
                    {loan.safety ? <div className={loan.state === 'act' || loan.state === 'liquidation' ? 'line still-warn' : 'line'}>{loan.safety}</div> : null}
                    {loan.liquidation.map((text) => <div key={text} className="line">{text}</div>)}
                    {loan.more ? <div className="line still-note">{loan.more}</div> : null}
                  </div>
                  <div className="val"><div className="mono">{loan.owed}</div>{loan.repayHref ? <StillLink href={loan.repayHref} className="still-btn sec" style={{ marginTop: 10 }}>Repay</StillLink> : null}</div>
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
    </div>
  );
}

export interface StillMoreModelV1 {
  sky: SkyStateV1;
  /** The Basename, or the short address. Null when signed out. */
  account: string | null;
  signInHref: string;
}

const MORE_GROUPS_V1: ReadonlyArray<{ label: string; rows: ReadonlyArray<{ title: string; blurb: string; href: string; icon: StillIconNameV1; badge?: string }> }> = [
  { label: 'Spend', rows: [{ title: 'Spend', blurb: 'Mobile data, top-ups and gift cards a loan could pay for, in USDC', href: '/spend', icon: 'spend', badge: 'New' }] },
  { label: 'Trade', rows: [{ title: 'Swap AI', blurb: 'Any token on Base, by a checked route', href: '/routes', icon: 'swap' }] },
  {
    label: 'Research',
    rows: [
      { title: 'Discover', blurb: 'Officially issued assets, and what getting back out costs', href: '/opportunities', icon: 'discover' },
      { title: 'Watch', blurb: 'Any address read in full, what issuers can do to your tokens, the markets you watch', href: '/watch', icon: 'watch' },
      { title: 'Today', blurb: 'The classic first screen: balances, cash-out and your Aave card', href: '/today', icon: 'today' },
    ],
  },
  // Wallet MCP is Coinbase's wallet, not a place of Still's, and people took it
  // for one (operator, 2026-11-03). Its page stays at /extensions for the links
  // that lead into it; More no longer offers it.
  {
    label: 'Assistants',
    rows: [{ title: 'Still for assistants', blurb: 'Connect Claude, ChatGPT, Cursor or Codex', href: STILL_ASSISTANTS_V1.path, icon: 'assistant' }],
  },
];

export function StillMore({ model }: { model: StillMoreModelV1 }) {
  return (
    <div className="still-more-page">
      <StillHeader title="More" sky={model.sky} />
      <div className="still-section still-account">
        <span className="still-account-mark" aria-hidden="true">{(model.account ?? '?')[0]?.toUpperCase()}</span>
        <span className="still-account-body">
          <span className="still-account-name">{model.account ?? 'Not signed in'}</span>
          <span className="still-account-note">{model.account ? 'Signed in with your wallet' : 'Sign in to read your own wallet'}</span>
        </span>
        {model.account ? null : <a className="still-account-signin" href={model.signInHref}>Sign in</a>}
        <span className="still-account-links">
          <StillLink href="/plan/history" className="still-account-link"><StillIconV1 name="activity" />Activity</StillLink>
          <StillLink href="/settings" className="still-account-link"><StillIconV1 name="settings" />Settings</StillLink>
        </span>
      </div>
      <div className="still-more-groups">
        {MORE_GROUPS_V1.map((group) => (
          <section key={group.label} className="still-more-group" aria-label={group.label}>
            <h2 className="still-more-group-head">{group.label}</h2>
            <ul className="still-links">
              {group.rows.map((row) => (
                <li key={row.href}>
                  <StillLink href={row.href}>
                    <span className="still-link-icon"><StillIconV1 name={row.icon} /></span>
                    <span className="still-link-text">
                      <span className="t">{row.title}{row.badge ? <span className="still-badge">{row.badge}</span> : null}</span>
                      <span className="b">{row.blurb}</span>
                    </span>
                    {CHEVRON_V1}
                  </StillLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="still-section still-note">
        <a href="/metrics">Public metrics</a> · <a href={MIORAIL_SOURCE_URL_V1} target="_blank" rel="noopener noreferrer">Source (AGPL-3.0)</a>
      </p>
    </div>
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

/** Still's own MCP server: five read-only tools, asserted by the deploy. */
export const STILL_MCP_URL_V1 = `${STILL_PUBLIC_ORIGIN_V1}/mcp/still`;

// The addresses are the servers' own. The signed-in one is the Wallet MCP
// card's, and the plugin file names it too: a page that drifted from it would
// send people to a server the plugin does not describe.
export function StillAssistants({ model }: { model: StillAssistantsModelV1 }) {
  const commands: Array<[string, ReactNode]> = [
    ['Claude Code', <CopyRow key="claude" label="the Claude Code command" value={`claude mcp add --transport http still ${STILL_MCP_URL_V1}`} />],
    ['Codex CLI', <CopyRow key="codex" label="the Codex command" value={`codex mcp add still --url ${STILL_MCP_URL_V1}`} />],
    ['Cursor and other JSON clients', <pre key="json" className="still-pre">{`{\n  "mcpServers": {\n    "still": { "url": "${STILL_MCP_URL_V1}" }\n  }\n}`}</pre>],
    ['Grok', <p key="grok" className="still-note">On grok.com/connectors: New Connector, Custom, then paste the address above.</p>],
  ];
  // Each one is answered by a tool on that server, as written.
  const asks = [
    'How much could 0x… borrow through Still without selling?',
    'What happens to that wallet’s Still loan if NVIDIA falls 30%?',
    'What are Still’s terms this weekend?',
    'What eSIM data plans for Japan could a Still loan pay for?',
  ];
  return (
    <>
      <StillHeader title={STILL_ASSISTANTS_V1.label} sky={model.sky} />
      <div className="still-section">
        <div className="still-word">Still in your assistant.</div>
        <div className="still-sub">
          Ask Claude, ChatGPT, Grok, Cursor or Codex what Still answers here: how much a wallet could borrow against its stocks and crypto
          without selling, how safe a loan is, what a fall in price would do to it, and what a loan could pay for at Bitrefill. The
          figures are Still’s own, read from Base at one block. No API key, and nothing is signed there: you approve every loan in your
          own wallet.
        </div>
      </div>
      <div className="still-section still-feature">
        <div className="still-eyebrow">Still’s MCP server · read only, no sign-in</div>
        <CopyRow label="the Still MCP address" value={STILL_MCP_URL_V1} />
        <a className="still-btn" href={addToClaudeUrlV1('Still', STILL_MCP_URL_V1)} target="_blank" rel="noreferrer" style={{ marginTop: 10 }}>Add to Claude</a>
        <p className="still-note" style={{ marginTop: 6 }}>
          Five tools: <span className="mono">get_still_terms</span>, <span className="mono">still_check_wallet</span>, <span className="mono">still_what_if</span>,{' '}
          <span className="mono">still_find_spend</span> and <span className="mono">still_spend_product</span>.
        </p>
      </div>
      {commands.map(([title, body]) => (
        <div key={title} className="still-section">
          <div className="still-eyebrow">{title}</div>
          {body}
        </div>
      ))}
      <div className="still-section">
        <div className="still-eyebrow">Ask it</div>
        {asks.map((ask) => (
          <p key={ask} className="still-note">
            “{ask}” <a href={askClaudeUrlV1(ask)} target="_blank" rel="noreferrer">Ask Claude</a> · <a href={askChatGptUrlV1(ask)} target="_blank" rel="noreferrer">ChatGPT</a>
          </p>
        ))}
      </div>
      <div className="still-section">
        <div className="still-eyebrow">To prepare a loan, a purchase or a repayment from your assistant</div>
        <p className="still-note">
          Connect Miorail’s signed-in server instead. It opens your wallet’s sign-in on first use; then <span className="mono">miorail_prepare_still_loan</span>,{' '}
          <span className="mono">miorail_prepare_still_purchase</span> and <span className="mono">miorail_prepare_still_repay</span> turn what you name into a
          review link, and your own wallet signs on {STILL_PUBLIC_HOST_V1}. <span className="mono">miorail_get_still_review_status</span> then tells your assistant
          what happened. In a chat that draws MCP Apps, as Claude does, the review comes as a card that opens it and follows it to Base.
        </p>
        <a className="still-btn sec" href={addToClaudeUrlV1('Miorail', MIORAIL_CONNECTED_MCP_URL_V1)} target="_blank" rel="noreferrer" style={{ margin: '10px 0' }}>Add Miorail to Claude</a>
        <CopyRow label="the signed-in Claude Code command" value={`claude mcp add --transport http miorail ${MIORAIL_CONNECTED_MCP_URL_V1}`} />
      </div>
      <p className="still-section still-note">
        Still measures; it gives no advice and never signs. Borrowing creates debt, and collateral can be liquidated. Tokenized stocks are
        issued under their issuers’ terms and are not offered to US persons.
      </p>
    </>
  );
}
