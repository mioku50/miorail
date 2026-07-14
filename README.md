# MioIntent

> formerly Miorail / MioAgent

**Intent in. Best route out.**

MioIntent is an intent-driven AI transaction operator for Base.

A user describes the result they want in ordinary language. MioIntent understands the goal, discovers suitable free and paid services, compares routes, prepares a clear transaction plan, validates the calls, and asks the user to approve the final onchain action through Base Account.

The existing logo remains unchanged.

> Current stage: architecture transition from Miorail to MioIntent  
> Network focus: Base  
> Execution model: non-custodial, user-approved transactions  
> Service payments: free sources first, x402 when paid data or compute adds value  
> Demo: `https://98.86.240.34.sslip.io`

The complete product direction is documented in [`docs/MIOINTENT_VISION.md`](docs/MIOINTENT_VISION.md).

---

## Product promise

A Base user should not need to know which protocol, aggregator, API, MCP tool, or x402 resource can complete a task.

They should be able to say:

```text
Swap 100 USDC to ETH using the best net route.
```

```text
Find a low-risk place to earn yield on 500 USDC.
```

```text
Check this token and prepare a 20 USDC purchase only if the contract looks safe.
```

```text
Buy a 25 USD Steam gift card with USDC.
```

MioIntent turns the request into a typed intent, finds available capabilities, compares the options, and prepares the final action for review and approval.

---

## What makes MioIntent different

MioIntent is not a scanner dashboard and not a thin wrapper around Base MCP.

Its value is the orchestration layer between a user request and an executable transaction:

```text
User intent
  → understand the goal
  → discover free and paid capabilities
  → compare routes and services
  → explain trade-offs
  → compose the transaction plan
  → validate the calls
  → request Base Account approval
  → record the receipt
```

### Intent-first interaction

The product begins with the outcome the user wants, not with protocol tabs or tool configuration.

### Open capability routing

MioIntent can route across:

- Base MCP native capabilities;
- internal protocol and aggregator skills;
- free data providers;
- x402 Bazaar resources;
- direct x402 services;
- user-configured providers.

### Transparent service economics

The user does not pay for “x402.” They pay for a clearly defined result such as premium data, inference, simulation, research, or a digital service.

Free sources are preferred when they are sufficient. Paid services must show their value and price before use unless they are already covered by an explicit user-created service budget.

### User-controlled asset movement

MioIntent prepares transactions. The user approves swaps, transfers, deposits, purchases, and other asset movements through Base Account.

### Invisible safety

Security remains mandatory, but it is implemented as an internal transaction safety kernel rather than a policy dashboard.

---

## Core architecture

```text
┌─────────────────────────┐
│ Natural-language intent │
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Mio Intent              │
│ typed goal + constraints│
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Mio Discover            │
│ tools, skills, x402, API│
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Mio Route               │
│ compare price and result│
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Mio Compose             │
│ transaction plan + batch│
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Invisible Safety Kernel │
│ decode, verify, simulate│
└────────────┬────────────┘
             ↓
┌─────────────────────────┐
│ Base Account approval   │
└─────────────────────────┘

Mio Pay operates across discovery and routing for paid data, inference,
x402 tools, digital services, payment proofs, and user-visible receipts.
```

### Mio Intent

Converts English and Russian natural language into typed goals, resolves tokens and amounts, preserves user constraints, and fails safely when a financial request is ambiguous.

### Mio Discover

Finds capabilities from Base MCP, internal skills, protocols, free providers, and x402 services. Every candidate should expose structured inputs, outputs, price, network, freshness, and trust metadata.

### Mio Route

Compares candidates using factors such as expected output, gas, slippage, liquidity, protocol risk, MEV protection, service cost, and user preferences.

MioIntent may recommend an option, but it should not silently choose an unknown third-party provider when meaningful alternatives exist.

### Mio Compose

Builds reviewable approvals, permits, swaps, deposits, purchases, and EIP-5792 batches. The server produces unsigned requests and never stores the user's private key.

### Mio Pay

Handles:

- free services;
- one-time x402 payments;
- paid service discovery;
- outgoing buyer payments;
- payment proofs;
- service receipts;
- an optional Agent Service Budget.

### Invisible Safety Kernel

Automatically validates:

- chain and asset consistency;
- recipients and spenders;
- calldata and amounts;
- approvals;
- slippage and deadlines;
- quote freshness;
- destination contracts;
- transaction simulation where available;
- wallet and tenant isolation;
- idempotency and durable receipts.

---

## x402 and Agent Service Budget

x402 allows MioIntent to buy access to paid APIs, compute, inference, tools, research, and digital services without requiring the user to manage an account and API key for every provider.

Base Spend Permissions may be used for a narrow **Agent Service Budget**.

```text
Spend Permission
= pay for information, compute, and services within a small limit

Base Account confirmation
= approve movement of portfolio assets
```

The service budget may cover:

- premium security data;
- AI inference;
- transaction simulation;
- paid market or portfolio data;
- x402 MCP tools;
- research;
- explicitly allowed digital services.

It must not be presented as unrestricted permission to move the user's portfolio.

---

## Initial MVP intent families

The rebuild focuses on complete journeys rather than broad feature parity.

### Swap

Compare supported swap routes, explain the recommendation, build the complete transaction, and request Base Account approval.

### Earn

Compare supported lending and vault opportunities using APY, liquidity, protocol, and risk context, then prepare approval and deposit calls.

### Buy a service

Discover a commerce or x402 service, show the total cost, execute the payment flow, and return a durable receipt or delivery result.

### Research

Use free sources first, offer paid enrichment when useful, combine the result into a structured report, and prepare an onchain action only after explicit user intent.

---

## Migration from Miorail

The previous product centered on scanners, recommendations, an Action Inbox, visible policies, and dashboard-style navigation.

MioIntent changes that model.

### Removed as primary product concepts

- Scanner framework and schedules;
- scanner-driven recommendations;
- Action Inbox as the main execution surface;
- visible autonomy policy management;
- read-only mode as a product identity;
- provider toggle grids as a primary UX;
- dashboard-first navigation.

### Retained or transformed

| Legacy component | MioIntent direction |
| --- | --- |
| Agent Stream | Primary intent workspace |
| Base MCP | Execution and capability rail |
| x402 gateway | Mio Pay and paid service access |
| Spend Permissions | Optional Agent Service Budget |
| Action preparation | Mio Compose transaction plans |
| Security checks | Invisible Safety Kernel |
| Portfolio data | Context for intents |
| Memory | Preferences and routing constraints |
| Receipts and audit logs | Transaction and service history |
| Protocol skills | Typed capability adapters |

Legacy code can remain temporarily during the staged migration, but new work should follow the MioIntent architecture.

---

## Rebuild stages

1. **Brand and architecture freeze** — adopt MioIntent and stop expanding the legacy scanner model.
2. **Legacy surface removal** — remove scanner navigation, recommendation-first UX, and visible policy configuration while preserving backend safety.
3. **Mio Intent** — typed schemas, English/Russian parsing, ambiguity handling, and tests from real user requests.
4. **Mio Discover** — capability registry, typed skills, free/paid metadata, and x402 discovery.
5. **Mio Route** — normalized quotes, ranking, routing preferences, and recommendation explanations.
6. **Mio Compose** — transaction-plan schema, EIP-5792 batches, Base Account approval, and receipt reconciliation.
7. **Mio Pay** — real paid product actions, one-time x402 flows, service budgets, and transparent receipts.
8. **Intent workspace UI** — conversation, comparisons, transaction plans, costs, and history as one coherent surface.
9. **Production hardening** — simulation, calldata validation, reliability scoring, reconciliation, and failure testing.

Each implementation step should be delivered as a small coder task with explicit scope, non-goals, acceptance criteria, tests, and a clear commit message.

---

## Current repository status

The repository contains a working Miorail-era foundation, including:

- a web interface and API server;
- Postgres persistence;
- an OpenAI-compatible agent runtime;
- Base Account and Base MCP integrations;
- English and Russian intent routing experiments;
- x402 seller and buyer infrastructure;
- Base Spend Permission support;
- transaction preparation and safety components;
- provider, portfolio, approvals, and receipt infrastructure.

These components are migration assets, not a requirement to preserve the old product shape.

The product name is now **MioIntent**. The existing repository name `mioagent` and package namespace `@mioagent/*` remain temporarily unchanged to avoid breaking imports, CI, deployment configuration, and external links. Their migration should happen as a dedicated technical task.

---

## Development

Requirements:

- Node.js 20+
- pnpm
- PostgreSQL

Install dependencies:

```bash
pnpm install
```

Run the workspace in development mode:

```bash
pnpm dev
```

Run checks:

```bash
pnpm check
pnpm test
pnpm build
```

Environment configuration starts from:

```bash
cp .env.example .env
```

Do not place private keys, CDP secrets, provider keys, or production credentials in source control.

---

## Safety notice

MioIntent is experimental software undergoing a major architecture transition.

Do not use it with funds you cannot afford to lose until transaction preparation, simulation, Base Account approval, paid-service settlement, and receipt reconciliation have been production hardened and independently reviewed.

---

## License

TBD.
