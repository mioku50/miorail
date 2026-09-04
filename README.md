# Miorail

> **One intent. Multiple routes. One verified plan.**

Miorail is a self-hostable, non-custodial market-reality and execution-verification product for Base.

Its subject is **tokenized stocks**. One security can be represented on Base by several different contracts — Coinbase's B20 tokenized stocks, Backed bTokens, Dinari dShares — and they are not economically the same thing. Miorail measures each exact address separately, at one exact size and one exact direction, and reports what a cash exit actually costs there.

Under that sits the original route layer: a user describes an outcome in ordinary language, Miorail turns it into a typed intent, evaluates curated routes, preserves evidence and provenance, prepares one reviewable execution plan, validates the exact calls, and leaves final approval to the user's Base Account. After execution, Miorail reconciles expected and actual results into a durable Route Proof.

The governing rule is simple:

> **No data — no score.** A measurement that did not happen is never rendered as zero, success, safety, or a recommendation.

- Network: Base mainnet (`8453`)
- Live web console: [miorail.xyz](https://miorail.xyz)
- Public read-only MCP: `https://miorail.xyz/mcp`
- Public product metrics: [miorail.xyz/metrics](https://miorail.xyz/metrics)
- Product direction: [MIORAIL_VISION.md](docs/MIORAIL_VISION.md)
- Capability truth: [PLUGIN_REGISTRY.md](docs/PLUGIN_REGISTRY.md)
- Production acceptance: [PRODUCTION_UI_VERIFICATION.md](docs/PRODUCTION_UI_VERIFICATION.md)

## Running it yourself

```bash
pnpm install
cp .env.example .env     # every credential is optional; see below
pnpm test:unit           # the gate
pnpm dev
```

Node 22+, pnpm 10+.

**Nothing in `.env` is required to start.** Measured on a checkout with no
`.env` file at all: the API boots, `/health` returns 200, `CHAIN_ENV` defaults
to `sepolia`, and batch transaction simulation is already available — it falls
back to Base's own public RPC, which serves `eth_simulateV1`, so no paid key is
a precondition for anything.

Miorail treats a missing credential as an absent capability and says so on
screen rather than failing or pretending, so each surface tells you what it
would need in order to do more.

Postgres is needed only for the B20 Discover feed, the durable receipt store
and `pnpm test:db`; `pnpm test:unit` runs without it. When you do want it:

```bash
pnpm db:up          # Postgres 17 in Docker, on 127.0.0.1 only
pnpm db:migrate     # applies all 50 migrations
pnpm test:db
```

`db:up` creates two databases — `miorail` and `miorail_test`. They have to be
separate: `pnpm test:db` refuses to run against the same database as
`DATABASE_URL`, so that a test run can never truncate real data. The
`DATABASE_URL` and `TEST_DATABASE_URL` in `.env.example` already point at both.

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security policy: [SECURITY.md](SECURITY.md) — **do not file security bugs as public issues**
- What Miorail guarantees, and what it does not: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)

Miorail composes transactions; it never signs them. It holds no private key,
never calls `signTransaction`, and never broadcasts. Every state change is
submitted by your own Base Account, from calls you approved.

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
closed-schema classification and extraction, while a reasoning primary handles
evidence-bound investigation and user-facing explanations. TypeScript/Zod
contracts, not either model, decide which reads and actions are allowed.

## Product surfaces

| Surface | Web path | What it owns |
| --- | --- | --- |
| **Stocks** | `/market` | One security, every reviewed way to hold it on Base, at one exact size: market reality, use & access, the Chainlink reference, and `Ask Miorail` over that page's own evidence. |
| **Radar** | `/radar` | Watched representation/size/direction/destination questions, and what changed since the last look. |
| **Investigate** | `/investigate` | Any Base address, read as deeply as the evidence allows: identity, four trust roots stated apart, controls, topology and exit. |
| **Discover** | `/opportunities` | B20 launch measurements, market rails, Fundamental Intelligence, global `Ask Miorail`, evidence gaps, and focused measurement views. |
| **B20 controls** | `/portfolio` | Wallet B20 holdings, control snapshots, exit-first checks, watchlists, simulation review, and B20 entry reconciliation. |
| **Routes AI** | `/routes` | Intent, provider-neutral candidates, Route Cards, Blueprint review, Safety Kernel, Base Account approval, and Route Proof. |
| **Activity** | `/plan/history` | Route runs and proofs, Base MCP Action Receipts, and intelligence/x402 charge history. |
| **Base MCP Extensions** | `/extensions` | Live Base MCP reads, capability truth, deterministic Routes handoff, and released typed direct actions. |
| **Settings** | `/settings` | Connected apps, adapter health, providers, network state, and — under Advanced — the agent spending budget. |
| **Public Metrics** | `/metrics` | Sessionless Base telemetry with exact definitions, caveats, and a deterministic snapshot hash. |

Stocks, Radar and Discover are the three tabs; the rest sit in the drawer under **Advanced evidence**.

Web and Base App share the same typed product contracts so financial copy and capability state cannot silently diverge between clients.

## Capability truth

A Markdown plugin specification is documentation, not a connected capability. Every integration follows this lifecycle:

```text
documented → manifested → adapter → scored → proven
```

Feature flags and credentials may still block a capability. Enabling a flag never promotes a provider above its registry stage.

The current registry includes provider-neutral Swap and Earn routes, typed Base MCP actions, x402 paid intelligence, and documented/manifested extensions. Promotion to `proven` requires a real reconciled production path, not just working code.

The full provider constraints and promotion gates live in [PLUGIN_REGISTRY.md](docs/PLUGIN_REGISTRY.md).

## Tokenized stocks on Base

Coinbase issues tokenized stocks on Base under the **B20** standard the Base
documents describe. Two other issuers put representations of the same companies
on the same chain — Backed bTokens (Swiss-law tracker certificates that rebase)
and Dinari dShares — and they are separate systems, not versions of one thing.
Measured on 2026-09-04 at a $1,000 sell into USDC, 10 of 13 Coinbase
representations held a cash route, against 2 of 21 Backed and 0 of 96 Dinari.

So the Stocks surface opens on Coinbase B20 and keeps the rest one press away
under **Other representations of this security on Base**. Nothing is removed:
the claim this product exists to make — *same underlying, different
representations, different market reality* — needs the alternatives visible.

```text
reviewed issuer sources (Base docs, Coinbase, Backed API, Dinari factory)
  → underlying_asset / representation_underlying     one company, many exact addresses
  → supply read at an anchored block
  → cash-exit measurement through reviewed route sources, per exact size
  → market-reality comparison + Chainlink total-return reference
  → Stocks card / Radar / MCP / Ask Miorail
```

**What a card answers, and what it refuses to.** Two questions, kept apart on
purpose:

- *Is there an answer right now* — one chip, in Base blue. A router quote is
  open for about twenty seconds; past that the same card says `Price expired`,
  because the clock decides that and not a status stamped when the response was
  assembled.
- *What the answer costs* — a second chip, graded. Inside the reviewed slippage
  policy (200 bps, derived: two legs of the 100 bps every cash-exit intent is
  planned under), above it, or an order of magnitude above it. A round trip that
  returns $0.94 on $1,000 is a priced market and a total loss, and one colour
  must not say both.

Every absence is attributed. `No cash route found` is the market, `This route
source does not cover this token` is Miorail's coverage, `Venue declined to
quote` is the venue's own rule, and `Our read failed` is ours. They were once
one word.

**Onchain B20 reads**, at an anchored block: the redemption `multiplier`, the
ISIN published at the lowercase `extraMetadata("isin")` key, the four transfer
policies, the supply cap and the paused-feature set. The multiplier is a
disclosure, never applied to a total-return feed — B20 publishes one, Backed
rebases instead, and Centrifuge has none.

**Coverage boundaries, stated rather than hidden.** Nine of the thirteen
Coinbase representations hold zero supply; a contract with nothing outstanding
keeps its exact address and all of its evidence and leaves the comparison.
Where no route source can price a token, that is usually the market: all 79
uncovered contracts were equally unquotable by Odos, ParaSwap and LiFi at the
same size on the same day. A reference price exists only where the issuer
publishes a feed — 13 of 13 Coinbase, 0 of 21 Backed — because Backed's oracle
path is Chainlink Data Streams, which has nothing to call.

## B20 Intelligence

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

### Consumer Discover

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

### Market rails

The right rail is a measured view, not a token ranking.

- **Measured exit liquidity** orders fresh comparable observations by one measured exit-capacity dimension.
- **24h Route Cost Changes** compares compatible observations roughly one day apart. A dedicated remeasurement queue reserves worker capacity for tokens that need a second comparable observation instead of letting newest-first ingestion starve the history rail.
- Stale measurements are visibly marked as stale.

`View measurement` deep-links to the exact token on Discover:

```text
/opportunities?token=0x...&view=measurement
```

The focused view can load a token by address even when it is not present in the current 25-card feed page, and URL state survives refresh/back navigation.

## Fundamental Intelligence

Fundamental Intelligence is a second evidence axis beside market measurement.

It answers a different question:

> **Is this B20 verifiably connected to a real project, and what can Miorail actually establish about that project?**

It never attaches a project to a token by matching a name or symbol.

### Identity chain

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

### Fundamental dimensions

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

### Fundamental Explore

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

#### Current coverage boundary

Project claims are currently operator-registered. There is not yet a public self-serve submission flow, so Fundamental Intelligence coverage is intentionally much smaller than the full B20 index.

## Ask Miorail

On a Stocks page the model is given that page's own evidence bundle and nothing
else: no planner, no extra reads, and a verifier that rejects any number the
bundle does not contain. The deterministic answer carries the assertions the
narration must preserve, so "not measured" cannot be said over three thousand
measured launches. Every failure falls back to the deterministic text.

The B20 console has three scopes:

- **Explore** — deterministic universe/fundamental queries;
- **Investigate** — one to five named tokens side by side;
- **Changes** — comparable stored observations over time.

The model is not a source of facts. Deterministic code builds an evidence bundle first; narration is allowed only over that bundle, and the verifier rejects unsupported numbers or claims.

Requests to act are handed to Routes for fresh quotes and explicit approval.

## Public Miorail MCP

Miorail MCP `1.2.0` exposes twelve read-only tools at `https://miorail.xyz/mcp`
— four over tokenized stocks, eight over stored B20 evidence:

```text
list_reviewed_stocks        every reviewed security, by ticker, name or ISIN
get_representations         every exact address that claims one security
compare_market_reality      one size, one direction, every representation
get_market_changes          what moved since a stored observation

miorail_discover_status
miorail_list_b20_opportunities
miorail_summarise_b20_universe
miorail_get_b20_opportunity
miorail_explain_b20_rejection
miorail_compare_b20_tokens
miorail_find_b20_projects
miorail_b20_market_rails
```

`get_representations` never chooses one: different issuers publish different
contracts for the same company, and that choice is not Miorail's to make. A
company name reaches a security through a small ISIN-bound alias table, and
every row says whether the issuer's own naming or a Miorail alias found it.

The public MCP surface has no wallet, signing, payment, approval, or execution
tool. Its Discover projection is parity-tested against the product truth layer,
and `ops/deploy.sh` asserts the tool names and the version by literal, so a
renamed tool fails the deploy rather than a caller.

## Base MCP Extensions

Miorail reads the live `mcp.base.org` registry and classifies tools as `READ`, `ACTION`, `ROUTABLE`, or blocked before an LLM can select them.

- `READ` tools may answer scoped Base questions.
- `ROUTABLE` swap/yield requests are handed to Routes; they cannot bypass provider comparison or Route Proof.
- An `ACTION` is released only through a typed input policy, wallet binding, safety checks, explicit approval, idempotency, persistence, and reconciliation.
- Reviewed HTTP recipes bypass generic prompting: Moonwell market/health reads use pinned hosts and exact paths.
- Virtuals agent creation is a typed action: Miorail requests an exact SIWE challenge, pauses for `Approve Sign-In`, keeps the authenticated provider session encrypted, creates the named agent, and records a provider-confirmed Action Receipt. Generic signing, email, OTP, and card actions are not implied.
- Unknown tools, arbitrary calls, and documentation-only plugins remain blocked. Dynamic discovery never grants execution.

Action Receipts are deliberately separate from Route Proofs.

## Paid intelligence and x402

x402 funds allowlisted evidence, simulation, inference, or compute. It does not fund portfolio asset movement.

Miorail also implements the seller side:

```text
external agent
  → x402 payment in Base USDC
  → stored B20 intelligence / published proof verification
  → versioned response + request hash + deterministic data hash
```

The free catalog is at `/api/x402/intelligence/v1/catalog`. Paid resources are bound to stored evidence; missing/invalid inputs are rejected before payment middleware, and no seller endpoint prepares wallet calls.

### x402 settlement vs Builder Code attribution

The seller and app-transaction paths are intentionally different.

In a facilitated x402 seller payment, the external payer signs an authorization and the facilitator may build/broadcast the settlement transaction. Receiving x402 revenue therefore does not by itself mean Miorail originated an onchain transaction carrying Miorail's ERC-8021 Builder Code.

For app-originated user execution, Miorail's wallet-action layer attaches the public Builder Code as an optional `dataSuffix` capability to `wallet_sendCalls` when the connected wallet reports support. Attribution never changes the server-approved calls and never blocks execution when the wallet lacks that capability.

## Execution boundary

- Miorail never stores a user private key, signs for the user, or broadcasts a raw transaction from the server.
- The server builds exact unsigned calls; the connected Base Account is the signer and submits approved calls client-side.
- The client never supplies route calldata, router, recipient, spender, deadline, or minimum output.
- Blueprint hashes bind intent, candidate, evidence, approved calls, wallet, chain, and expiry.
- Provider output is independently decoded and checked before wallet approval.
- Receipt success alone is insufficient. Route Proof reconciles expected and actual asset/position changes and gas.
- Native Base ETH swap legs are reconstructed only from canonical WETH9 evidence for the approved router target.
- RPC URLs, secrets, approval URLs, paid response bodies, and delivery secrets do not enter public evidence or rendered traces.

## Production acceptance

The shared swap Route Proof lifecycle has completed owner-verified production journeys in both directions:

```text
USDC → ETH → Route Proof reconciled
ETH  → USDC → Route Proof reconciled
```

Production acceptance also includes canonical Base MCP reads/actions and real x402 intelligence purchases. Provider-specific proof promotion remains stricter than “the shared path worked once”; the acceptance ledger keeps those claims separate.

See [PRODUCTION_UI_VERIFICATION.md](docs/PRODUCTION_UI_VERIFICATION.md) for the detailed rollout ledger.

## Repository map

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
| `lib/rwa-market-reality`, `lib/rwa-issuer`, `lib/rwa-dossier` | Tokenized-stock identity, per-issuer adapters, market-reality comparison, use-and-access evidence, and the address dossier. |
| `lib/mcp`, `lib/tools` | Base MCP transport, classification, and constrained execution. |
| `lib/x402-gateway`, `lib/paid-intelligence`, `lib/intelligence-budget` | Paid evidence, reservations, charging, and reconciliation. |
| `lib/wallet-actions` | Base Account approval/submission and ERC-8021 attribution handling. |
| `lib/ui`, `lib/api-zod`, `lib/api-client-react` | Shared web/Base App UI and runtime-validated contracts. |
| `contracts/legacy` | Historical custom Sepolia Spend Permission experiment; production uses the official Base Account Spend Permission flow. |

## Development

Requirements:

- Node.js 22.x;
- pnpm 11.x through Corepack;
- PostgreSQL 17 — `pnpm db:up` runs it in Docker, pinned to the major version
  production runs.

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

### Deployment

Production deployment is managed by `ops/deploy.sh`, which builds the deployables, validates nginx/systemd configuration, publishes the exact served bundle, restarts services, and smoke-tests the Base App and public MCP.

The build injects only the public `BASE_BUILDER_CODE` into the client surfaces. It never needs a user signing key.

Production services include:

```text
miorail-api
miorail-miniapp
miorail-b20-discover
miorail-b20-measure
```

## Known gaps

Miorail is functional but not broadly production-hardened. Important open work includes:

- nine of the thirteen Coinbase tokenized stocks hold zero supply, so the comparison the product is built on is demonstrable on four securities today;
- no reference price exists for Backed or Dinari, because neither publishes a feed a contract can read — the adapters are deliberately unwritten rather than written to return nothing;
- the Investigate dossier is only partly polymorphic: a non-B20 contract is told so plainly, but Backed's rebasing model and Dinari's factory predicate do not yet have evidence modules of their own;
- `compare_market_reality` reads stored evidence only, so a connected assistant cannot force a fresh measurement the way the web surface can;
- expand Fundamental Intelligence beyond the operator-registered claim corpus and design a safe self-serve project-claim flow;
- add more verified project/onchain/utility evidence without introducing an overall investment score;
- capture more provider-specific small-value Route Proofs and failure-path acceptance;
- complete owner-verified B20 entry/exit journeys and broader Earn acceptance;
- continue hardening x402 settlement/delivery reconciliation and RPC degradation paths;
- validate ERC-8021 attribution on real app-originated user executions rather than treating seller-side x402 settlement as app attribution;
- replace the default in-process session store before horizontal scaling;
- complete independent security, backup/restore, rollback, and failure-matrix review.

## Safety notice

Miorail is experimental software. Evidence, measurements, project verification, and Route Proofs are not investment recommendations or guarantees of safety, liquidity, execution, or future value.

Do not use Miorail with funds you cannot afford to lose.

## Licence

Miorail is free software under the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The practical consequence, since Miorail is normally run as a network service:
**if you run a modified Miorail and other people use it over a network, they
are entitled to your modified source.** Using it privately, or reading and
learning from the code, carries no such obligation.

The hosted instance at [miorail.xyz](https://miorail.xyz) offers its source in
the console footer, as §13 requires.

"Miorail" is the project's name, and the licence grants no trademark rights.
Fork it freely; call your fork something else.

## Authorship

Miorail is maintainer-directed and developed with extensive AI-assisted
engineering. Commits carry a single canonical identity, `Miorail Development`,
because the alternative — a contributor graph of the tools that held the
keyboard — describes the workflow rather than who is answerable for the code.
One person directs the work and is accountable for it; the assistants are
instruments, not contributors.

Every claim this repository makes about what Miorail measured is expected to be
reproducible from the code and the evidence it stores, whoever or whatever
typed it.
