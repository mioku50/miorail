# Miorail

> formerly MioAgent

**One intent. Multiple routes. One verified plan.**

Miorail is the intent, route-intelligence, and execution-verification layer for Base.

A user describes the outcome they want in ordinary language. Miorail converts that request into a typed intent, evaluates several approved execution routes, gathers the data required to compare them honestly, normalizes the results, prepares one reviewable transaction plan, validates the calls, and asks the user to approve the final action through Base Account.

When free data is not sufficient, Miorail can purchase approved data, simulation, inference, or compute through **x402**. A bounded **Base Spend Permission** can fund those service calls without granting Miorail permission to move the user's portfolio assets.

After execution, Miorail compares the expected and actual result and stores a durable **Route Proof**.

The existing logo remains unchanged.

> Current stage: architecture transition from the legacy Miorail terminal to the route-intelligence product  
> Network focus: Base  
> Execution model: non-custodial, user-approved asset movement  
> Intelligence payments: approved x402 services funded one-time or through bounded Spend Permissions  
> Primary product object: Miorail Route Card  
> Demo: `https://98.86.240.34.sslip.io`

The complete product direction is documented in [`docs/MIORAIL_VISION.md`](docs/MIORAIL_VISION.md).

---

## Product promise

A Base user should not need to know which aggregator, protocol plugin, MCP tool, data provider, approval pattern, or contract call can complete a task.

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
Verify this route with deeper liquidity and contract data before I sign.
```

Miorail turns the request into an **Execution Blueprint**:

```text
Goal
  → approved route candidates
  → free and paid intelligence
  → normalized comparison
  → Path Score + confidence
  → Route Card
  → transaction calls
  → Safety Kernel
  → Base Account approval
  → Route Proof
```

---

## Why Miorail exists

Base MCP gives an AI assistant access to wallet and execution capabilities. A general AI host can call tools, list plugins, prepare transactions, make x402 payments, and ask the user to approve actions.

That is useful infrastructure, but it is not the complete Miorail product.

Miorail owns the layer between the user's goal and the final wallet request:

- request several approved routes instead of calling the first matching tool;
- normalize incompatible provider outputs into one comparison model;
- acquire the data required to compare routes honestly;
- use x402 to buy approved intelligence when free sources are insufficient;
- score routes according to the user's real objective;
- attach confidence, freshness, provenance, and cost to every score;
- compose multi-step actions into one transaction plan;
- validate the relationship between the intent and the calldata;
- compare the expected result with the actual onchain result;
- build a persistent history of route quality, provider reliability, and execution evidence.

A direct flow such as:

```text
User message → Base MCP tool
```

is explicitly not the target architecture.

The Miorail flow is:

```text
User intent
  → multi-route evaluation
  → data acquisition and provenance
  → deterministic scoring
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
Intelligence cost: $0.006
Price impact: 0.08%
Approvals: 1
Route complexity: 2 calls
Quote age: 8 seconds

Path Score
• Net result: 94/100 · High confidence
• Safety: 86/100 · High confidence
• Liquidity: 96/100 · High confidence
• Simplicity: 78/100 · High confidence
• MEV protection: 62/100 · Medium confidence

Evidence used
✓ 3 current swap quotes
✓ liquidity analysis
✓ contract checks
✓ transaction simulation

Paid enrichment
• liquidity analysis: $0.002
• simulation: $0.004

Alternatives
• Uniswap: 0.03135 ETH, simpler route
• o1.exchange: 0.03131 ETH, MEV-protected

Why this route
KyberSwap currently provides the highest expected net output after
estimated costs. Choose o1.exchange instead when MEV protection matters
more than the output difference.

[Review transaction]
```

A Route Card shows understandable outcomes, evidence, and costs rather than raw APIs or payment headers.

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

Every scored dimension must include:

- deterministic score logic;
- confidence level;
- source provenance;
- data freshness;
- scoring version;
- paid-service cost when applicable;
- missing-data state.

The governing rule is:

> **No data — no score.**

Miorail must show `Not scored` or `Insufficient data` instead of inventing a precise number. The LLM may explain the score, but it must never create the score itself.

Example normalized evidence:

```json
{
  "dimension": "liquidity",
  "score": 92,
  "confidence": 0.88,
  "freshnessSeconds": 12,
  "sources": ["provider-a", "provider-b"],
  "paidCostUsd": 0.003,
  "scoringVersion": "liquidity-v1"
}
```

---

## x402 as the paid intelligence rail

x402 is an important runtime layer of Miorail.

It is used to purchase known, approved services that materially improve route quality, such as:

- fresh market and liquidity data;
- contract and token risk enrichment;
- transaction simulation;
- route verification;
- premium inference or research;
- known commerce and digital-service endpoints.

Miorail does not expose an x402 Bazaar browser, dynamically trust arbitrary endpoints, or ask users to compare raw machine APIs.

Approved x402 services live inside the curated Skill Registry with:

- stable input and output schemas;
- explicit trust assumptions;
- exact or bounded pricing;
- timeout and retry behavior;
- fallback rules;
- reliability history;
- payment and service receipts.

The user pays for a defined result, not for the protocol name `x402`.

---

## Spend Permissions as the intelligence budget

Base Spend Permissions are a first-class infrastructure layer for repeated paid intelligence calls.

A user may create a bounded **Miorail Intelligence Budget**:

```text
Monthly limit: 3 USDC
Maximum per request: 0.02 USDC

Allowed
✓ route quotes
✓ liquidity data
✓ risk data
✓ simulation
✓ approved inference

Not allowed
✗ token transfers
✗ swaps
✗ deposits
✗ borrows
✗ arbitrary contract calls
```

The security boundary is explicit:

```text
Spend Permission
= pay for approved data, intelligence, and compute

Base Account approval
= authorize movement of user assets
```

A Spend Permission must be wallet-bound, category-bound, amount-bounded, auditable, revocable, and fail closed.

For a first-time or unusual paid request, Miorail may still ask for one-time confirmation. The bounded budget exists to remove repeated payment prompts from trusted recurring intelligence workflows.

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
Intelligence cost: $0.006
Status: completed
```

A Route Proof should preserve:

- the original typed intent;
- all compared route candidates;
- all free and paid evidence used;
- provider provenance and freshness;
- scoring version and confidence;
- recommendation reason;
- the selected route;
- quote and expiration data;
- the exact calls approved by the user;
- simulation evidence;
- x402 payment proofs and intelligence receipts;
- transaction hashes and onchain receipts;
- expected and actual asset changes;
- partial-failure or reconciliation state.

This gives Miorail its own persistent execution and intelligence data instead of behaving like a temporary chat session.

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
│ Intelligence Layer       │
│ free + approved x402     │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Engine             │
│ normalize + score        │
└─────────────┬────────────┘
              ↓
┌──────────────────────────┐
│ Route Card               │
│ evidence + alternatives  │
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

Spend Permission
  → bounded Intelligence Budget
  → approved x402 calls only
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

### Intelligence Layer

Coordinates free and paid evidence required by the Route Engine. It records provenance, freshness, confidence, price, payment proof, and provider reliability.

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

Reconciles expected and actual results after execution and stores durable evidence for history, provider reliability, and future routing improvements.

---

## The role of Base MCP

Base MCP is an important wallet, capability, payment, and execution rail, but not the brain or product identity of Miorail.

Miorail may use it for:

- Base Account integration;
- wallet-aware reads;
- supported protocol and aggregator tools;
- x402-compatible payments;
- transaction preparation;
- EIP-5792 call execution;
- signing and approval flows.

Miorail adds the persistent product layer:

- multi-provider route evaluation;
- data acquisition and provenance;
- normalized comparison schemas;
- deterministic Path Scores and confidence;
- Miorail Intelligence Budget;
- Route Cards;
- multi-step Execution Blueprints;
- intent-to-calldata validation;
- Route Proof and execution history.

---

## Initial MVP journeys

### Swap Route Card

- query multiple approved swap routes;
- obtain current quotes, gas estimates, liquidity, and safety evidence;
- use approved x402 enrichment when free data is insufficient;
- normalize output, minimum output, gas, slippage, price impact, calls, and trust metadata;
- compute confidence-aware Path Scores;
- show a recommendation and alternatives;
- prepare the complete unsigned transaction;
- reconcile expected and actual output.

### Earn Route Card

- query approved lending and vault integrations;
- normalize APY, liquidity, withdrawal mechanics, protocol risk, and transaction complexity;
- acquire additional paid intelligence when required for a defensible comparison;
- rank according to the user's risk and liquidity preference;
- prepare approval and deposit calls;
- preserve the selected route and receipt.

### Intelligence Budget

- create or connect a bounded Spend Permission;
- restrict it to approved data and compute categories;
- enforce monthly and per-call limits;
- show every charge and remaining budget;
- support revocation and fail-closed behavior;
- keep portfolio asset movement outside the permission.

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
- a system that lets an LLM invent transaction routes or scores.

---

## Migration from the legacy product

| Legacy component | New Miorail direction |
| --- | --- |
| Agent Stream | Intent workspace |
| Base MCP | Wallet, capability, payment, and execution rail |
| Protocol skills | Curated route adapters |
| Data providers | Intelligence Layer with provenance |
| Action preparation | Execution Blueprints |
| Action cards | Miorail Route Cards |
| Security checks | Invisible Safety Kernel |
| Portfolio data | Context for intent and route scoring |
| Memory | Optimization preferences and constraints |
| x402 gateway | Paid intelligence rail |
| Spend Permissions | Bounded Miorail Intelligence Budget |
| Receipts and audit logs | Route Proof and intelligence history |

Scanner schedules, scanner-driven recommendations, visible autonomy policies, provider toggle grids, and dashboard-first navigation are no longer primary product concepts.

---

## Rebuild stages

1. **Architecture freeze** — stop expanding Scanner, Action Inbox, and visible Policy surfaces.
2. **Legacy inventory** — identify reusable execution, receipt, x402, Spend Permission, safety, and provider components.
3. **Intent Engine** — typed schemas, English/Russian parsing, ambiguity handling, and user preference resolution.
4. **Route Candidate schema** — normalize quotes and opportunities across approved integrations.
5. **Intelligence Layer** — provenance, freshness, confidence, free/paid evidence, and provider reliability.
6. **x402 intelligence rail** — connect approved paid data, simulation, and compute services.
7. **Spend Permission budget** — bounded categories, per-call limits, monthly caps, revocation, and ledger.
8. **Path Score** — deterministic, versioned, confidence-aware scoring per intent family.
9. **Route Cards** — comparison, evidence, cost, and recommendation UI.
10. **Transaction Composer** — Execution Blueprint and EIP-5792 preparation.
11. **Safety Kernel** — intent-to-calldata validation and simulation.
12. **Route Proof** — expected-versus-actual reconciliation, payment proofs, and history.
13. **Production hardening** — provider reliability, retries, failure recovery, observability, and independent review.

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
- provider, portfolio, approvals, ledger, and receipt infrastructure.

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

Do not use it with funds you cannot afford to lose until route scoring, data provenance, x402 settlement, Spend Permission limits, transaction preparation, simulation, Base Account approval, and Route Proof reconciliation have been production hardened and independently reviewed.

---

## License

TBD.
