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
| o1.exchange | Advanced Swap | `documented` | None | Planned | Do not claim route comparison or execution support yet. |
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

## Bitrefill promotion gate (`scored` → `proven`)

Still outstanding, in order:

1. durable, tenant-scoped persistence for the order and its proof (today the
   order book is process-local, and a restart honestly reports `unknown_order`);
2. a controlled live smoke that opens ONE real checkout, pays it from a user
   wallet, and reconciles a `delivered` proof end to end;
3. an operator runbook for `order_unconfirmed` — the state where money moved
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
