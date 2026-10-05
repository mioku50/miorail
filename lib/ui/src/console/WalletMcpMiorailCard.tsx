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
