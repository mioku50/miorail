# Miorail

> formerly MioAgent

**Say the goal. Miorail builds the route.**

Miorail is an intent-driven AI transaction operator for Base.

A user describes the result they want in ordinary language. Miorail understands the goal, selects from a curated set of trusted skills, compares supported execution routes, prepares a clear transaction plan, validates the calls, and asks the user to approve the final onchain action through Base Account.

The existing logo remains unchanged.

> Current stage: architecture transition from the legacy Miorail terminal to the new intent-first product  
> Network focus: Base  
> Execution model: non-custodial, user-approved transactions  
> External payments: optional and hidden behind approved skills  
> Demo: `https://98.86.240.34.sslip.io`

The complete product direction is documented in [`docs/MIORAIL_VISION.md`](docs/MIORAIL_VISION.md).

---

## Product promise

A Base user should not need to know which protocol, aggregator, MCP tool, API, or contract call can complete a task.

They should be able to say:

```text
Swap 100 USDC to ETH using the best supported route.
```

```text
Find a low-risk place to earn yield on 500 USDC.
```

```text
Check this token and prepare a 20 USDC purchase only if the transaction looks reasonable.
```

```text
Send 50 USDC to alice.base.eth.
```

Miorail turns the request into a typed intent, queries approved skills, compares the available options, and prepares the final action for review and approval.

---

## What makes Miorail different

Miorail is not a scanner dashboard, not a protocol directory, and not a thin chat wrapper around Base MCP.

Its value is the orchestration layer between a user request and an executable transaction:

```text
User intent
  → understand the goal and constraints
  → call curated protocol and aggregator skills
  → compare supported routes
  → explain trade-offs
  → compose one transaction plan
  → validate the calls
  → request Base Account approval
  → record the receipt
```

### Intent-first interaction

The product begins with the outcome the user wants, not with protocol tabs, scanner configuration, or provider toggles.

### Curated skills, not open discovery

Miorail only routes through capabilities that have been explicitly integrated, typed, tested, and assigned clear trust and execution rules.

There is no user-facing x402 marketplace and no runtime search across unknown services.

### Useful route comparison

When several approved routes can satisfy an intent, Miorail compares the results that matter to the user:

- expected output;
- network cost;
- slippage and price impact;
- liquidity;
- protocol and execution risk;
- route complexity;
- service cost when a skill uses a paid provider.

### User-controlled asset movement

Miorail prepares transactions. The user approves swaps, transfers, deposits, purchases, and other movements of wallet assets through Base Account.

### Invisible safety

Security remains mandatory, but it is implemented as an internal transaction Safety Kernel rather than a policy dashboard.

---

## Core architecture

```text
┌──────────────────────────┐
│ Natural-language request │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Intent Engine            │
│ typed goal + constraints │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Curated Skill Registry   │
│ approved capabilities    │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Engine             │
│ compare supported options│
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Transaction Composer     │
│ plan + EIP-5792 calls    │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Safety Kernel            │
│ decode, verify, simulate │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Base Account approval    │
└──────────────────────────┘
```

An optional Payment Adapter may be used inside an approved skill when paid data, inference, compute, or a digital service materially improves the requested result.

### Intent Engine

Converts English and Russian natural language into typed goals, resolves tokens, amounts, recipients, and preferences, and fails safely when a financial request is ambiguous.

### Curated Skill Registry

Contains approved skills for supported user goals. A skill may wrap:

- a Base MCP capability;
- a protocol adapter;
- an aggregator;
- a free data provider;
- an approved paid API;
- an approved x402-enabled service.

Every skill must define its inputs, outputs, network, trust assumptions, transaction behavior, costs, tests, and fallback behavior.

### Route Engine

Normalizes the output of compatible skills and compares routes according to the user goal. It may recommend one route, but it must explain the reason and show meaningful alternatives when they differ in trust, cost, or execution behavior.

### Transaction Composer

Builds reviewable approvals, permits, swaps, transfers, deposits, purchases, and EIP-5792 batches. The server produces unsigned requests and never stores the user's private key.

### Safety Kernel

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

### Payment Adapter

x402 is not a product surface or discovery layer. It is an optional internal payment rail that an approved skill may use for a known service.

The user should see the result and its cost, not facilitator details, payment headers, marketplace listings, or arbitrary API endpoints.

---

## The role of Base MCP

Base MCP is a wallet and execution rail, not the brain of Miorail.

Miorail may use it for:

- Base Account integration;
- wallet-aware reads;
- supported protocol and aggregator tools;
- transaction preparation;
- EIP-5792 call execution;
- signing and approval flows.

Miorail must add its own intent understanding, route comparison, transaction composition, explanations, and validation before invoking an execution tool.

A direct `user message → Base MCP tool` passthrough is not the target architecture.

---

## The role of x402

x402 remains supported, but it is deliberately de-emphasized.

It may be used when a curated skill requires a paid service such as:

- premium data;
- AI inference;
- transaction simulation;
- a digital product;
- a known commerce endpoint.

Miorail does not expose an x402 Bazaar browser, dynamically discover unknown services during normal user requests, or ask users to compare raw API providers.

For the first MVP, one-time payment confirmation is preferred. Base Spend Permissions and recurring service budgets remain optional future infrastructure and should not be part of the primary onboarding until repeated paid usage creates a clear user benefit.

---

## Initial MVP intent families

The rebuild focuses on a small number of complete journeys rather than broad protocol coverage.

### Swap

Compare approved swap routes, explain the recommendation, build the complete transaction, validate it, and request Base Account approval.

### Earn

Compare supported lending and vault opportunities using APY, liquidity, protocol, and risk context, then prepare approval and deposit calls.

### Send

Resolve an address or Basename, validate the asset, amount, chain, and recipient, then prepare a transparent transfer for approval.

### Token action

Combine trusted market and contract context with route preparation. Miorail may warn or refuse to prepare an action when required inputs are missing or the transaction cannot be validated.

### Curated paid service

A later flow may invoke a specifically integrated paid service. The user sees the exact result, price, and receipt; they do not browse a marketplace of machine endpoints.

---

## Migration from the legacy product

The previous architecture centered on scanners, recommendations, an Action Inbox, visible policies, and dashboard-style navigation.

Those concepts are no longer the main product direction.

### Removed as primary product concepts

- Scanner framework and schedules;
- scanner-driven recommendations;
- Action Inbox as the primary execution surface;
- visible autonomy policy management;
- read-only mode as a product identity;
- provider toggle grids as a primary UX;
- dashboard-first navigation;
- user-facing x402 service discovery;
- dynamic routing to unknown third-party services.

### Retained or transformed

| Legacy component | New Miorail direction |
| --- | --- |
| Agent Stream | Primary intent workspace |
| Base MCP | Wallet and execution rail |
| Protocol skills | Curated typed skill adapters |
| Action preparation | Transaction plans |
| Security checks | Invisible Safety Kernel |
| Portfolio data | Context for user intents |
| Memory | Preferences and routing constraints |
| x402 gateway | Optional internal Payment Adapter |
| Spend Permissions | Deferred service-budget infrastructure |
| Receipts and audit logs | Transaction and service history |

Legacy code may remain temporarily during the staged migration, but new work should follow this architecture.

---

## Rebuild stages

1. **Architecture freeze** — keep the Miorail brand and stop expanding the legacy scanner model.
2. **Legacy surface removal** — remove scanner navigation, recommendation-first UX, and visible policy configuration while preserving backend safety.
3. **Intent Engine** — typed schemas, English/Russian parsing, ambiguity handling, and tests from real user requests.
4. **Curated Skill Registry** — convert existing Base MCP tools and internal integrations into explicit typed skills.
5. **Route Engine** — normalize quotes and opportunities, rank supported options, and explain recommendations.
6. **Transaction Composer** — transaction-plan schema, EIP-5792 batches, Base Account approval, and receipt reconciliation.
7. **Intent workspace UI** — conversation, comparisons, transaction plans, and history as one coherent surface.
8. **Optional paid skills** — connect selected paid services through one-time payments and transparent receipts.
9. **Production hardening** — simulation, calldata validation, reliability controls, reconciliation, and failure testing.

Each implementation step should be delivered as a small coder task with explicit scope, non-goals, acceptance criteria, tests, and a clear commit message.

---

## Current repository status

The repository contains a working foundation, including:

- a web interface and API server;
- Postgres persistence;
- an OpenAI-compatible agent runtime;
- Base Account and Base MCP integrations;
- English and Russian intent-routing experiments;
- x402 seller and buyer infrastructure;
- Base Spend Permission support;
- transaction preparation and safety components;
- provider, portfolio, approvals, and receipt infrastructure.

These components are migration assets, not a requirement to preserve the old product shape.

The product name is **Miorail**. The repository name `mioagent` and package namespace `@mioagent/*` remain unchanged for compatibility.

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

Miorail is experimental software undergoing a major architecture transition.

Do not use it with funds you cannot afford to lose until transaction preparation, simulation, Base Account approval, paid-service settlement, and receipt reconciliation have been production hardened and independently reviewed.

---

## License

TBD.
