# Miorail Plugin and Capability Registry

This document is the capability source of truth for users, developers, and coding agents.

A Base plugin document does **not** automatically connect a service to Miorail. Runtime claims must never exceed the recorded lifecycle stage.

## Lifecycle

```text
documented → manifested → adapter → scored → proven
```

| Stage | Meaning | Allowed product claim |
|---|---|---|
| `documented` | External or vendored documentation is known. No trusted runtime integration is implied. | “This service may be considered for a future route family.” |
| `manifested` | A structured, allowlisted capability definition exists for constrained access. | “Miorail has a constrained read surface.” No Route Card or execution claim. |
| `adapter` | A typed provider-neutral adapter returns validated candidates/evidence or builds validated calls. | “Miorail can use this provider inside a scoped route implementation.” |
| `scored` | Evidence is normalized and participates in deterministic comparison with honest gaps/confidence. | “Miorail can compare this provider for the supported goal.” |
| `proven` | The full path reaches a validated Blueprint, user-approved execution, and Route Proof. | “Miorail supports this provider for the listed route family,” subject to rollout gates. |

Stages are monotonic only after tests and security gates exist. A broken or stale integration may be downgraded.

## Current registry

| Capability | Route family | Stage | Execution | Rollout state | Notes |
|---|---|---:|---|---|---|
| Uniswap | Swap | `proven` | User-approved Base Account calls | Feature-gated | Quote, scoring, Blueprint, Safety Kernel, submission, and Route Proof exist. |
| KyberSwap | Swap | `proven` | User-approved Base Account calls | Feature-gated | Provider-neutral comparison and pinned build path exist. |
| Moonwell | Earn | `proven` | User-approved Base Account calls | **Production gated** | Live APY/liquidity evidence and persisted Earn proof path exist; pinned-contract startup preflight must pass before enablement. |
| Morpho | Earn | `proven` | User-approved Base Account calls | **Production gated** | Live vault evidence and persisted ERC-4626 deposit proof path exist; pinned-contract startup preflight must pass before enablement. |
| Aerodrome | Advanced Swap | `manifested` | None in Route flow | Legacy read-only compatibility | Requires typed quote/build adapter, scoring, Safety Kernel, and proof before promotion. |
| Avantis | Unassigned | `manifested` | None in Route flow | Legacy read-only compatibility | Not an active route-family commitment. |
| o1.exchange (Trading API) | Advanced Swap | `documented` | **Disabled** | `compatibility: incompatible_with_base_account_v1` | T67D gate run 2026-08-01. The documented flow requires a user private key, `signTransaction`, and provider-side broadcast via `/order/complete`; the calldata is mutated after the quote by a Permit2 signature substitution. Do not claim route comparison or execution support. `pnpm o1:compat` reproduces the finding list. See [O1_TRADING_API_COMPATIBILITY.md](research/O1_TRADING_API_COMPATIBILITY.md). |
| o1.exchange (DEX Aggregator API) | Advanced Swap | `documented` | None | Not evaluated | A **separate product**: Base-only, returns `{to,data,value}` for the O1Router and has no `/complete` step, so the user's own wallet submits. Architecturally closer to Miorail, but not gated, not adapted, and not connected. Must never be conflated with the Trading API row above. |
| YO | Yield Expansion | `documented` | None | Planned | Requires typed APY/liquidity/withdrawal/build/proof adapters. |
| Bitrefill | Commerce | `scored` | User-signed x402 payment (gated off) | **Compare gate + checkout gate, both off by default** | T64: pinned Base 8453 + canonical USDC + pinned payTo, typed catalogue adapter, deterministic Commerce Score with `delivery_certainty` permanently Not scored, and a three-leg Commerce Route Proof. NOT `proven`: the proof path has no durable persistence yet and no delivered order has been reconciled. |
| OpenSea | NFT | `documented` | None | Planned | Future NFT Route family. Requires listing, approval, purchase, and ownership proof. |
| Venice | Private AI | `documented` | None | Planned | Future paid inference route; requires cost/privacy evidence and output receipt. |
| Balancer | Advanced Swap | `documented` | None | Backlog | No Miorail Route adapter. |
| Hydrex | Advanced Swap | `documented` | None | Backlog | No Miorail Route adapter. |
| Printr | Unassigned | `documented` | None | Documentation-only | Must not appear as an available capability. |
| GMGN | Unassigned | `documented` | None | Documentation-only | Must not appear as an available capability. |
| Brickken | Unassigned | `documented` | None | Documentation-only | Must not appear as an available capability. |
| Flaunch | Unassigned | `documented` | None | Documentation-only | Must not appear as an available capability. |
| Clawnch | Unassigned | `documented` | None | Documentation-only | Must not appear as an available capability. |
| Virtuals | Unassigned | `documented` | None | Frozen legacy reference | A legacy read-only namespace does not constitute Route capability. |
| Bankr | Unassigned | `documented` | None | Frozen legacy reference | A legacy read-only namespace does not constitute Route capability. |

## Commerce Route Proof (T64)

Commerce is the first family where a settled transaction is **not** a proof. A
`CommerceRouteProofV1` carries three independent legs and only one terminal
state means success:

```text
payment settled  ∧  provider order confirmed  ∧  digital good delivered  →  delivered
```

| Final status | Meaning | Is it a purchase? |
|---|---|---|
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
|---|---|---|---|
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
|---|---|
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
3. Never prepare calls for a capability below `adapter`.
4. Never recommend a capability below `scored`.
5. Never claim completed execution support below `proven`.
6. Feature flags, migrations, provider configuration, and startup preflights may still block a `proven` capability in production.
7. When registry and runtime disagree, fail closed and open a scoped registry/runtime reconciliation task.

## Planned route-family order

1. Alchemy Base simulation adapter for paid intelligence — delivered (T63B);
2. Commerce — Bitrefill — adapter and scoring delivered (T64); promotion to
   `proven` blocked on the gate above;
3. NFT — OpenSea;
4. Private AI — Venice;
5. Advanced Swap — o1.exchange and Aerodrome;
6. Yield Expansion — YO.

Adding a new Markdown plugin file is not a roadmap item. Implementing and promoting a route family is.
