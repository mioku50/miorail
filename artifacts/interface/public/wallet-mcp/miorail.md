---
title: "Miorail Plugin"
description: "Still terms and wallet readings via Miorail MCP; Morpho reviews open in Miorail, stock actions → send_calls."
tags: [tokenized-stocks, trading, swap, discovery, borrowing]
name: miorail
version: 0.2.1
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
risk: [slippage, liquidation]
---

# Miorail Plugin

> [!IMPORTANT]
> Run Wallet MCP onboarding first (see `SKILL.md`). Wallet MCP, formerly Wallet MCP, is Coinbase's MCP server at `https://wallet-mcp.coinbase.com`. The Miorail connector must also be installed and signed in once, **with the same wallet** Wallet MCP uses (see `## Installation` and `## Auth`).
>
> Still uses Miorail's engine, a third-party service, not part of Base or Coinbase. Still and the tokenized stocks it reads are not offered to US persons; each issuer's own terms apply. Miorail reports measurements, not advice: never suggest what to buy or sell, or whether to borrow.

## Overview

[Still](https://miorail.xyz) is the front door to Miorail's engine on Base: it reads what a wallet could borrow in USDC without selling supported collateral. Its terms and wallet Mirror cover Coinbase tokenized stocks through Aave V4 and cbBTC and ETH through Morpho Blue; a reading is not an executable loan. Miorail also measures reviewed stock contracts, prices, cash-out costs, pools and lending. A stock buy or sell can produce **unsigned calldata** for Wallet MCP `send_calls`, after the user confirms Miorail's live review. A Morpho borrow review returns a browser link and no calls; the person decides and signs there. Miorail never signs, never broadcasts and holds no key.

## Detection

- If `get_still_terms` is exposed, the client can read Still's current terms. `miorail_get_my_still` requires the signed-in connector and reads only its own wallet.
- If tools named `list_reviewed_stocks`, `get_representations` and `miorail_prepare_stock_action` are exposed, the Miorail connector is installed and signed in.
- If only public tools are exposed, the user installed `https://miorail.xyz/mcp`. Public readings work; the wallet Mirror, personal borrowing checks and actions need the signed-in connector (see `## Installation`).
- Read the live tool descriptions before choosing a flow. If stock tools are present but a Still tool is missing, refresh the connector's catalogue once or report that the tool is unavailable. Do not substitute a website fetch or assume a missing action is supported.
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

**Public readings, without signing in:** use `https://miorail.xyz/mcp` instead. It carries Still's terms and the public stock reads, but no wallet-bound tool.

## Auth

`oauth-on-install`. The client registers itself, then opens `https://miorail.xyz` for the user. The user signs in with the wallet they intend to read or act from and approves the connection. Scopes are `miorail:connected` and `offline_access`. Access tokens last 15 minutes, refresh tokens rotate, and the grant expires after 30 days. The user can revoke it at any time in Miorail's Settings.

The grant is bound to the ONE wallet that signed in. No argument can read, prepare or execute for another wallet. That wallet must be the one Wallet MCP signs with: calls Miorail prepares for one wallet are wrong for any other.

## Surface Routing

| Capability | Every surface (Claude Code, Codex, Cursor, Claude.ai, ChatGPT) |
|---|---|
| Still's current terms, supported assets and closed-market or earnings windows | `get_still_terms` (public or signed-in MCP). |
| Still's Mirror for the connected wallet: holdings, loans and amounts | `miorail_get_my_still` (signed-in connector only, no wallet argument). |
| Check a specifically requested Morpho loan | `miorail_read_borrow_capacity`, then `miorail_review_borrow` for an exact amount and market → the user's browser review. |
| Find a company's tokenized stocks, prices on Base, cost to buy or sell, pools and lending | Miorail MCP read tools (external MCP). |
| A personal daily read, or what the user's whole position would fetch | Miorail MCP wallet-bound tools (signed-in connector). |
| Prepare a buy or sell | `miorail_prepare_stock_action` → a review link the user opens in a browser. |
| Submit a stock buy or sell after the user confirmed | `miorail_get_stock_base_mcp_action` → Wallet MCP `send_calls` → approval in the user's wallet. |

No surface needs a shell or the `web_request` allowlist: every Miorail call is an MCP tool call. On a surface whose harness has no remote MCP connectors, stop and tell the user Miorail needs one.

## Orchestration

### Still: terms and this wallet's Mirror

1. Call `get_still_terms` before stating Still's shares or windows. Report its `termsVersion` and current terms; a share of the protocol's collateral factor is not the same as a share of the asset's price. An unread earnings calendar is not an empty calendar.
2. For the user's own holdings and loans, call `miorail_get_my_still` with no wallet argument. Its owner comes from the signed-in connection, never from a wallet address supplied in chat.
3. Keep `reading.block` and the reading time beside the amounts. They are a snapshot and become stale. When `headline.complete` is false, describe the headline amount as **at least** the returned amount; do not silently turn partial coverage into a complete total.
4. If the tool reports `chain_unavailable`, state that Miorail could not read the chain. Do not report an empty wallet, zero debt or zero available money from that failure.
5. A Mirror amount is not a prepared loan. Aave V4 stock holdings and debt can be read, but an Aave V4 borrow, collateral supply or repayment is not available through this plugin. Do not build those calls yourself.

### Review a specifically requested Morpho borrow

1. Proceed only when the user explicitly asks for a loan review and names the collateral and exact amount. Resolve the exact collateral address from Miorail's returned identity or terms; do not invent a contract from a ticker. Native ETH does not authorise an improvised wrapping or collateral-supply step.
2. Call `miorail_read_borrow_capacity` for that exact collateral. Give every market its own row, keeping the market id, loan asset, block and `bound` (collateral or market liquidity). A protocol maximum is not Still's allowance. For a Still request, stop if the tools cannot establish its bound for that exact market.
3. Have the user select a market if more than one is returned. Call `miorail_review_borrow` with the same `collateralTokenAddress`, the user's `borrowAmountAtomic` in the loan asset's units, and that `marketId`. Never choose a larger amount, a different market or a looser limit to get a pass.
4. Read its warnings and every `steps` row, including any authorisation that outlives the loan. Report `refusalText` as returned and stop on a refusal; a failed simulation is not a ready review. Do not retry with a smaller amount unless the user asks.
5. Only `verdict: ready_for_your_approval` supplies a `reviewUrl`. Give the user that link with its expiry and stop. The page refreshes the checks, and the user decides and signs with their own wallet. This response contains no calldata and has no follow-up tool that releases borrow calls for Wallet MCP `send_calls`. Never suggest whether they should borrow or report a loan as completed from the review alone.

### Read: which contract, at what price

1. `list_reviewed_stocks` turns a company or ticker into an underlying key.
2. `get_representations` returns every reviewed contract of it on Base, separately, by exact address. A ticker is not an identifier: different issuers publish different contracts for one company.
3. For the requested size, direction and destination, `compare_market_reality` compares the underlying's representations; keep each exact address separate and report the row the user means. `get_use_access` says what else that exact token does, and `get_dividend_calendar` covers dividends.
4. Report each number with the age Miorail gives it. A null means not measured. It never means zero, free or cheap.

### Buy or sell

1. Identify the EXACT contract the user chose (read flow above), and the exact cash size in USDC.
2. Call `miorail_prepare_stock_action` with the identity fields exactly as Miorail returned them, the direction and `requestedCashAtomic` (USDC has 6 decimals: $10 is `10000000`). The response deliberately carries no price.
3. Give the user the `reviewUrl` and **stop**. Do not state a price, a cash amount, a premium or a comparison. The review page is the only place the current terms are established, because a router quote is open for about twenty seconds.
4. The user confirms on the review page. The page lets them sign there, or copy a **clearance** back to you. If they sign on the page, follow the original `actionDraftId` with `miorail_get_execution_status`. Do not prepare a second trade to find out what happened to the first.
5. With a clearance the user pasted: call `miorail_get_stock_base_mcp_action` with it and a `requestId` you keep for retries. Miorail re-plans, simulates and refuses rather than return stale calls.
6. Check before submitting: `action.chainId` is `8453`, and `action.from` equals the Wallet MCP wallet address (`get_wallets`). If either differs, **stop** and tell the user. Do not submit calls prepared for another wallet.
7. Submit `action.calls` through Wallet MCP `send_calls` (see `## Submission`), share the approval link, and poll `get_request_status` until it settles.
8. Call `miorail_record_base_mcp_submission` exactly once with what Wallet MCP reported, then `miorail_get_execution_status`. A wallet approval is not a fill.

## Submission

For stock buys and sells, the target tool is Wallet MCP **`send_calls`**. `miorail_get_stock_base_mcp_action` returns:

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
- `action.from` must equal the Wallet MCP wallet address. Miorail binds every prepared action to its signed-in wallet.
- Pass `calls` exactly as returned. Do not reorder, merge, re-encode, drop or add a call. A buy often carries a token approval before the swap, and the calls must stay one atomic batch.
- `value` and `data` are already hex.
- If `send_calls` returns `{ approvalUrl, requestId }`, follow the approval flow in the Wallet MCP skill's [approval-mode.md](https://github.com/coinbase/agents/blob/main/skills/wallet-mcp/references/approval-mode.md).

For Still's terms, Mirror and borrow-capacity reads, submission is **none**: they only read. For `miorail_review_borrow`, submission through Wallet MCP is also **none**: it returns a review link, not a batch. The person opens the review and signs there; do not apply the stock `send_calls` mapping to a borrowing review.

## Example Prompts

**"What does NVIDIA trade at on Base right now?"**
1. `list_reviewed_stocks` with "NVIDIA" → the underlying key.
2. `get_representations` → each reviewed contract, by issuer and address.
3. Establish the size and direction the user means, then `compare_market_reality` for that underlying and question → separate prices on Base, each with its exact address and age.

**"Buy $10 of NVIDIA on Base."**
1. Read flow → every reviewed NVIDIA representation. The user chooses the exact contract; do not choose an issuer for them.
2. `miorail_prepare_stock_action` (buy, `requestedCashAtomic` `10000000`) → send the review link and stop.
3. The user confirms and pastes the clearance → `miorail_get_stock_base_mcp_action`.
4. Check `action.from` against `get_wallets`, then Wallet MCP `send_calls` with `chain: "base"` → the user approves in their wallet → `get_request_status`.
5. `miorail_record_base_mcp_submission`, then `miorail_get_execution_status`.

**"What could my wallet borrow through Still without selling?"**
1. `get_still_terms` → the current shares, windows and supported assets.
2. `miorail_get_my_still` → this connection's wallet snapshot, with `reading.block` and its age.
3. If `headline.complete` is false, say **at least**; if the chain read failed, report `chain_unavailable`. Neither a snapshot nor a failed read creates a loan.

**"Review borrowing 10 USDC against my cbBTC on Base."**
1. Read Still's terms and wallet Mirror, then `miorail_read_borrow_capacity` for the exact collateral it returned. A protocol maximum cannot replace Still's bound; if that bound is not established, stop.
2. Keep the user-selected market and exact requested amount. `miorail_review_borrow` uses `borrowAmountAtomic: "10000000"` only for a market whose loan asset is USDC (6 decimals).
3. If refused, give the reason and stop. If `ready_for_your_approval`, give `reviewUrl` and its expiry; the user reviews and signs there. Do not call Wallet MCP `send_calls` with this response.

## Risks & Warnings

- **slippage**: a router quote moves within seconds, which is why terms are confirmed on the review page and not in chat. Miorail re-simulates after the confirmation and refuses if the market moved past the reviewed bounds. Never restate a price from earlier in the conversation, and never raise a tolerance to make a call go through.
- **liquidation**: collateral prices, accrued debt and protocol terms can move a borrowing position toward liquidation. Preserve the review's current health, liquidation warnings, block and expiry, including persistent adapter authorisations. Still's allowance is not a guarantee against liquidation; do not increase it or suggest borrowing.
- **Submitting stock calls**: send only after the user confirmed on the review page AND approves in their wallet, and only when `action.from` is their Wallet MCP wallet. Never auto-approve. Submit each clearance once. A borrow review stays on its own browser approval path.
- **Tokenized stocks** are tokens issued by their issuers, and each issuer has its own terms and transfer rules. Wall Street's weekend and holiday closures do not stop trading on Base, so a price there can sit away from the last close. Say so when it matters, and never present a weekend price as a forecast of the reopen.

## Notes

- Miorail's public, read-only MCP: `https://miorail.xyz/mcp`. Its signed-in connector, `https://miorail.xyz/mcp/private`, carries the same reads plus the wallet-bound tools.
- Site and live boards: `https://miorail.xyz/stocks`. Settings → "Connect Miorail to your AI" shows and revokes grants.
- Still's Home and wallet readings use the same Miorail engine and current terms. A read or a review link is not proof of a completed borrow; this plugin does not prepare Aave V4 actions or a Morpho repayment.
- USDC on Base: 6 decimals. Stock tokens have their own decimals; take them from Miorail's answers, never assume 18.
- This plugin is published by Miorail at `https://miorail.xyz/wallet-mcp/miorail.md`. It is not a native Wallet MCP plugin.
