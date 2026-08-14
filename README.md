# Miorail

> **One intent. Multiple routes. One verified plan.**

Miorail is a self-hostable, non-custodial intent, route-intelligence, and
execution-verification product for Base.

A user describes an outcome in ordinary language. Miorail turns it into a
typed intent, evaluates curated routes, preserves evidence and provenance,
computes only the scores the evidence supports, prepares one reviewable plan,
validates its exact calls, and leaves final approval to the user's Base
Account. After execution, Miorail reconciles expected and actual results into a
durable Route Proof.

The governing rule is simple:

> **No data — no score.** A measurement that did not happen is never rendered
> as zero, success, safety, or a recommendation.

- Network: Base mainnet (`8453`)
- Live web console: [miorail.xyz](https://miorail.xyz)
- Base App: [ritual-familiars-94-141-161-182.sslip.io](https://ritual-familiars-94-141-161-182.sslip.io)
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
  → deterministic Path Score
  → Route Card
  → Execution Blueprint
  → Safety Kernel and simulation
  → explicit Base Account approval
  → receipt reconciliation
  → Route Proof
```

Miorail is not a thin chat wrapper around Base MCP, a provider directory, or a
first-matching-tool router. Base MCP is a wallet and capability rail; Miorail
owns the comparison, evidence, transaction composition, validation, and proof.

## Product surfaces

Web and Base App render the same shared section contracts so financial copy and
capability state cannot silently diverge between clients.

| Surface | Web path | What it owns |
| --- | --- | --- |
| **Discover** | `/opportunities` | B20 launch measurements, market rails, evidence gaps, and the per-card `Ask Miorail` evidence lens. |
| **B20** | `/portfolio` | Wallet B20 holdings, control snapshots, exit-first checks, simulation review, and B20 entry reconciliation. |
| **Routes** | `/routes` | Intent, provider-neutral candidates, Route Cards, Blueprint review, Safety Kernel, Base Account approval, and Route Proof. |
| **Activity** | `/plan/history` | Route runs and proofs, Base MCP Action Receipts, and intelligence/x402 charge history. |
| **Base MCP Extensions** | `/extensions` | Live Base MCP reads, capability truth, deterministic Routes handoff, and released typed direct actions. |
| **Settings** | `/settings` | Intelligence Budget, payments, adapter health, providers, and network state. |
| **Public Metrics** | `/metrics` | Sessionless Base telemetry with exact definitions, privacy suppression, caveats, and a deterministic snapshot hash. |

## Capability truth

A Markdown plugin specification is documentation, not a connected capability.
Every integration follows this lifecycle:

```text
documented → manifested → adapter → scored → proven
```

Feature flags and credentials may still block a `proven` capability. Conversely,
enabling a flag never promotes a provider above its registry stage.

| Capability | Current stage | Honest product claim |
| --- | --- | --- |
| Uniswap, KyberSwap | `proven` Swap | Provider-neutral quote, scoring, Blueprint, Safety Kernel, user-approved submission, and Route Proof exist. Provider-specific production evidence still needs to be captured in the acceptance ledger. |
| Moonwell, Morpho | `proven` Earn, production-gated | Earn comparison and proof paths exist; pinned-contract preflight and owner production journeys remain rollout gates. |
| Balancer, Hydrex, o1.exchange | `scored` Advanced Swap | They can participate in deterministic comparison and build constrained calls behind separate execution gates. Each still needs its own real reconciled Route Proof before promotion to `proven`. |
| YO | `scored` Earn | Pinned yoUSD reads and exact Gateway deposit preparation exist. APY and instant withdrawal liquidity remain `Not scored`; redemption is asynchronous. |
| Aerodrome | `manifested` Advanced Swap | Known and constrained, but not a released Routes execution provider. |
| Bitrefill | `scored` Commerce | Typed catalogue, checkout contracts, and three-leg proof logic exist. A real paid-and-delivered order has not been reconciled, so it is not a supported purchase claim. |
| OpenSea, Venice | `documented` | Planned NFT and Private AI route families. Their flags or partial contracts do not make them selectable providers. |
| Base MCP canonical USDC send | `proven` Extensions action | Exact amount/recipient policy, explicit approval, and exact onchain `Transfer` reconciliation produce an Action Receipt, not a Route Proof. |
| Base MCP explicit x402 GET | `adapter` Extensions action | Reviewed HTTPS hosts, canonical USDC ceiling, wallet binding, explicit approval, idempotency, and response hash exist. Independent onchain settlement reconciliation is still missing. |
| Miorail x402 Intelligence Seller | `adapter`, default-off | External agents can pay exactly `0.001 USDC` for observation-bound B20 exit analysis, B20 liquidity evidence, or independent verification of an owner-published Route Proof. No endpoint prepares wallet calls. A real settled-and-delivered production acceptance is still required. |
| Avantis | `manifested` Extensions / Perps | Read and intent parsing plus an official provider-UI handoff. Miorail does not invent perps calldata. |
| Printr, GMGN, Brickken, Flaunch, Clawnch, Virtuals, Bankr | `documented` | Visible in the Extensions catalogue with example prompts; no runtime write capability is implied. |

The full provider constraints and promotion gates live in
[PLUGIN_REGISTRY.md](docs/PLUGIN_REGISTRY.md).

## B20 intelligence

B20 is an evidence layer around tokens created by the B20 factory and their
Base liquidity. It is not a generic token screener and does not predict price
or profit.

```text
Base launch events
  → canonical b20_launches               [miorail-b20-discover]
  → Exit-First measurements
  → b20_opportunity_observations         [miorail-b20-measure]
  → Discover cards, market rails, MCP
```

Measurements can preserve:

- supported entry and exit routes plus pool-level provenance;
- measured round-trip result against the explicit 3% reference;
- tested exit-capacity bounds without interpolation;
- Uniswap v4 hook address and decoded permissions;
- launch-window buyer concentration and window state;
- transfer-control evidence, freshness, missing data, and route coverage.

`provisional` does not mean `qualified`. Hook permissions do not prove hook
behaviour. Launch-window buying does not prove buyer intent, related wallets,
or current holdings. A route miss covers Miorail's allowlisted venues at one
observation, not every venue forever.

### Ask Miorail

Every Discover card has an evidence lens for questions such as:

```text
Why was this rejected?
What is unusual here?
What evidence is missing?
Explain this hook.
Can I get out with a 100 USDC position?
What changed since the previous measurement?
```

The browser sends only the token address plus the exact append-only observation
ID and evidence hash. The server reloads canonical evidence and rejects a
changed observation instead of narrating stale client JSON. Answers are
deterministic evidence projections, not financial recommendations. Any request
to act is handed to Routes for fresh quotes and explicit approval.

### Public Miorail MCP

Miorail MCP `1.1.0` exposes exactly five read-only B20 tools:

```text
miorail_discover_status
miorail_list_b20_opportunities
miorail_get_b20_opportunity
miorail_explain_b20_rejection
miorail_get_b20_market_leaders
```

The public MCP surface has no wallet, signing, payment, approval, or execution
tool. Its Discover Card projection is parity-tested against the web/Base App
truth layer.

## Base MCP Extensions

Miorail reads the live `mcp.base.org` registry and classifies every tool as
`READ`, `ACTION`, `ROUTABLE`, or blocked before an LLM can select it.

- `READ` tools may answer scoped Base questions.
- `ROUTABLE` swap and yield requests are handed to Routes; Base MCP swap cannot
  bypass provider comparison or Route Proof.
- An `ACTION` is released only through its own typed input policy, wallet
  binding, safety checks, explicit approval, idempotency, persistence, and
  reconciliation.
- Unknown tools, arbitrary `send_calls`, and documentation-only plugins remain
  blocked. Dynamic discovery never grants execution.

Canonical USDC send and explicit x402 GET are the first typed direct-action
verticals. Their durable record is an **Action Receipt**, deliberately separate
from a Route Proof.

## Paid intelligence and Intelligence Budget

x402 funds allowlisted evidence, simulation, inference, or compute. It does not
fund portfolio asset movement.

```text
Spend Permission
  = bounded funding for approved intelligence categories

Base Account approval
  = swaps, sends, deposits, withdrawals, purchases, and other asset movement
```

The operator deployment currently keeps paid swap simulation off and enables
the B20 sequential exit simulation at `0.0002 USDC`. Disabling a paid surface
must never remove a mandatory Safety Kernel check. Reservations, charges, and
reconciliation are persisted through the Intelligence Budget ledger.

Miorail also implements the reverse, agent-facing side behind the default-off
`MIORAIL_X402_SELLER_INTELLIGENCE_V1` gate:

```text
external agent
  → x402 payment: exactly 0.001 USDC on Base
  → Miorail stored intelligence / published proof verification
  → versioned response + request hash + deterministic data hash
```

The free catalog is at `/api/x402/intelligence/v1/catalog`. Paid resources are
limited to B20 exit analysis, B20 liquidity evidence, and enhanced verification
of an already owner-published Route Proof. Invalid input and missing evidence
are rejected before payment middleware; paid B20 evidence is bound to the exact
stored observation and never interpolates capacity. Seller settlement and
delivery are separate persisted states, and only delivered data hashes appear
in public sold-intelligence metrics.

## Execution boundary

- Miorail never stores a user private key, signs for the user, or broadcasts a
  raw transaction from the server.
- The server builds exact unsigned calls; the connected Base Account is the
  only signer and submits `wallet_sendCalls` client-side.
- The client never supplies calldata, router, recipient, spender, deadline, or
  minimum output for a route.
- Blueprint hashes bind the intent, candidate, evidence, approved calls, wallet,
  chain, and expiry reviewed by the user.
- Provider output is independently decoded and checked against pinned hosts and
  contracts before wallet approval.
- Receipt success alone is insufficient. Route Proof reconciles actual asset or
  position changes and gas; missing facts remain pending or require manual
  reconciliation.
- Native Base ETH swap legs are reconstructed only from canonical WETH9
  `Deposit`/`Withdrawal` events emitted for an exact approved router target;
  Miorail never guesses native value from a receipt or RPC balance delta.
- Every production `wallet_sendCalls` surface receives the same optional
  ERC-8021 Builder Code suffix at build time. Attribution never changes the
  server-approved calls and never blocks a wallet lacking suffix support.
- RPC URLs, keys, approval URLs, paid response bodies, and delivery secrets do
  not enter public evidence, hashes, logs, or rendered traces.

## Production acceptance

The owner has completed two production swap journeys through the UI:

```text
USDC → ETH → Route Proof reconciled
ETH  → USDC → Route Proof reconciled
```

The owner has also verified a canonical `0.1 USDC` Base MCP send, recent Base
transaction history, portfolio reads, and an explicit x402 GET that returned
the paid resource.

This proves the shared swap Route Proof lifecycle has run end to end in
production. It does **not** prove every provider or route family independently:
the provider, Route Proof ID, transaction hash, and client were not captured for
the two swap journeys. Provider-specific and failure-path gates remain in
[PRODUCTION_UI_VERIFICATION.md](docs/PRODUCTION_UI_VERIFICATION.md).

## Repository map

This is a pnpm monorepo. The product name is Miorail; the repository name
`mioagent` and `@mioagent/*` package namespace remain for compatibility.

| Path | Responsibility |
| --- | --- |
| `artifacts/api-server` | Express API, authenticated product routes, public/private MCP, workers, and reconciliation orchestration. |
| `artifacts/interface` | Vite/React web console. |
| `artifacts/miniapp` | Next.js Base App. |
| `lib/route-domain`, `lib/route-storage` | Versioned contracts, stable hashes, additive persistence, and append-only proof history. |
| `lib/intent-engine`, `lib/route-engine`, `lib/route-card` | Typed intent, deterministic comparison, and Route Card projection. |
| `lib/swap-adapters`, `lib/earn-engine` | Curated provider-neutral swap adapters and the Earn comparison engine. |
| `lib/security`, `lib/transaction-composer` | Safety Kernel and exact unsigned Blueprint construction. |
| `lib/route-proof`, `lib/proof-verifier` | Expected-versus-actual reconciliation and independent integrity verification. |
| `lib/opportunity-rail`, `lib/b20-control` | B20 measurements, controls, capacity, and product-language boundaries. |
| `lib/mcp`, `lib/tools` | Base MCP transport, classification, and constrained tool execution. |
| `lib/x402-gateway`, `lib/paid-intelligence`, `lib/intelligence-budget` | Paid evidence, reservations, charging, and reconciliation. |
| `lib/ui`, `lib/api-zod`, `lib/api-client-react` | Shared web/Base App UI and runtime-validated API contracts. |
| `contracts/legacy` | Historical custom Sepolia Spend Permission experiment; excluded from normal Foundry source/deploy/test paths. Production uses the official Base Account Spend Permission flow. |

## Development

Requirements:

- Node.js 22.x (production currently uses `22.23.1`);
- pnpm 11.x through Corepack;
- PostgreSQL.

```bash
pnpm install --frozen-lockfile
cp .env.example .env

# Run in separate shells as needed:
pnpm exec tsx artifacts/api-server/index.ts
pnpm --filter @mioagent/interface dev
pnpm --filter @mioagent/miniapp dev
```

Primary checks:

```bash
pnpm test:unit
pnpm test:db
pnpm typecheck
pnpm -r build
git diff --check
```

`pnpm -r build` does not typecheck `scripts/`. The current workspace typecheck
still reports two known `TS1470` failures in `b20DiscoverCli.test.ts` and
`b20SweepCli.test.ts`; do not mistake them for a feature regression or silently
drop the scripts package from validation.

Dependencies use `minimumReleaseAge: 7d` in `pnpm-workspace.yaml`. Pin a mature
version when pnpm cannot resolve one; do not relax the supply-chain policy.
Never commit `.env` files, RPC URLs, private keys, approval URLs, OAuth tokens,
or provider credentials.

### Deployment

Run `ops/deploy.sh` as root on the host. Its seven gates:

1. fast-forward the production worktree;
2. install the frozen dependency graph;
3. build every workspace deployable;
4. install and validate nginx/systemd configuration;
5. publish the exact web bundle nginx serves;
6. restart and verify all services;
7. compare built/served assets and smoke-test Base App plus public MCP.

The build step injects only the public `BASE_BUILDER_CODE` into Vite and Next.
It never sources the server `.env`, and refuses a missing, malformed, or
conflicting code so production bundles cannot silently lose ERC-8021
attribution.

Production services:

```text
miorail-api
miorail-miniapp
miorail-b20-discover
miorail-b20-measure
```

## Known gaps

The project is functional but not broadly production-hardened. Current gates:

- capture provider-specific small-value Route Proofs for Uniswap and KyberSwap;
- reconcile real Route Proofs before promoting Balancer, Hydrex, or o1.exchange
  from `scored` to `proven`;
- complete owner-verified B20 entry and exit journeys, including actual asset
  changes, gas, deviation, and manual-review/partial-failure states;
- complete owner-verified Moonwell, Morpho, and YO deposit/exit journeys after
  pinned-contract preflight;
- finish independent onchain settlement reconciliation for Extensions x402;
- run one explicitly approved seller acceptance for each x402 intelligence
  resource before enabling the seller flag or calling it production-proven;
- keep Base MCP signing, ETH/other ERC-20 sends, Base names, arbitrary calls,
  and provider-specific plugin writes unreleased until typed verticals exist;
- reconcile Commerce rollout configuration with its `scored` registry stage;
  a feature flag must not advertise Bitrefill as `proven` before a real
  paid-and-delivered order and operator recovery runbook exist;
- replace the default in-process `express-session` MemoryStore before
  horizontal scaling;
- close the two script-package typecheck failures and complete independent
  security, backup/restore, rollback, and failure-matrix review.

## Safety notice

Miorail is experimental software. The core swap Route Proof lifecycle has
completed owner-verified production journeys in both USDC/ETH directions, but
provider-specific promotion, B20 and Earn proofs, x402 settlement, failure-path
reconciliation, and independent production review remain open.

Do not use Miorail with funds you cannot afford to lose.

## License

TBD.
