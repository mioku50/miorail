# Miorail

> **One intent. Multiple routes. One verified plan.**

Miorail is a self-hostable, non-custodial route-intelligence and execution-verification product for Base.

A user describes an outcome in ordinary language. Miorail turns it into a typed intent, evaluates curated routes, preserves evidence and provenance, prepares one reviewable execution plan, validates the exact calls, and leaves final approval to the user's Base Account. After execution, Miorail reconciles expected and actual results into a durable Route Proof.

The governing rule is simple:

> **No data — no score.** A measurement that did not happen is never rendered as zero, success, safety, or a recommendation.

- Network: Base mainnet (`8453`)
- Live web console: [miorail.xyz](https://miorail.xyz)
- Public read-only MCP: `https://miorail.xyz/mcp`
- Public product metrics: [miorail.xyz/metrics](https://miorail.xyz/metrics)
- Product direction: [MIORAIL_VISION.md](docs/MIORAIL_VISION.md)
- Capability truth: [PLUGIN_REGISTRY.md](docs/PLUGIN_REGISTRY.md)
- Production acceptance: [PRODUCTION_UI_VERIFICATION.md](docs/PRODUCTION_UI_VERIFICATION.md)

## Product loop

```text
Natural-language request
  → Intent Engine
  → curated route candidates
  → evidence and provenance
  → deterministic comparison
  → Route Card
  → Execution Blueprint
  → Safety Kernel and simulation
  → explicit Base Account approval
  → receipt reconciliation
  → Route Proof
```

Miorail is not a thin chat wrapper around Base MCP, a provider directory, or a first-matching-tool router. Base MCP is a wallet and capability rail; Miorail owns the comparison, evidence, transaction composition, validation, and proof layer.

Natural-language processing is role-routed as well: a fast Mistral lane handles
closed-schema classification and extraction, while Grok 4.5 handles evidence-
bound investigation and user-facing explanations. TypeScript/Zod contracts,
not either model, decide which reads and actions are allowed.

## Product surfaces

| Surface | Web path | What it owns |
| --- | --- | --- |
| **Discover** | `/opportunities` | B20 launch measurements, market rails, Fundamental Intelligence, global `Ask Miorail`, evidence gaps, and focused measurement views. |
| **B20** | `/portfolio` | Wallet B20 holdings, control snapshots, exit-first checks, watchlists, simulation review, and B20 entry reconciliation. |
| **Routes** | `/routes` | Intent, provider-neutral candidates, Route Cards, Blueprint review, Safety Kernel, Base Account approval, and Route Proof. |
| **Activity** | `/plan/history` | Route runs and proofs, Base MCP Action Receipts, and intelligence/x402 charge history. |
| **Base MCP Extensions** | `/extensions` | Live Base MCP reads, capability truth, deterministic Routes handoff, and released typed direct actions. |
| **Settings** | `/settings` | Intelligence Budget, payments, adapter health, providers, and network state. |
| **Public Metrics** | `/metrics` | Sessionless Base telemetry with exact definitions, caveats, and a deterministic snapshot hash. |

Web and Base App share the same typed product contracts so financial copy and capability state cannot silently diverge between clients.

## Capability truth

A Markdown plugin specification is documentation, not a connected capability. Every integration follows this lifecycle:

```text
documented → manifested → adapter → scored → proven
```

Feature flags and credentials may still block a capability. Enabling a flag never promotes a provider above its registry stage.

The current registry includes provider-neutral Swap and Earn routes, typed Base MCP actions, x402 paid intelligence, and documented/manifested extensions. Promotion to `proven` requires a real reconciled production path, not just working code.

The full provider constraints and promotion gates live in [PLUGIN_REGISTRY.md](docs/PLUGIN_REGISTRY.md).

# B20 Intelligence

B20 is an evidence layer around tokens created by the B20 factory and their Base liquidity. It is **not** a generic token screener and does not predict price or profit.

```text
Base B20 launch events
  → canonical b20_launches                 [miorail-b20-discover]
  → Exit-First measurements
  → b20_opportunity_observations           [miorail-b20-measure]
  → consumer Discover projection
  → market rails / Fundamental Intelligence / MCP / AI
```

The historical B20 corpus is backfilled from factory genesis while live launches remain prioritized for measurement. Index coverage and measurement coverage are deliberately separate concepts.

## Consumer Discover

Discover no longer exposes raw engineering states as the primary user verdict. The consumer projection distinguishes things Miorail measured about a token from things Miorail failed to measure itself.

Examples:

- **Both routes measured**
- **Bought, exit not priced**
- **No buyer activity**
- **Needs more evidence**

A `rejected` internal state is not a safety verdict. `aboutToken = false` findings describe a limit of Miorail's own measurement and are kept separate from token findings.

Measurements can preserve:

- supported entry and exit routes plus venue provenance;
- measured round-trip result against the explicit reference profile;
- tested exit-capacity lower bounds without interpolation;
- Uniswap v4 hook address and decoded permissions;
- completed launch-window buyer evidence;
- transfer-control evidence, freshness, missing data, and route coverage.

`provisional` does not mean `qualified`. Hook permissions do not prove hook behaviour. Launch-window buying does not prove buyer intent, current holdings, or future demand. A route miss covers Miorail's configured venues at one observation, not every venue forever.

## Market rails

The right rail is a measured view, not a token ranking.

- **Measured exit liquidity** orders fresh comparable observations by one measured exit-capacity dimension.
- **24h Route Cost Changes** compares compatible observations roughly one day apart. A dedicated remeasurement queue reserves worker capacity for tokens that need a second comparable observation instead of letting newest-first ingestion starve the history rail.
- Stale measurements are visibly marked as stale.

`View measurement` deep-links to the exact token on Discover:

```text
/opportunities?token=0x...&view=measurement
```

The focused view can load a token by address even when it is not present in the current 25-card feed page, and URL state survives refresh/back navigation.

# Fundamental Intelligence

Fundamental Intelligence is a second evidence axis beside market measurement.

It answers a different question:

> **Is this B20 verifiably connected to a real project, and what can Miorail actually establish about that project?**

It never attaches a project to a token by matching a name or symbol.

## Identity chain

```text
B20 token
  → verified project claim
  → domain controlled by the claimant
  → project-declared website / product / repository / docs
  → constrained probes
  → versioned fundamental evidence
```

A project claim can be anchored by supported verification methods such as a domain claim file, project publication, or a direct launch-sender relationship where that relationship can be established safely. If identity is not established, downstream website/product/repository evidence cannot be attached to the token.

The claim file convention is:

```text
/.well-known/miorail-b20.json
```

Project-declared URLs are treated as untrusted input: HTTPS-only rules, host restrictions, redirect limits, private-address rejection, body limits, and timeouts apply before a probe can become evidence.

## Fundamental dimensions

The current evidence model can represent:

- verified project identity;
- verified website;
- live product;
- verified Base presence;
- repository found;
- docs found;
- active public development;
- project existence before token launch.

The invariants are strict:

```text
unknown ≠ no
website exists ≠ product is live
repository exists ≠ development is active
symbol match ≠ project identity
fundamental evidence ≠ investment recommendation
```

There is no overall fundamental score.

A working product and weak market conditions can coexist in the same card. Miorail deliberately keeps those axes independent.

## Fundamental Explore

Global `Ask Miorail` supports positive, evidence-backed fundamental predicates such as:

```text
Which B20 launches are connected to verified projects?
Which B20 launches have a verified website?
Show B20 launches with a live product.
Which verified projects have public docs?
Which projects show active public development?
Which projects existed before their token launch?
```

Fundamental-only queries read the verified project/evidence corpus directly. They do **not** page the recent 48-hour market universe and do not render unrelated market statistics.

Negative predicates such as “show projects without a product” are intentionally refused because missing evidence is `unknown`, not proof of absence.

The answer denominator is the verified project-claim corpus, never the entire B20 universe. Launches without a verified claim remain outside that corpus and remain unknown.

### Current coverage boundary

Project claims are currently operator-registered. There is not yet a public self-serve submission flow, so Fundamental Intelligence coverage is intentionally much smaller than the full B20 index.

# Ask Miorail

The B20 console has three scopes:

- **Explore** — deterministic universe/fundamental queries;
- **Investigate** — one to five named tokens side by side;
- **Changes** — comparable stored observations over time.

The model is not a source of facts. Deterministic code builds an evidence bundle first; narration is allowed only over that bundle, and the verifier rejects unsupported numbers or claims.

Requests to act are handed to Routes for fresh quotes and explicit approval.

# Public Miorail MCP

Miorail MCP `1.1.0` exposes exactly six read-only tools over stored B20 evidence:

```text
miorail_discover_status
miorail_list_b20_opportunities
miorail_summarise_b20_universe
miorail_get_b20_opportunity
miorail_explain_b20_rejection
miorail_get_b20_market_leaders
```

The public MCP surface has no wallet, signing, payment, approval, or execution tool. Its Discover projection is parity-tested against the product truth layer.

# Base MCP Extensions

Miorail reads the live `mcp.base.org` registry and classifies tools as `READ`, `ACTION`, `ROUTABLE`, or blocked before an LLM can select them.

- `READ` tools may answer scoped Base questions.
- `ROUTABLE` swap/yield requests are handed to Routes; they cannot bypass provider comparison or Route Proof.
- An `ACTION` is released only through a typed input policy, wallet binding, safety checks, explicit approval, idempotency, persistence, and reconciliation.
- Unknown tools, arbitrary calls, and documentation-only plugins remain blocked. Dynamic discovery never grants execution.

Action Receipts are deliberately separate from Route Proofs.

# Paid intelligence and x402

x402 funds allowlisted evidence, simulation, inference, or compute. It does not fund portfolio asset movement.

Miorail also implements the seller side:

```text
external agent
  → x402 payment in Base USDC
  → stored B20 intelligence / published proof verification
  → versioned response + request hash + deterministic data hash
```

The free catalog is at `/api/x402/intelligence/v1/catalog`. Paid resources are bound to stored evidence; missing/invalid inputs are rejected before payment middleware, and no seller endpoint prepares wallet calls.

## x402 settlement vs Builder Code attribution

The seller and app-transaction paths are intentionally different.

In a facilitated x402 seller payment, the external payer signs an authorization and the facilitator may build/broadcast the settlement transaction. Receiving x402 revenue therefore does not by itself mean Miorail originated an onchain transaction carrying Miorail's ERC-8021 Builder Code.

For app-originated user execution, Miorail's wallet-action layer attaches the public Builder Code as an optional `dataSuffix` capability to `wallet_sendCalls` when the connected wallet reports support. Attribution never changes the server-approved calls and never blocks execution when the wallet lacks that capability.

# Execution boundary

- Miorail never stores a user private key, signs for the user, or broadcasts a raw transaction from the server.
- The server builds exact unsigned calls; the connected Base Account is the signer and submits approved calls client-side.
- The client never supplies route calldata, router, recipient, spender, deadline, or minimum output.
- Blueprint hashes bind intent, candidate, evidence, approved calls, wallet, chain, and expiry.
- Provider output is independently decoded and checked before wallet approval.
- Receipt success alone is insufficient. Route Proof reconciles expected and actual asset/position changes and gas.
- Native Base ETH swap legs are reconstructed only from canonical WETH9 evidence for the approved router target.
- RPC URLs, secrets, approval URLs, paid response bodies, and delivery secrets do not enter public evidence or rendered traces.

# Production acceptance

The shared swap Route Proof lifecycle has completed owner-verified production journeys in both directions:

```text
USDC → ETH → Route Proof reconciled
ETH  → USDC → Route Proof reconciled
```

Production acceptance also includes canonical Base MCP reads/actions and real x402 intelligence purchases. Provider-specific proof promotion remains stricter than “the shared path worked once”; the acceptance ledger keeps those claims separate.

See [PRODUCTION_UI_VERIFICATION.md](docs/PRODUCTION_UI_VERIFICATION.md) for the detailed rollout ledger.

# Repository map

This is a pnpm monorepo. The product name is Miorail; the repository name `mioagent` and the `@mioagent/*` package namespace remain for compatibility.

| Path | Responsibility |
| --- | --- |
| `artifacts/api-server` | Express API, authenticated product routes, public/private MCP, workers, and reconciliation orchestration. |
| `artifacts/interface` | Vite/React web console. |
| `artifacts/miniapp` | Next.js Base App. |
| `lib/route-domain`, `lib/route-storage` | Versioned contracts, stable hashes, additive persistence, and append-only proof history. |
| `lib/intent-engine`, `lib/route-engine`, `lib/route-card` | Typed intent, deterministic comparison, and Route Card projection. |
| `lib/swap-adapters`, `lib/earn-engine` | Provider-neutral swap adapters and Earn comparison. |
| `lib/security`, `lib/transaction-composer` | Safety Kernel and exact unsigned Blueprint construction. |
| `lib/route-proof`, `lib/proof-verifier` | Expected-versus-actual reconciliation and independent integrity verification. |
| `lib/opportunity-rail`, `lib/b20-control` | B20 measurement, controls, consumer projection, project claims, and Fundamental Intelligence. |
| `lib/mcp`, `lib/tools` | Base MCP transport, classification, and constrained execution. |
| `lib/x402-gateway`, `lib/paid-intelligence`, `lib/intelligence-budget` | Paid evidence, reservations, charging, and reconciliation. |
| `lib/wallet-actions` | Base Account approval/submission and ERC-8021 attribution handling. |
| `lib/ui`, `lib/api-zod`, `lib/api-client-react` | Shared web/Base App UI and runtime-validated contracts. |
| `contracts/legacy` | Historical custom Sepolia Spend Permission experiment; production uses the official Base Account Spend Permission flow. |

# Development

Requirements:

- Node.js 22.x;
- pnpm 11.x through Corepack;
- PostgreSQL.

```bash
pnpm install --frozen-lockfile
cp .env.example .env

pnpm exec tsx artifacts/api-server/index.ts
pnpm --filter @mioagent/interface dev
pnpm --filter @mioagent/miniapp dev
```

Primary checks:

```bash
pnpm test:unit
pnpm test:db
pnpm typecheck
pnpm --filter @mioagent/interface build
pnpm -r build
git diff --check
```

Dependencies use `minimumReleaseAge: 7d` in `pnpm-workspace.yaml`. Pin a mature version when pnpm cannot resolve one; do not relax the supply-chain policy. Never commit `.env` files, RPC URLs, private keys, approval URLs, OAuth tokens, or provider credentials.

## Deployment

Production deployment is managed by `ops/deploy.sh`, which builds the deployables, validates nginx/systemd configuration, publishes the exact served bundle, restarts services, and smoke-tests the Base App and public MCP.

The build injects only the public `BASE_BUILDER_CODE` into the client surfaces. It never needs a user signing key.

Production services include:

```text
miorail-api
miorail-miniapp
miorail-b20-discover
miorail-b20-measure
```

# Known gaps

Miorail is functional but not broadly production-hardened. Important open work includes:

- expand Fundamental Intelligence beyond the operator-registered claim corpus and design a safe self-serve project-claim flow;
- add more verified project/onchain/utility evidence without introducing an overall investment score;
- capture more provider-specific small-value Route Proofs and failure-path acceptance;
- complete owner-verified B20 entry/exit journeys and broader Earn acceptance;
- continue hardening x402 settlement/delivery reconciliation and RPC degradation paths;
- validate ERC-8021 attribution on real app-originated user executions rather than treating seller-side x402 settlement as app attribution;
- replace the default in-process session store before horizontal scaling;
- complete independent security, backup/restore, rollback, and failure-matrix review.

# Safety notice

Miorail is experimental software. Evidence, measurements, project verification, and Route Proofs are not investment recommendations or guarantees of safety, liquidity, execution, or future value.

Do not use Miorail with funds you cannot afford to lose.

# License

TBD.
