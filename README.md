# Miorail

> formerly MioAgent

**One intent. Multiple routes. One verified plan.**

Miorail is an intent and route-optimization layer for Base.

A user describes the outcome they want in ordinary language. Miorail converts that request into a typed intent, evaluates several approved ways to complete it, normalizes the results, explains the trade-offs, prepares one reviewable transaction plan, validates the calls, and asks the user to approve the final action through Base Account.

After execution, Miorail compares the expected and actual result and stores a durable **Route Proof**.

The existing logo remains unchanged.

> Current stage: architecture transition from the legacy Miorail terminal to the route-first product  
> Network focus: Base  
> Execution model: non-custodial, user-approved transactions  
> Primary product object: Miorail Route Card  
> Demo: `https://98.86.240.34.sslip.io`

The complete product direction is documented in [`docs/MIORAIL_VISION.md`](docs/MIORAIL_VISION.md).

---

## Product promise

A Base user should not need to know which aggregator, protocol plugin, MCP tool, approval pattern, or contract call can complete a task.

They should be able to say:

```text
Swap 100 USDC to ETH with the best net result.
```

```text
Find a low-risk place to earn yield on 500 USDC.
```

```text
Use MEV protection even if the route returns slightly less.
```

```text
Send 50 USDC to alice.base.eth.
```

Miorail turns the request into an **Execution Blueprint**:

```text
Goal
  → supported route candidates
  → normalized comparison
  → recommended route
  → transaction calls
  → safety validation
  → Base Account approval
  → Route Proof
```

---

## Why Miorail exists

Base MCP gives an AI assistant access to wallet and execution capabilities. A general AI host can call tools, list plugins, prepare transactions, and ask the user to approve them.

That is useful infrastructure, but it is not the complete Miorail product.

Miorail owns the layer between the user's goal and the final wallet request:

- request several approved routes instead of calling the first matching tool;
- normalize incompatible provider outputs into one comparison model;
- score routes according to the user's real objective;
- explain why one route is preferred;
- compose multi-step actions into one transaction plan;
- validate the relationship between the intent and the calldata;
- compare the expected result with the actual onchain result;
- build a persistent history of route quality and execution evidence.

A direct flow such as:

```text
User message → Base MCP tool
```

is explicitly not the target architecture.

The Miorail flow is:

```text
User intent
  → multi-route evaluation
  → normalized scoring
  → Route Card
  → Execution Blueprint
  → Safety Kernel
  → Base Account approval
  → Route Proof
```

---

## The core product object: Miorail Route Card

The main user-facing result is not a raw chat response and not a protocol directory.

It is a structured **Route Card**.

Example:

```text
Swap 100 USDC → ETH

Recommended route: KyberSwap
Expected output: 0.03142 ETH
Minimum output: 0.03110 ETH
Estimated network cost: $0.02
Price impact: 0.08%
Approvals: 1
Route complexity: 2 calls

Path Score
• Net result: 94/100
• Safety: 84/100
• Liquidity: 96/100
• Simplicity: 78/100
• MEV protection: 62/100

Alternatives
• Uniswap: 0.03135 ETH, simpler route
• o1.exchange: 0.03131 ETH, MEV-protected

Why this route
KyberSwap currently provides the highest expected net output after
estimated costs. Choose o1.exchange instead when MEV protection matters
more than the output difference.

[Review transaction]
```

A Route Card must show understandable outcomes rather than raw APIs or tool names.

---

## Miorail Path Score

Miorail does not claim that one protocol is universally best.

It ranks a route relative to the user's goal and selected optimization mode.

Possible dimensions include:

- net result;
- safety;
- liquidity;
- route simplicity;
- gas cost;
- slippage and price impact;
- exit flexibility;
- MEV protection;
- quote freshness;
- provider reliability.

Possible user modes include:

```text
Best net result
Lowest risk
Lowest fees
Simplest route
Fastest execution
MEV protected
```

The score must be deterministic, inspectable, versioned, and based on normalized data. The LLM may explain the score, but it must not invent the score.

---

## Route Proof

After a transaction settles, Miorail records the difference between the plan and the result.

Example:

```text
Expected output: 0.03142 ETH
Actual output: 0.03139 ETH
Deviation: -0.10%
Estimated network cost: $0.020
Actual network cost: $0.018
Status: completed
```

A Route Proof should preserve:

- the original typed intent;
- all compared route candidates;
- the scoring version and recommendation reason;
- the selected route;
- quote and expiration data;
- the exact calls approved by the user;
- simulation evidence where available;
- transaction hashes and receipts;
- expected and actual asset changes;
- partial-failure or reconciliation state.

This gives Miorail its own persistent execution data instead of behaving like a temporary chat session.

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
│ approved route sources   │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Engine             │
│ normalize + score        │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Card               │
│ options + explanation    │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Transaction Composer     │
│ Execution Blueprint      │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Safety Kernel            │
│ decode, verify, simulate │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Base Account approval    │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Proof              │
│ expected vs actual       │
└──────────────────────────┘
```

### Intent Engine

Converts English and Russian requests into typed goals. It resolves assets, amounts, recipients, Basenames, optimization preferences, and missing constraints. It must fail safely when a financial request is ambiguous.

### Curated Skill Registry

Contains only explicitly integrated, typed, and tested capabilities.

A skill may wrap:

- a Base MCP capability;
- a protocol adapter;
- an aggregator;
- a transaction builder;
- a free data source;
- an approved paid API;
- an approved x402-enabled service.

Unknown services are not dynamically added during a normal user request.

### Route Engine

Requests several compatible candidates, normalizes their outputs, computes Path Scores, applies user preferences, and produces a recommendation with meaningful alternatives.

### Transaction Composer

Turns the selected route into a reviewable Execution Blueprint containing approvals, permits, swaps, transfers, deposits, withdrawals, purchases, and compatible EIP-5792 batches.

The server produces unsigned requests and never stores the user's private key.

### Safety Kernel

Automatically validates:

- chain and asset consistency;
- wallet and tenant binding;
- recipients and spenders;
- calldata and amounts;
- intent-to-calldata semantics;
- approvals;
- slippage and deadlines;
- quote freshness;
- destination contracts;
- transaction simulation where available;
- idempotency and durable receipts.

### Route Proof Engine

Reconciles expected and actual results after execution and stores durable evidence for history, reliability analysis, and future routing improvements.

### Optional Payment Adapter

x402 is not a product surface or discovery layer. It is an optional internal payment rail used by a known, approved skill when paid data, compute, inference, or commerce materially improves the requested result.

---

## The role of Base MCP

Base MCP is an important wallet and execution rail, but not the brain or product identity of Miorail.

Miorail may use it for:

- Base Account integration;
- wallet-aware reads;
- supported protocol and aggregator tools;
- transaction preparation;
- EIP-5792 call execution;
- signing and approval flows.

Miorail adds the parts that a generic MCP connection does not guarantee as a persistent product:

- multi-provider route evaluation;
- normalized comparison schemas;
- deterministic Path Scores;
- user-specific optimization modes;
- Route Cards;
- multi-step Execution Blueprints;
- intent-to-calldata validation;
- Route Proof and execution history.

---

## Initial MVP journeys

The rebuild focuses on complete journeys rather than broad protocol coverage.

### Swap Route Card

- query multiple approved swap routes;
- normalize output, minimum output, gas, slippage, price impact, calls, and trust metadata;
- compute Path Scores;
- show a recommendation and alternatives;
- prepare the complete unsigned transaction;
- reconcile expected and actual output.

### Earn Route Card

- query approved lending and vault integrations;
- normalize APY, liquidity, withdrawal mechanics, protocol risk, and transaction complexity;
- rank according to the user's risk and liquidity preference;
- prepare approval and deposit calls;
- preserve the selected route and receipt.

### Send Blueprint

- resolve the recipient and Basename;
- validate chain, asset, amount, and destination;
- prepare a transparent transfer;
- require Base Account approval;
- record the final proof.

---

## What Miorail is not

Miorail is not:

- a background scanner product;
- an alerts and recommendations feed;
- an Action Inbox clone;
- a provider or protocol directory;
- a policy-management dashboard;
- an x402 Bazaar browser;
- an unrestricted autonomous trading bot;
- a custodial wallet;
- a thin UI around Base MCP;
- a system that lets an LLM silently invent transaction routes.

---

## Migration from the legacy product

| Legacy component | New Miorail direction |
| --- | --- |
| Agent Stream | Intent workspace |
| Base MCP | Wallet and execution rail |
| Protocol skills | Curated route adapters |
| Action preparation | Execution Blueprints |
| Action cards | Miorail Route Cards |
| Security checks | Invisible Safety Kernel |
| Portfolio data | Context for intent and route scoring |
| Memory | Optimization preferences and constraints |
| Receipts and audit logs | Route Proof history |
| x402 gateway | Optional internal Payment Adapter |
| Spend Permissions | Deferred infrastructure |

Scanner schedules, scanner-driven recommendations, visible autonomy policies, provider toggle grids, and dashboard-first navigation are no longer primary product concepts.

---

## Rebuild stages

1. **Architecture freeze** — stop expanding Scanner, Action Inbox, and visible Policy surfaces.
2. **Legacy inventory** — identify reusable execution, receipt, safety, and provider components.
3. **Intent Engine** — typed schemas, English/Russian parsing, ambiguity handling, and user preference resolution.
4. **Route Candidate schema** — normalize quotes and opportunities across approved integrations.
5. **Path Score** — deterministic, versioned scoring per intent family.
6. **Route Cards** — comparison and recommendation UI.
7. **Transaction Composer** — Execution Blueprint and EIP-5792 preparation.
8. **Safety Kernel** — intent-to-calldata validation and simulation.
9. **Route Proof** — expected-versus-actual reconciliation and history.
10. **Production hardening** — provider reliability, retries, failure recovery, observability, and independent review.

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

Do not use it with funds you cannot afford to lose until route comparison, transaction preparation, simulation, Base Account approval, settlement reconciliation, and Route Proof have been production hardened and independently reviewed.

---

## License

TBD.
