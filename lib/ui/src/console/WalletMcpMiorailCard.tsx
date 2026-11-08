'use client';

import React, { useState } from 'react';

void React;

// ---------------------------------------------------------------------------
// Miorail in your AI assistant, through Coinbase Wallet MCP.
//
// Wallet MCP lets a protocol describe itself in one markdown plugin, which the
// person's assistant reads by URL. Miorail publishes one: its MCP reads and
// prepares, Wallet MCP's send_calls carries the calls, and the person approves
// in their own wallet after confirming the terms on Miorail's review page.
//
// These are constants rather than configuration because the plugin file says
// the same addresses, and a page that drifted from it would send people to a
// server the plugin does not describe.
// ---------------------------------------------------------------------------

export const WALLET_MCP_URL_V1 = 'https://wallet-mcp.coinbase.com';
export const MIORAIL_CONNECTED_MCP_URL_V1 = 'https://miorail.xyz/mcp/private';
export const MIORAIL_PUBLIC_MCP_URL_V1 = 'https://miorail.xyz/mcp';
export const MIORAIL_WALLET_MCP_PLUGIN_PATH_V1 = '/wallet-mcp/miorail.md';
export const MIORAIL_WALLET_MCP_PROMPT_V1 = `Use the Miorail plugin for Wallet MCP: https://miorail.xyz${MIORAIL_WALLET_MCP_PLUGIN_PATH_V1}`;

/** Claude's own "add custom connector" form with the name and address filled in.
 * Claude says the link came from outside and asks the person to confirm it. */
export function addToClaudeUrlV1(name: string, url: string): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(url)}`;
}

/** Where a custom MCP server is added in ChatGPT and in Grok. Neither fills one in from a link
 * (2026-11-08: ChatGPT documents none, and grok.com's own router reads only connectorId and
 * teamId on /connectors), so the address is copied on the press that opens the page. */
export const CHATGPT_ADD_MCP_PAGE_V1 = 'https://chatgpt.com/plugins';
export const GROK_ADD_CONNECTOR_PAGE_V1 = 'https://grok.com/connectors';

/** A new chat with the question already typed, in Claude, ChatGPT or Grok (grok.com reads `q`
 * on its chat page and starts the chat with it). */
export const askClaudeUrlV1 = (question: string): string => `https://claude.ai/new?q=${encodeURIComponent(question)}`;
export const askChatGptUrlV1 = (question: string): string => `https://chatgpt.com/?q=${encodeURIComponent(question)}`;
export const askGrokUrlV1 = (question: string): string => `https://grok.com/?q=${encodeURIComponent(question)}`;

/** Copies text on this press, before a link opens another tab: the Clipboard API is
 * asynchronous, and Chrome refuses it once the page has lost focus to the tab it opened.
 * A page that cannot copy this way gets false and says so. */
export function copyOnThisPressV1(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = text;
  // Off screen, at a size that does not make a phone zoom in, and selectable (iOS selects no read-only field).
  Object.assign(area.style, { position: 'fixed', top: '0', left: '-9999px', fontSize: '16px', opacity: '0' });
  const before = typeof HTMLElement !== 'undefined' && doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  doc.body.appendChild(area);
  let copied: boolean;
  try {
    area.focus(); area.select(); area.setSelectionRange(0, text.length);
    copied = doc.execCommand('copy');
  } catch { copied = false; }
  area.remove();
  before?.focus();
  return copied;
}

/** One value to copy. A webview without clipboard access says so instead of
 * pretending it copied. */
function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <span className="mcp-copy">
      <span className="mono">{value}</span>
      <button
        type="button"
        className="btn sec"
        aria-label={`Copy ${label}`}
        onClick={() => {
          const write = globalThis.navigator?.clipboard?.writeText(value);
          if (!write) {
            setCopied('failed');
            return;
          }
          void write.then(
            () => setCopied('done'),
            () => setCopied('failed'),
          );
        }}
      >
        {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Select and copy' : 'Copy'}
      </button>
    </span>
  );
}

export function WalletMcpMiorailCard() {
  return (
    <div className="rp mcp-miorail">
      <div className="rph">
        <b>Miorail in your AI assistant</b>
        <span className="rt">Wallet MCP plugin</span>
      </div>
      <div className="rpb">
        <p className="lnote">
          Ask Claude, ChatGPT or Cursor about tokenized stocks on Base, then buy or sell after you
          confirm the live terms on Miorail&apos;s review page. Your wallet approves every
          transaction; Miorail never signs.
        </p>
        <ol className="mcp-steps">
          <li>
            <b>Add Coinbase Wallet MCP</b> to your assistant as a remote MCP server.
            <CopyLine label="the Wallet MCP address" value={WALLET_MCP_URL_V1} />
          </li>
          <li>
            <b>Add Miorail</b> the same way, and sign in with the same wallet.
            <CopyLine label="the Miorail MCP address" value={MIORAIL_CONNECTED_MCP_URL_V1} />
            <a className="btn" href={addToClaudeUrlV1('Miorail', MIORAIL_CONNECTED_MCP_URL_V1)} target="_blank" rel="noreferrer">Add to Claude</a>
          </li>
          <li>
            <b>Tell your assistant</b> to use the plugin.
            <CopyLine label="the prompt" value={MIORAIL_WALLET_MCP_PROMPT_V1} />
          </li>
        </ol>
        <p className="lnote">
          <a href={MIORAIL_WALLET_MCP_PLUGIN_PATH_V1} target="_blank" rel="noreferrer">
            Read the plugin
          </a>
          . To read without signing in, use <span className="mono">{MIORAIL_PUBLIC_MCP_URL_V1}</span>.
          Connected assistants are listed, and revoked, in Settings.
        </p>
      </div>
    </div>
  );
}
