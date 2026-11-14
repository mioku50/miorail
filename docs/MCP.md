# Still and Miorail for assistants (MCP)

Three MCP servers, one product. None signs, sends or holds a key; a tool that
prepares an action returns a link to a review the person's own wallet signs.

| Server | Sign-in | For |
| --- | --- | --- |
| `https://miorail.xyz/mcp/still` | none | Still's terms, the public check of any Base wallet, what-ifs, and what a loan could buy |
| `https://miorail.xyz/mcp` | none | tokenized-stock evidence, B20 measurements and Still's terms |
| `https://miorail.xyz/mcp/private` | OAuth 2.1 with the wallet | every `/mcp` read and Still's Bitrefill reads, plus tools bound to the wallet that signed in; another wallet's check and a what-if stay on `/mcp/still` |

Tool lists and versions move with releases; `tools/list` on each server is the
current answer, and `ops/deploy.sh` checks the public names and versions on
every deploy.

## Still's own server: `/mcp/still`

Read-only, no sign-in, thirty calls a minute per client.

- `get_still_terms`: the shares and windows in force now.
- `still_check_wallet`: any Base wallet by address or name, the same public
  check as `https://miorail.xyz/w/<wallet>`.
- `still_what_if`: a price move, a draw, a repayment or a deposit, answered
  by the Agent's own engine.
- `still_find_spend` and `still_spend_product`: what a loan could pay for at
  Bitrefill, the same catalogue and prices as Spend.

Add `https://miorail.xyz/mcp/still` as a connector in Claude, ChatGPT, Grok or
Cursor.

## Public Miorail MCP: `/mcp`

Read-only tools over tokenized stocks, over stored B20 evidence, and Still's
terms:

```text
list_reviewed_stocks        every reviewed security, by ticker, name or ISIN
get_representations         every exact address that claims one security
compare_market_reality      one size, one direction, every representation
get_market_changes          what moved since a stored observation
get_use_access              what one exact address can be used for, and what gates it
check_address_identity      compare an exact address with the reviewed contract
get_dividend_calendar       declarations, measured reinvestments and estimates
get_recorded_changes        recorded changes across the reviewed market
get_reopen_round            Call the reopen: the weekend round, Base's call, results
get_still_terms             versioned limits and reviewed market/earnings windows

miorail_discover_status
miorail_list_b20_opportunities
miorail_summarise_b20_universe
miorail_get_b20_opportunity
miorail_explain_b20_rejection
miorail_compare_b20_tokens
miorail_find_b20_projects
miorail_b20_market_rails
```

`get_representations` never chooses one: different issuers publish different
contracts for the same company, and that choice is not Miorail's to make. A
company name reaches a security through a small ISIN-bound alias table, and
every row says whether the issuer's own naming or a Miorail alias found it.

`get_still_terms` reads the same earnings service and cache as
`GET /api/public/still/terms`. Its answer is the terms themselves: 50% of the
protocol's collateral factor, reduced to 40% for stocks in Still's reviewed
closed-market or earnings window, while their earnings calendar is unread, or
while their reference price has gone more than 25 open-market hours without an
update.
Returned windows and `calendarRead` are part of the answer. These are terms,
not a personal borrowing quote or advice to borrow. Still is offered only in
eligible jurisdictions: not to US persons, and not in the United States, Cuba,
Iran, North Korea, Syria, Crimea or the so-called Donetsk and Luhansk People's
Republics.

The stock tools and `miorail_discover_status` include a free `evidencePackage`
(`miorail-evidence-package/v1`). Each claim names JSON Pointers into the
original answer, its exact address, size and time scope where applicable, and
its source, block, observation time and existing evidence hash. Supply,
quotes, reference feeds, venue catalogues and historical observations keep
separate provenance. `generatedAt` is packaging time. A missing block, time or
hash is explicitly `null` and listed in `missing`; it never means zero, safe,
absent or freshly checked. Source-content, measurement and snapshot hashes
retain their different meanings. A transaction hash is a lookup reference, not
an evidence hash. Counts and estimates remain derived facts. No extra RPC read
or new hash of the answer is performed to produce this package.

The package indexes the evidence exposed by that tool. Service counts,
identity-check projections, dividend effects and frozen game stages do not
retain every primary block or hash; their missing metadata stays explicit.
Recorded event time, company declaration date, feed publication time and a
multiplier's effective date do not replace observation time. Existing summary,
pagination, coverage and quote-expiry semantics still apply.

`get_use_access` exists because of a measured failure: an assistant asked
whether a tokenized stock could be posted as collateral had nothing to read
and answered from an announcement. The tool carries the announcement and the
reading joined and separate, in four states, where `unchecked` (a venue nobody
read) is never `not_listed`. It is public and holds no wallet, so it can never
say whether a particular address may transfer; and its `blockTag` names the
fields it governs, because two of the venues answer from catalogues that
publish no block at all.

The public server has no wallet, signing, payment, approval or execution tool.
Its Discover projection is parity-tested against the product truth layer, and
a renamed tool fails the deploy rather than a caller.

Connect it with no key, no account and no allowlist:

```jsonc
// Claude Code, Claude Desktop, Cursor, or any MCP client
{ "mcpServers": { "miorail": { "type": "http", "url": "https://miorail.xyz/mcp" } } }
```

## Connected Miorail MCP: `/mcp/private`

Every public read tool, Still's Spend reads, and the tools bound to the wallet
that authorised the connection. It cannot read, prepare or execute for any
other wallet, and no argument would let it try.

Authorisation is OAuth 2.1 with PKCE: the client opens `/authorize`, you
approve in your own browser under scope `miorail:connected`, and the tools
appear. There is no `sign` scope and no `execute` scope, because the server
cannot sign or execute. `ops/deploy.sh` checks the discovery document and that
a bare request is refused, on every deploy.

```jsonc
{ "mcpServers": { "miorail": { "type": "http", "url": "https://miorail.xyz/mcp/private" } } }
```

### Still from an assistant

`miorail_get_my_still` reads the connection owner's Still report through the
same service and cache as `GET /api/still/mine`, and takes no wallet argument.
Preserve `reading.block`, `reading.blockTime`, `cached` and any failed
coverage: if `headline.complete` is false, a known amount means **at least**
that amount, null stays unknown, and `chain_unavailable` is a failed read,
never an empty wallet. It prepares nothing.

Four tools each return the same five-minute, wallet-bound review link the page
opens, never a call:

- `miorail_prepare_still_loan` takes the collateral and amount the person
  named: stocks on Aave V4, and cbBTC, WETH, ETH and PAXG on Morpho;
- `miorail_prepare_still_purchase` opens the Bitrefill invoice they chose,
  exactly as Spend does, and links the review of the loan that pays it;
- `miorail_prepare_still_wallet_purchase` opens the same invoice to be paid
  from USDC already in the wallet, with no loan;
- `miorail_prepare_still_repay` links an exact repayment, or all of it up to a
  bound the person named, and with `returnCollateral` the loan's collateral
  comes back to the wallet in the same review.

The email and a top-up's number go to Bitrefill only, and no tool answer
repeats them. The page a purchase link opens shows the person where Bitrefill
will send the purchase before they sign, because an assistant named it. The
reviews these links open are checked by the server exactly as Get money and Repay are, Still's
limit included, and a new loan, purchase or stock buy is refused where Still
is not offered: the check reads the browser that opens the link, never the
assistant's own server. Afterwards `miorail_get_still_review_status` reads
what happened, from Base, with Bitrefill's own reading of a purchase's invoice
and the link that shares it.

A chat that draws MCP Apps, as Claude does, shows these results as Still's
review card (`ui://still/review.html`): what was prepared, a button that opens
the review on miorail.xyz, and where it stands until Base confirms it. A phone
wallet can pair with the card through WalletConnect and sign a repayment in
the chat; a new loan opens on miorail.xyz, where Still can check where it is
asked from. The card holds no key, and a client that does not say it draws
apps gets the same results as text. The Wallet MCP plugin is
`https://miorail.xyz/wallet-mcp/miorail.md`.

`miorail_prepare_swap` writes one swap for Swap AI: what the person gives,
what they receive and how much (an exact amount, or all or half of the
wallet's own, read at one block), and returns a link to Swap AI with that swap
filled in by exact addresses. Nothing runs from the link: Swap AI waits for
the person to press Compare, then compares the routes and checks the chosen
route's calls against the swap the person approves (simulating them where that
route needs it), and the person's wallet signs. The reply carries no price, route or calldata.

### The weekend game and measurements

`miorail_get_my_reopen` reads the wallet's picks, score and record in Call the
reopen, the weekend game on the Stocks Weekend tab, and
`miorail_call_the_reopen` makes or changes picks for the stocks the user named,
until the Sunday 17:00 ET lock. A stock not named keeps its pick. The public
`get_reopen_round` reads the same round with nobody's picks in it.

`compare_market_reality` reads stored evidence, so it could truthfully report
"no fresh answer at this size" and had no way to get one.
`miorail_measure_market_reality` is the web page's measure button, calling the
same coordinator, so a measurement taken from an assistant and one taken from
the screen are the same run. It declares `readOnlyHint: false` because it
spends router calls and writes evidence; it is budgeted per wallet; and a
repeat of an identical question joins the run already in flight. A timeout is
not a failure: the run continues, and the refusal says to read the answer
rather than press again.

### A tokenized stock from an assistant

```text
miorail_prepare_stock_action      → actionDraftId + review link; no executable calls
   you, on the review page          read current terms, confirm and sign in your wallet
miorail_get_execution_status      → ask with that actionDraftId; read the reconciled outcome
```

Before the clearance is minted the token's own onchain transfer policy is
asked about that exact wallet. A measured denial of the scope that governs the
direction refuses, and so does a contract-wide pause; an unread policy, a
throttled endpoint and a non-B20 contract all proceed. It is the issuer's rule
enforced where the issuer publishes it. Where Still is offered is a separate
check: a buy is not confirmed from the United States, and a sale always is.

An assistant cannot confirm on your behalf, and it never holds a key. The
review page signs from the browser, and the clearance is still offered for an
assistant that prefers to hand the batch to Wallet MCP.

The status tool accepts **exactly one** of `actionDraftId` or the existing
`planId`. The draft lookup is bound to the authenticated tenant and wallet, and
follows its latest released blueprint to the existing Route Proof. An owned
draft without a released action returns `not_released`; an unknown or foreign
draft gives the same not-found refusal. An unavailable store is an unavailable
read, never an invented pending or successful outcome.

For an already submitted stock batch, status resolves its stored batch ID
through the wallet's public RPC, then has the existing reconciler read the
transaction receipts from Base. Wallet receipts provide lookup hashes only. A
successful approval without the expected wallet movements requires
reconciliation; it is not a completed purchase. This check still works after
the review quote expires and never prepares or resends a trade.

Status returns no calls, clearance or signature. `submitted` is not success,
and `submitted_unknown` is not a reason to prepare or send again. The assistant
reports `entry_succeeded` only when the existing onchain reconciler does.

### My stocks today

`miorail_get_my_stocks_today` is the calculation behind the signed-in Stocks
overview (`GET /api/stocks/today`), with no wallet argument. Unread updates
are paged with up to fifty source IDs, keeping each issuer transaction whole.
`miorail_mark_stock_updates_read` accepts the page's unchanged, wallet-bound
proof only after the user explicitly asks to mark the shown updates as read;
fetching, explaining or sending a notification never grants that
authorization. `inbox.items` is the news feed and `changes.cards` its raw
evidence, which assistants must not repeat as more news.
`miorail_measure_my_stock_cash_out` asks a fresh router quote into USDC for
the owner's entire balance of one covered contract; nothing is sold or
approved.

### Also on the connected server

Seven more tools are bound to the same wallet. Five of them change what the
server holds (a clearance, a plan, a recorded submission, a review), so they
are not marked read-only; none signs or sends.

- `miorail_read_borrow_capacity` reads the lending markets where an exact Base
  token is collateral: the protocol's own maximum, with Still's stricter
  allowance beside it. It prepares nothing.
- `miorail_review_borrow` measures one exact Morpho borrow and returns a review
  for the person. It reviews only Still's registered markets (cbBTC, WETH and
  PAXG against USDC): the calls are the wallet's own calls to Morpho Blue,
  written and decoded by Miorail, and nothing is authorised to act for the
  wallet. Any other collateral or market is refused before anything is read
  (`market_outside_still`); a loan against one of Still's stocks is prepared
  by `miorail_prepare_still_loan`.
- `miorail_check_exit_profile` runs the live entry-and-exit check of one B20
  token for the wallet, where the server offers B20 entry: it quotes the entry,
  simulates it, quotes the exit at the size the entry produced, and simulates
  the calls together. Only this check can clear a token for entry.
- `miorail_prepare_b20_entry` turns that clearance into a stored, simulated
  entry plan.
- `miorail_get_base_mcp_action` returns the plan's exact calls in the shape
  Wallet MCP's `send_calls` takes, only after the person has seen the review
  and said yes.
- `miorail_record_base_mcp_submission` records what Wallet MCP reported, once
  per action.
- `miorail_get_stock_base_mcp_action` turns a stock action the person confirmed
  on its review page into the same unsigned Wallet MCP request the site makes.

## Wallet MCP extensions

Miorail reads the live Coinbase Wallet MCP registry
(`https://wallet-mcp.coinbase.com`; existing `https://mcp.base.org`
connections remain supported until an explicit OAuth reconnect) and classifies
its tools as `READ`, `ACTION`, `ROUTABLE`, or blocked before a model can select
them.

- `READ` tools may answer scoped Base questions.
- `ROUTABLE` swap and yield requests are handed to Swap AI; they cannot bypass
  provider comparison or the Route Proof.
- An `ACTION` is released only through a typed input policy, wallet binding,
  safety checks, explicit approval, idempotency, persistence, and
  reconciliation.
- Reviewed HTTP recipes bypass generic prompting: Moonwell market and health
  reads use pinned hosts and exact paths.
- Virtuals has a standalone sign-in action: Miorail requests an exact SIWE
  challenge, pauses for approval and keeps the authenticated provider session
  encrypted. Email OTP reads hide the code unless the user explicitly asks to
  reveal it; no code is submitted or used.
- Unknown tools, arbitrary calls and documentation-only plugins remain
  blocked. Dynamic discovery never grants execution.

Action Receipts are deliberately separate from Route Proofs. Which plugin is at
which stage: [PLUGIN_REGISTRY.md](PLUGIN_REGISTRY.md).

## Paid intelligence and x402

x402 funds allowlisted evidence, simulation, inference or compute. It does not
fund portfolio asset movement. Miorail also implements the seller side:

```text
external agent
  → x402 payment in Base USDC
  → stored B20 intelligence / published proof verification
  → versioned response + request hash + deterministic data hash
```

The free catalogue is at `/api/x402/intelligence/v1/catalog`. Paid resources
are bound to stored evidence; missing or invalid inputs are rejected before
payment middleware, and no seller endpoint prepares wallet calls.

In a facilitated x402 seller payment, the external payer signs an
authorization and the facilitator may build and broadcast the settlement
transaction, so receiving x402 revenue does not by itself mean Miorail
originated a transaction carrying its Builder Code. For app-originated
transactions the Builder Code is attached as described in the README's
[execution boundary](../README.md#execution-boundary).
