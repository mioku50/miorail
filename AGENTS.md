# Miorail — Autonomous Build Instructions

Miorail is a self-hostable, non-custodial intent, route-intelligence, and execution-verification product for Base.

## Canonical documents

Read these in order before planning work:

1. `docs/MIORAIL_VISION.md`
2. `docs/MIGRATION_PLAN.md`
3. `docs/ROADMAP.md`
4. `docs/PLUGIN_REGISTRY.md`
5. `docs/DECISIONS.md`
6. `.agents/skills`

Older backlog or technical-plan documents are historical context only when they conflict with the canonical documents above.

## Product architecture

```text
User intent
  → curated route candidates
  → evidence and provenance
  → deterministic scoring
  → Route Card
  → Execution Blueprint
  → Safety Kernel
  → Base Account approval
  → Route Proof
```

Do not reintroduce Scanner, Action Inbox, generic provider toggles, or first-matching-tool routing as the primary product.

## Capability truth

A plugin Markdown file is documentation, not a connected capability.

Every capability follows this lifecycle:

```text
documented → manifested → adapter → scored → proven
```

`docs/PLUGIN_REGISTRY.md` is the user-facing capability source of truth. Never claim a plugin can quote, rank, prepare, execute, or prove a result above its recorded stage.

Do not vendor a plugin `.md` merely to make the agent aware of it. Add a route-family task and typed implementation first.

## Core rules

- Build route families vertically, not as long horizontal infrastructure phases.
- Use curated, pinned, allowlisted providers only.
- Do not use dynamic runtime discovery or trust unknown endpoints.
- Preserve evidence freshness, provenance, dependency, request hashes, response hashes, and paid cost.
- Enforce `No data — no score`.
- The LLM may explain deterministic results but must not invent scores, routes, providers, or supported capabilities.
- The client never supplies transaction calldata.
- The server never holds user private keys, signs, or broadcasts.
- Asset movement uses exact server-built calls and explicit Base Account approval through client-side `wallet_sendCalls`.
- x402 pays only approved intelligence services.
- Spend Permissions fund bounded intelligence categories only; they never authorize swap, transfer, deposit, borrow, withdrawal, purchase, or arbitrary calls.
- Safety Kernel validation is mandatory before wallet approval.
- Route Proof must reconcile actual onchain outcomes; receipt success alone is insufficient.
- Never commit secrets, `.env` files, backup env files, private keys, OAuth tokens, API keys, or RPC URLs.

## Legacy boundaries

Cockpit, Scanner, Action Inbox, Agent Stream, Fuel, and visible autonomy-policy surfaces remain compatibility-only while migration is in progress.

- Do not add new product features to them.
- Do not delete wallet binding, calldata validation, reservations, receipts, audit history, or fail-closed guards with legacy UI.
- Transform reusable invariants into Route Engine, Safety Kernel, Intelligence Budget, and Route Proof components.

## Workflow

- Work in small, focused tasks aligned with `docs/ROADMAP.md`.
- Keep feature flags off by default until explicit production gates pass.
- Use additive migrations.
- Run package tests, workspace typecheck, relevant builds, and `git diff --check` before committing.
- Report pre-existing failures separately from task regressions.
- Commit directly to local `main` only when explicitly requested by the user; otherwise use a focused branch/PR.
- Never perform mainnet payments or transaction smoke tests without explicit user approval.

## When to stop and ask

Stop when work requires:

- a real secret or external paid provider;
- enabling a mainnet feature flag;
- changing pinned contracts;
- sending a real transaction or x402 payment;
- deleting major legacy systems before their replacement gates pass;
- a new route-family architecture decision not covered by the canonical documents.
