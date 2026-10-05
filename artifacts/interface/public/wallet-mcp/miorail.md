---
title: "Miorail Plugin"
description: "Tokenized stocks on Base through Miorail's MCP: measured prices and cash-out costs, then a reviewed buy or sell as unsigned calls → send_calls."
tags: [tokenized-stocks, trading, swap, discovery]
name: miorail
version: 0.1.0
integration: external-mcp
chains: [base]
requires:
  shell: none
  allowlist: []
  externalMcp:
    name: miorail
    transport: http
    url: https://miorail.xyz/mcp/private
  cliPackage: null
auth: oauth-on-install
risk: [slippage]
---

# Miorail Plugin

> [!IMPORTANT]
> Run Base MCP onboarding first (see `SKILL.md`). Base MCP is Coinbase's Wallet MCP at `https://wallet-mcp.coinbase.com`. The Miorail connector must also be installed and signed in once, **with the same wallet** Base MCP uses (see `## Installation` and `## Auth`).
>
> Miorail is a third-party service, not part of Base or Coinbase. Tokenized stocks are issued by their issuers under each issuer's own terms and are not offered to US persons. Miorail reports measurements, not advice: never suggest what to buy or sell.

## Overview

[Miorail](https://miorail.xyz) measures tokenized stocks on Base: every reviewed contract of a company (Coinbase's, Dinari's, Backed's), what it trades at on Base, what a given amount would cost to buy or return when sold, and what else the token can do (pools, lending). Its MCP server answers those questions and, for a buy or a sell, prepares the exact calls it simulated. The calls are **unsigned calldata**. Miorail never signs, never broadcasts and holds no key. The user approves every call in their own wallet through Base MCP `send_calls`, after confirming the live terms on Miorail's review page.

## Detection

- If tools named `list_reviewed_stocks`, `get_representations` and `miorail_prepare_stock_action` are exposed, the Miorail connector is installed and signed in.
- If the read tools are exposed but `miorail_prepare_stock_action` is not, the user installed the public endpoint `https://miorail.xyz/mcp`. Reads work, and a buy or sell needs the signed-in connector (see `## Installation`).
- If no Miorail tools are exposed, the connector is not installed. Go to `## Installation`. Do not call Miorail's website or API directly instead.

## Installation

Add Miorail as a remote MCP server. The client opens Miorail's sign-in on first use (see `## Auth`). The disclaimers in the callout above apply to everything this connector returns.

**Claude Code**

```sh
claude mcp add --transport http miorail https://miorail.xyz/mcp/private
```

**Codex CLI**

```sh
codex mcp add miorail --url https://miorail.xyz/mcp/private
```

**Cursor and other JSON-configured clients**

```json
{
  "mcpServers": {
    "miorail": { "url": "https://miorail.xyz/mcp/private" }
  }
}
```

**Claude.ai and ChatGPT:** open Settings → Connectors, add a custom connector, and paste `https://miorail.xyz/mcp/private`.

**Reads only, without signing in:** use `https://miorail.xyz/mcp` instead. It carries every read tool and no wallet-bound tool.

## Auth

`oauth-on-install`. The client registers itself, then opens `https://miorail.xyz` for the user. The user signs in with the wallet they will trade from and approves the connection. Scopes are `miorail:connected` and `offline_access`. Access tokens last 15 minutes, refresh tokens rotate, and the grant expires after 30 days. The user can revoke it at any time in Miorail's Settings.

The grant is bound to the ONE wallet that signed in. No argument can read, prepare or execute for another wallet. That wallet must be the one Base MCP signs with: calls Miorail prepares for one wallet are wrong for any other.

## Surface Routing

| Capability | Every surface (Claude Code, Codex, Cursor, Claude.ai, ChatGPT) |
|---|---|
| Find a company's tokenized stocks, prices on Base, cost to buy or sell, pools and lending | Miorail MCP read tools (external MCP). |
| A personal daily read, or what the user's whole position would fetch | Miorail MCP wallet-bound tools (signed-in connector). |
| Prepare a buy or sell | `miorail_prepare_stock_action` → a review link the user opens in a browser. |
| Execute after the user confirmed | `miorail_get_stock_base_mcp_action` → Base MCP `send_calls` → approval in the user's wallet. |

No surface needs a shell or the `web_request` allowlist: every Miorail call is an MCP tool call. On a surface whose harness has no remote MCP connectors, stop and tell the user Miorail needs one.

## Orchestration

### Read: which contract, at what price

1. `list_reviewed_stocks` turns a company or ticker into an underlying key.
2. `get_representations` returns every reviewed contract of it on Base, separately, by exact address. A ticker is not an identifier: different issuers publish different contracts for one company.
3. `compare_market_reality` answers one exact question about one contract (price on Base, cost of a given size). `get_use_access` says what else the token does, and `get_dividend_calendar` covers dividends.
4. Report each number with the age Miorail gives it. A null means not measured. It never means zero, free or cheap.

### Buy or sell

1. Identify the EXACT contract the user chose (read flow above), and the exact cash size in USDC.
2. Call `miorail_prepare_stock_action` with the identity fields exactly as Miorail returned them, the direction and `requestedCashAtomic` (USDC has 6 decimals: $10 is `10000000`). The response deliberately carries no price.
3. Give the user the `reviewUrl` and **stop**. Do not state a price, a cash amount, a premium or a comparison. The review page is the only place the current terms are established, because a router quote is open for about twenty seconds.
4. The user confirms on the review page. The page lets them sign there, or copy a **clearance** back to you. If they sign on the page, you are done; `miorail_get_execution_status` can follow it.
5. With a clearance the user pasted: call `miorail_get_stock_base_mcp_action` with it and a `requestId` you keep for retries. Miorail re-plans, simulates and refuses rather than return stale calls.
6. Check before submitting: `action.chainId` is `8453`, and `action.from` equals the Base MCP wallet address (`get_wallets`). If either differs, **stop** and tell the user. Do not submit calls prepared for another wallet.
7. Submit `action.calls` through Base MCP `send_calls` (see `## Submission`), share the approval link, and poll `get_request_status` until it settles.
8. Call `miorail_record_base_mcp_submission` exactly once with what Base MCP reported, then `miorail_get_execution_status`. A wallet approval is not a fill.

## Submission

Target tool: Base MCP **`send_calls`**. `miorail_get_stock_base_mcp_action` returns:

```json
{
  "action": {
    "chainId": 8453,
    "from": "0x…",
    "calls": [{ "to": "0x…", "value": "0x0", "data": "0x…" }],
    "atomicRequired": true
  }
}
```

Map it to `send_calls` unchanged:

```json
{
  "chain": "base",
  "calls": [{ "to": "0x…", "value": "0x0", "data": "0x…" }]
}
```

- `chainId` 8453 is the chain string `base`. Miorail returns no other chain.
- `action.from` must equal the Base MCP wallet address. Miorail binds every prepared action to its signed-in wallet.
- Pass `calls` exactly as returned. Do not reorder, merge, re-encode, drop or add a call. A buy often carries a token approval before the swap, and the calls must stay one atomic batch.
- `value` and `data` are already hex.
- If `send_calls` returns `{ approvalUrl, requestId }`, follow the approval flow in the Base MCP skill's [approval-mode.md](https://github.com/base/skills/blob/master/skills/base-mcp/references/approval-mode.md).

## Example Prompts

**"What does NVIDIA trade at on Base right now?"**
1. `list_reviewed_stocks` with "NVIDIA" → the underlying key.
2. `get_representations` → each reviewed contract, by issuer and address.
3. `compare_market_reality` for the contract the user means → the price on Base with its age.

**"Buy $10 of NVIDIA on Base."**
1. Read flow → the exact Coinbase contract the user confirms.
2. `miorail_prepare_stock_action` (buy, `requestedCashAtomic` `10000000`) → send the review link and stop.
3. The user confirms and pastes the clearance → `miorail_get_stock_base_mcp_action`.
4. Check `action.from` against `get_wallets`, then Base MCP `send_calls` with `chain: "base"` → the user approves in their wallet → `get_request_status`.
5. `miorail_record_base_mcp_submission`, then `miorail_get_execution_status`.

**"What would my Tesla tokens fetch if I sold them all?"**
1. `miorail_measure_my_stock_cash_out` for the contract → a measured answer for the whole current balance. Never scale a public quote to it.

**"Anything new on my stocks today?"**
1. `miorail_get_my_stocks_today` → dividends, corporate notices and changes for this wallet, with Miorail's own coverage stated.

## Risks & Warnings

- **slippage**: a router quote moves within seconds, which is why terms are confirmed on the review page and not in chat. Miorail re-simulates after the confirmation and refuses if the market moved past the reviewed bounds. Never restate a price from earlier in the conversation, and never raise a tolerance to make a call go through.
- **Submitting**: send only after the user confirmed on the review page AND approves in their wallet, and only when `action.from` is their Base MCP wallet. Never auto-approve. Submit each clearance once.
- **Tokenized stocks** are tokens issued by their issuers, and each issuer has its own terms and transfer rules. They are not offered to US persons. Wall Street's weekend and holiday closures do not stop trading on Base, so a price there can sit away from the last close. Say so when it matters, and never present a weekend price as a forecast of the reopen.

## Notes

- Miorail's public, read-only MCP: `https://miorail.xyz/mcp`. Its signed-in connector, `https://miorail.xyz/mcp/private`, carries the same reads plus the wallet-bound tools.
- Site and live boards: `https://miorail.xyz/stocks`. Settings → "Connect Miorail to your AI" shows and revokes grants.
- USDC on Base: 6 decimals. Stock tokens have their own decimals; take them from Miorail's answers, never assume 18.
- This plugin is published by Miorail at `https://miorail.xyz/wallet-mcp/miorail.md`. It is not a native Base MCP plugin.
