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
| Bitrefill | Commerce | `documented` | None | Planned | Future Commerce Route family. Documentation alone is not purchase support. |
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

1. Alchemy Base simulation adapter for paid intelligence;
2. Commerce — Bitrefill;
3. NFT — OpenSea;
4. Private AI — Venice;
5. Advanced Swap — o1.exchange and Aerodrome;
6. Yield Expansion — YO.

Adding a new Markdown plugin file is not a roadmap item. Implementing and promoting a route family is.
