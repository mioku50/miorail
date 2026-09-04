# Miorail Plugin and Capability Registry

This document is the capability source of truth for users, developers, and coding agents.

> **Predates the tokenized-stocks work (Phases 10B–17, late Aug – Sep 2026).**
> It is accurate about what it covers and silent about Stocks, Radar and
> Investigate, which are the product's first three surfaces now. For the
> current shape read [README](../README.md) and
> [DEMO_CHECKLIST](DEMO_CHECKLIST.md).

A Base plugin document does **not** automatically connect a service to Miorail. Runtime claims must never exceed the recorded lifecycle stage.

## Lifecycle

```text
documented → manifested → adapter → scored → proven
```

| Stage | Meaning | Allowed product claim |
| --- | --- | --- |
| `documented` | External or vendored documentation is known. No trusted runtime integration is implied. | “This service may be considered for a future route family.” |
| `manifested` | A structured, allowlisted capability definition exists for constrained access. | “Miorail understands and constrains this capability.” No Route Card, recommendation, or execution claim. |
| `adapter` | A typed provider-neutral adapter returns validated candidates/evidence or builds validated calls. | “Miorail can use this provider inside a scoped route implementation.” |
| `scored` | Evidence is normalized and participates in deterministic comparison with honest gaps/confidence. | “Miorail can compare this provider for the supported goal.” |
| `proven` | A route reaches a validated Blueprint, user-approved execution, and Route Proof. A non-routable Extensions action reaches its typed safety policy, explicit Base Account approval, and exact reconciled Action Receipt. | “Miorail supports this provider for the explicitly listed route family or action,” subject to rollout gates. An Action Receipt is never called a Route Proof. |

Stages are monotonic only after tests and security gates exist. A broken or stale integration may be downgraded.

## Current registry

| Capability | Route family | Stage | Execution | Rollout state | Notes |
| --- | --- | ---: | --- | --- | --- |
| Uniswap | Swap | `proven` | User-approved Base Account calls | Feature-gated | Quote, scoring, Blueprint, Safety Kernel, submission, and Route Proof exist. |
| KyberSwap | Swap | `proven` | User-approved Base Account calls | Feature-gated | Provider-neutral comparison and pinned build path exist. |
| Moonwell | Earn | `proven` | User-approved Base Account calls | **Production gated** | Live APY/liquidity evidence and persisted Earn proof path exist; pinned-contract startup preflight must pass before enablement. |
| Morpho | Earn | `proven` | User-approved Base Account calls | **Production gated** | Live vault evidence and persisted ERC-4626 deposit proof path exist; pinned-contract startup preflight must pass before enablement. |
| Base MCP core `send` | Extensions / canonical USDC transfer | `proven` | Base MCP approval URL + explicit Base Account approval | Available when Base MCP is enabled and Action Receipt migration is present | Typed exact-amount/address adapter, tenant/Base MCP wallet match, canonical USDC safety gate, bounded amount policy, idempotency, provider status, and exact onchain `Transfer` reconciliation. Produces an Action Receipt, **not** a Route Proof. |
| Base MCP core `sign` | Extensions / signing | `adapter` | Explicit Base Account approval | Released only inside reviewed Virtuals SIWE | Arbitrary signing remains disabled. The Virtuals adapter may request only the exact provider challenge through `personal_sign`, consumes the approved signature in memory, and never stores or exposes it to the model or trace. |
| Base MCP core x402 buyer tools | Extensions / explicit GET payment | `adapter` | Base MCP approval URL + explicit Base Account approval | Available when Base MCP is enabled and Action Receipt migration is present | Typed exact-URL/cap adapter, reviewed hosts, canonical USDC, tenant wallet binding, idempotency, ephemeral response, and stable response hash. Provider-confirmed only; independent onchain settlement reconciliation is still required for `proven`. Provider-specific prepare/pay protocols are not covered. |
| Miorail x402 Intelligence Seller | Agent-facing B20 / proof intelligence | `adapter` | x402 exact payment; no wallet calls returned | **Live** `MIORAIL_X402_SELLER_INTELLIGENCE_V1`, fails closed when unset | Free typed catalog plus three fixed-price (`0.001 USDC`, Base) resources: exact-observation B20 exit analysis, B20 liquidity evidence, and independent verification of an already owner-published Route Proof. Invalid/missing inputs fail before payment. Settlement and delivery hashes are persisted separately. No recommendation, fresh executable quote, signing, broadcasting, or calldata. Enabled 2026-08-15; ordering verified in production (400 malformed, 404 unknown token, 404 unpublished proof, all before the 402), and each of the three resources bought once by an external agent paying real Base USDC. |
| Base MCP core `swap` | Swap | `manifested` | **Blocked in Extensions** | Routes handoff only | A swap intent is ROUTABLE and must enter provider comparison, Safety Kernel, and Route Proof. Native Base MCP swap cannot bypass Routes AI. |
| Base MCP core `send_calls` | Unassigned dispatcher | `manifested` | **Disabled** | Not released | Dynamic discovery never turns arbitrary calls into an adapter. Each action needs its own exact typed vertical. |
| Aerodrome | Advanced Swap | `manifested` | None in Route flow | Legacy read-only compatibility | Requires typed quote/build adapter, scoring, Safety Kernel, and proof before promotion. |
| Avantis | Extensions / Perps | `manifested` | Official provider UI handoff only | Reads + deterministic handoff | Position/market reads remain scoped to Extensions. Trade prompts are parsed into market, side, leverage, and collateral, labelled with liquidation risk, then handed to the official Avantis UI. No Miorail transaction adapter is claimed. |
| o1.exchange standard swaps | Routes / Advanced Swap | `scored` | Exact user-approved Base Account calls | Comparison available when the official shared credential and onchain pin are healthy; execution has its own rollout gate | Uses only `POST https://api.o1.exchange/api/v2/order` with `mevProtection: false`. Raw unsigned RLP is decoded; request echoes, chain, router, selector, route assets, pools, input, and minimum output are validated. The upgradeable router proxy, admin, implementation, and both bytecode hashes are pinned. Provider unlimited approval bytes are discarded and replaced with an exact approval. Gas USD and price impact remain **Not scored**; route provenance is overlapping. Permit2 and `/order/complete` are disabled because they require provider relay/broadcast. No `O1_AGGREGATOR_API_KEY` is used. Promotion to `proven` still requires a real reconciled Route Proof. See [O1_TRADING_API_COMPATIBILITY.md](research/O1_TRADING_API_COMPATIBILITY.md). |
| o1.exchange legacy DEX Aggregator API | Advanced Swap | `documented` | **Disabled** | Superseded, no credential requested | This older product is not the Routes provider. Miorail neither requests nor accepts `O1_AGGREGATOR_API_KEY`; the released adapter follows the current Base MCP standard-order specification above. |
| YO | Earn / Yield Expansion | `scored` | Exact user-approved Base Account calls | Available with Earn Routes after pinned-contract preflight | The pinned yoUSD vault is read directly on Base; `convertToShares`, TVL, Gateway build, exact approval, Safety Kernel, submission, and Earn Route Proof are implemented. APY and instant withdrawal liquidity remain **Not scored** because YO exposes no canonical onchain APY and redemption is asynchronous (~24h). |
| Bitrefill | Commerce | `scored` | User-signed x402 payment (gated off) | **Compare gate + checkout gate, both off by default** | T64: pinned Base 8453 + canonical USDC + pinned payTo, typed catalogue adapter, deterministic Commerce Score with `delivery_certainty` permanently Not scored, and a three-leg Commerce Route Proof. NOT `proven`: the proof path has no durable persistence yet and no delivered order has been reconciled. |
| OpenSea | NFT | `documented` | None | Planned | Future NFT Route family. Requires listing, approval, purchase, and ownership proof. |
| Venice | Private AI | `documented` | None | Planned | Future paid inference route; requires cost/privacy evidence and output receipt. |
| Balancer | Routes / Advanced Swap | `scored` | Exact user-approved Base Account calls | Comparison available; execution has a separate rollout gate | Balancer API paths are normalized with pool-level provenance and rebuilt locally using the pinned SDK. V2 uses an exact Vault approval; V3 uses exact token→Permit2 and bounded Permit2→Router approvals. The independent Safety Kernel decodes every call and mandatory simulation gates approval. Promotion to `proven` still requires a real reconciled Route Proof. |
| Hydrex | Routes / Advanced Swap | `scored` | Exact user-approved Base Account calls | Comparison available; execution has a separate default-off rollout gate | Fixed `GET https://hydrex-agent.com/state/quote` and `/prepare/swap` paths support Base-USDC ERC-20 pairs through pinned 0x or Kyber upstreams. The ERC-1967 proxy, admin, implementation, bytecode hashes, upstream bytecode hashes, Hydrex router allowlist, fee ceiling, outer tuple, upstream selector, assets, amount, requested slippage floor, recipient, referral, and deadline are verified. Provider approval bytes are discarded and replaced with an exact local approval. Gas and price impact remain **Not scored**, and Hydrex evidence is overlapping with its upstream. Simulation is mandatory before approval. `OPENOCEAN` and `OKX` are not claimed because the live service does not return a usable EVM quote for them. Promotion to `proven` still requires a real reconciled Route Proof. See [HYDREX_COMPATIBILITY.md](research/HYDREX_COMPATIBILITY.md). |
| Printr | Extensions / token launch | `documented` | None | Documentation-only | Prompt examples and product ownership are visible; no action adapter. |
| GMGN (`gmgh` accepted as alias) | Extensions / token intelligence | `documented` | None | Documentation-only | Read and quote questions are recognized; any buy/swap intent hands to Routes. No runtime provider claim. |
| Brickken | Extensions / agent registration | `documented` | None | Documentation-only | Provider-specific prepare/pay x402 protocol requires its own typed adapter; generic x402 URL payment is not substituted. |
| Flaunch | Extensions / token launch | `documented` | None | Documentation-only | Reads may use reviewed tools; buy/swap hands to Routes; launch has no action adapter. |
| Clawnch | Extensions / token launch | `documented` | None | Documentation-only | Reads may use reviewed tools; launch has no action adapter. |
| Virtuals | Extensions / agents | `adapter` | Reviewed SIWE through Base MCP + provider-confirmed Action Receipt | `agent_create` and authenticated `agent_list` released when migration 0049 and Base MCP are available | Fixed `mcp.acp.virtuals.io` JSON-RPC host and method allowlist. Wallet match, idempotency, encrypted bounded JWT session, explicit `Approve Sign-In`, secret redaction, and provider object reconciliation are enforced. Email, OTP, cards and all other methods remain unreleased. |
| Bankr | Extensions / launch intelligence | `documented` | None | Documentation-only | Reads may use reviewed tools; buy/swap hands to Routes. |

## Commerce Route Proof (T64)

Commerce is the first family where a settled transaction is **not** a proof. A
`CommerceRouteProofV1` carries three independent legs and only one terminal
state means success:

```text
payment settled  ∧  provider order confirmed  ∧  digital good delivered  →  delivered
```

| Final status | Meaning | Is it a purchase? |
| --- | --- | --- |
| `delivered` | All three legs confirmed, every item delivered. | Yes — the only success. |
| `partial_delivery` | Paid and confirmed; some items outstanding. | No |
| `order_unconfirmed` | **Money left the wallet and the storefront has confirmed no order.** | No — reconciliation event |
| `reconciliation_required` | Paid; the storefront cannot report a delivery state. | No — reconciliation event |
| `pending` / `payment_failed` / `failed` | Nothing to claim. | No |

The verdict is derived by `deriveCommerceProofFinalStatusV1` and re-checked by
the contract's own schema, so a hand-written status the legs do not support is
rejected. `order_unconfirmed` cannot be dressed up as a completed purchase by
any surface.

Redemption codes, PINs, and eSIM QR URLs are bearer credentials: they appear in
no contract, no hash, and no persisted record. The proof carries delivery
**counts and states** only.

## Bitrefill credentials (T64.1)

Two different Bitrefill APIs, two credentials, and the code refuses to cross
them (`commerceAuthHeadersV1` throws rather than sending the wrong one):

| Variable | Header | API surface | Notes |
| --- | --- | --- | --- |
| `BITREFILL_API_KEY` | `Authorization: Bearer` | Personal API `/v2/*` | Account-backed catalogue; invoices settle with `payment_method=usdc_base`. Preferred when set. |
| `BITREFILL_ACCESS_TOKEN` | `X-Access-Token` | x402 SIWX `/x402/*` | Short-lived (~2 h) session that waives x402 micro-fees. Used only when no API key is set. |

Verified live on 2026-07-25: the `/v2` catalogue publishes **no currency for
`package.price`** — a $200 Steam card is `{ value: "200", amount: 200,
price: 347689 }` under `currency: "USD"`. `price` is therefore never used as a
settlement total; the denomination comes from `amount`/`value` and is carried
as a `minimum`, with the exact USDC charge fixed by the invoice under review.

## Durable commerce orders (T64.2)

An order ROW exists before the provider is called. That single ordering gives
three properties the family needs:

- **one invoice per idempotency key** (`tenant + wallet + routeCardHash +
  packageId + requestId`), enforced by a unique index rather than application
  logic, so a double-submit cannot open a second checkout;
- **an uncertain provider call is a durable fact** (`creation_unknown`), never
  a lost request and never an automatic retry — a retry is exactly how a
  duplicate invoice gets created for money the user may already owe;
- **a checkout survives a restart**, because the binding lives in Postgres.

Two amounts are kept side by side and never merged: the catalogue's
`Estimated minimum` and the invoice's `Exact payment required`. The exact
figure comes from a created invoice and from nowhere else.

## Bitrefill invoice contract (T64.2.1, verified live)

Verified against real created invoices on 2026-07-25. Three facts a controlled
smoke had to establish, because the documentation does not state them:

| Field | Reality |
| --- | --- |
| `payment.price` | The exact charge, ALREADY in USDC base units (`5640000` = 5.64 USDC). Not `payment.amount`, and not a decimal. A fractional value is refused rather than rescaled. |
| `payment.address` | A deposit address issued **per invoice**. Two invoices for the same product returned two different addresses, neither equal to the x402 constant `0x480C…846A`. |
| order line | A FIXED denomination is ordered by `package_id` (`steam-usa<&>5`); `value` is the field for range-priced products. |

Consequence for the recipient guarantee: the x402 rail has one pinned payTo,
the Personal API does not. `CommerceInvoiceV1.recipientPolicy` records which
applied — `invoice_scoped` is a genuinely weaker check (form and rail, not a
constant) and the review panel says so. This is the main reason
`MIORAIL_COMMERCE_EXECUTION_V1` stays off.

A read failure AFTER a successful `POST /v2/invoices` reports
`invoice_creation_unknown` with the invoice id, never "nothing was created" —
the invoice exists, and a retry would create a second one.

## Commerce payment rail (T64.3)

Built and tested end to end on fixtures; **gated off** by default. No real
payment has been made.

- **Own Blueprint.** `CommercePaymentBlueprintV1`, not the swap-shaped
  `ExecutionBlueprintV1` — that one carries expectedOutput, slippage and
  requiredApprovals which are meaningless, or quietly permissive, for a
  transfer.
- **One call.** `USDC.transfer(invoice address, exact invoice amount)`, zero
  native value, no approval, no second call, and **no Builder Code suffix** —
  appending bytes to ERC-20 calldata changes what the token contract executes.
- **The kernel reads the CALLDATA**, not the call object's fields, so a call
  whose fields claim the invoice terms while its calldata pays someone else is
  blocked.
- **Signing is gated on simulation.** An unsimulated or reverted call is never
  offered to a wallet.
- **Three separate ladders**, and each rung requires the one below it:

```text
onchain transfer  ≠  provider payment confirmation  ≠  order confirmation  ≠  delivery
```

  A successful receipt with no matching ERC-20 Transfer log is `unverified` and
  forces reconciliation — never a completed payment.

- **Delivery material is never stored.** Codes, PINs and links are fetched on
  demand, returned once over a `no-store` response to the owning wallet, and
  written to no table, log, audit event or proof. The proof keeps
  `redemptionAvailable`, `deliveryObservedAt`, `orderStatus` and a hash over a
  REDACTED response — two orders with different codes hash identically, which
  is the point.

## Bitrefill promotion gate (`scored` → `proven`)

Still outstanding, in order:

1. ~~durable, tenant-scoped persistence for the order and its proof~~ —
   delivered by T64.2 (migration 0015). A checkout survives a restart, and one
   idempotency key can only ever hold one invoice.
2. a controlled live payment (T64.4): the rail exists as of T64.3 and is
   exercised only on fixtures. One real invoice, one explicit Base Account
   signature, a ceiling of a few USDC, watched to delivery or to an honest
   terminal failure. The per-invoice recipient must be confirmed by a settled
   payment before this is enabled.
3. reconciliation of a `delivered` proof end to end from a real paid order.
4. an operator runbook for `order_unconfirmed` — the state where money moved
   and no order exists.

Until all three land, `MIORAIL_COMMERCE_ROUTE_V1` and
`MIORAIL_COMMERCE_EXECUTION_V1` stay off in production and Bitrefill must not
be presented as a supported purchase path.

## Promotion requirements

### `documented → manifested`

- explicit owner and route-family scope;
- pinned chain and provider identity;
- host, method, path, and authentication allowlist;
- typed request/response schema;
- documented failure and timeout behavior.

### `manifested → adapter`

- provider-neutral contract;
- deterministic normalization and hashing;
- fixture-based tests with no live network calls;
- secret-safe request/response provenance;
- typed fail-closed outcomes.

### `adapter → scored`

- comparable evidence model;
- freshness and expiry policy;
- dependency/overlap analysis;
- deterministic versioned scoring;
- `Not scored` behavior for missing evidence;
- degraded behavior when only one provider is available.

### `scored → proven`

- persisted Route Card and selected candidate;
- exact unsigned Execution Blueprint;
- Safety Kernel for pinned contracts, spenders, recipients, amounts, and calldata;
- explicit Base Account approval;
- durable receipt verification;
- expected-versus-actual Route Proof;
- tenant/wallet isolation and idempotency tests.

## Agent rules

1. Never infer support from `skills/**.md`, Base documentation, or plugin names.
2. Never present a `documented` or `manifested` capability as a selectable Route Card provider.
3. Never prepare calls for a capability below `adapter`; a live Base MCP tool
   name or published plugin spec is not an adapter.
4. Never recommend a capability below `scored`.
5. Never claim completed execution support below `proven`. For a non-routable
   action, `proven` means an exact reconciled Action Receipt, not a Route Proof.
6. Feature flags, migrations, provider configuration, and startup preflights may still block a `proven` capability in production.
7. When registry and runtime disagree, fail closed and open a scoped registry/runtime reconciliation task.

## Planned route-family order

1. Alchemy Base simulation adapter for paid intelligence — delivered (T63B);
2. Commerce — Bitrefill — adapter and scoring delivered (T64); promotion to
   `proven` blocked on the gate above;
3. NFT — OpenSea;
4. Private AI — Venice;
5. Advanced Swap — Balancer, Hydrex, o1.exchange and Aerodrome;
6. Yield Expansion — YO.

Adding a new Markdown plugin file is not a roadmap item. Implementing and promoting a route family is.
