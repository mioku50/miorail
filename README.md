# Miorail

> formerly MioAgent

**One intent. Multiple routes. One verified plan.**

Miorail is the intent, route-intelligence, and execution-verification layer for Base.

A user describes an outcome in ordinary language. Miorail turns it into a typed intent, evaluates approved execution routes, gathers the data needed to compare them honestly, normalizes the results, prepares one reviewable plan, validates the calls, and asks the user to approve the final action in their own Base Account.

The rule underneath all of it: **a measurement that did not happen is never reported as a result.** An empty rail says the rail is empty. A provider that did not answer is a provider that did not answer, not a zero, not a refusal, and not a finding about the token.

> Network: Base mainnet (8453)
> Execution model: non-custodial. Miorail never holds a key and never broadcasts.
> Live: `https://miorail.xyz` — web console and Base App mini app
> Product direction: [`docs/MIORAIL_VISION.md`](docs/MIORAIL_VISION.md)
> Manual production acceptance: [`docs/PRODUCTION_UI_VERIFICATION.md`](docs/PRODUCTION_UI_VERIFICATION.md)

---

## What runs today

Six surfaces, shared between the web console and the Base App mini app from one section table (`lib/ui/src/console/navigation.ts`), so the two cannot drift.

| Surface | Path | State |
| --- | --- | --- |
| **Discover** | `/opportunities` | B20 launch feed. Two workers ingest and measure; the rail shows measured exits or says why it cannot. |
| **B20** | `/portfolio` | B20 holdings, what their controls have done since, wallet balances, and the paid exit proof. |
| **Routes** | `/routes` | The goal flow: intent → candidates → Route Card → review → Base Account. |
| **Activity** | `/plan/history` | Route runs and proofs, Base MCP Action Receipts, and the x402 payment ledger. In the drawer, not the tab bar. |
| **Extensions** | `/extensions` | Base MCP: published plugin reference, live `READ / ACTION / ROUTABLE` capability truth, scoped AI reads, deterministic route handoff, and typed direct actions. In the drawer. |
| **Settings** | `/settings` | Budget & payments, adapters, providers, network. |

### Route families

`swap`, `earn`, `commerce`, `nft`, `private_ai` — each with its own intent, candidates, scoring, Route Card, review and proof shape, behind its own flag. They share the route-run lifecycle in `lib/route-storage`, not a generic "do anything" tool.

### B20 Discover

The largest thing in the repository that is actually running.

```text
launch events (Uniswap v4 shared hook)
  → b20_launches                      [miorail-b20-discover]
  → exit measurement, both legs against one state
  → b20_opportunity_observations      [miorail-b20-measure]
  → Discover rail
```

Two facts shape it. B20 tokens trade on **Uniswap v4**, in a pool created inside the launch's own ten-block window — measuring Aerodrome instead is why an early build rejected 99.7% of launches. And an observation the worker made in the background can never be `qualified`; only a measurement someone asked for can make an affirmative claim.

The rail distinguishes *rejected*, *provisional*, *unmeasured* and *endpoint unavailable*, and it will show an empty rail rather than soften the rule that produced it.

### Base MCP Extensions

- **Plugins** — 20 specifications Base publishes. Miorail keeps a committed catalogue generated from their frontmatter (`scripts/refreshBaseMcpPluginCatalogue.mts`), including each spec's own `requires.allowlist`, which is the host boundary. A live check compares plugin *names* against what Base publishes and reports drift; a name cannot widen an allowlist.
- **Tools** — the calls `mcp.base.org` exposes, read live and classified `read_only` / `user_confirmed_transaction` / `forbidden` / `unknown`. **`unknown` is treated as forbidden.** Two of them — `chain_rpc_request` and `web_request` — carry their capability in an argument rather than in their name, so a per-call guard (`baseMcpReadOnlyArgumentGuardV1`) decides: read JSON-RPC methods only, GET only. Base enforces the same boundary upstream; Miorail does not rely on that.

The product classifier then assigns each live core tool to `READ`, `ACTION`,
`ROUTABLE`, or blocked. That label does not grant execution. Reads run inside
an AI thread whose entire inventory is Base MCP and whose trace remains part of
the answer. Swap/yield intent is intercepted deterministically and handed to
Routes AI before any Base MCP write can run. An ACTION becomes callable only
when a typed vertical owns its input policy, approval lifecycle, idempotency,
storage, and reconciliation.

Canonical Base USDC send is the first such vertical. It accepts an exact amount
and `0x` recipient, enforces the server amount ceiling and safety policy, proves
that the Base MCP OAuth wallet matches the Miorail tenant wallet, returns the
ephemeral Base Account approval link, and stores a durable Action Receipt. A
provider `completed` status is not enough: Miorail marks it complete only after
matching the exact USDC `Transfer(from,to,amount)` in a server-read Base receipt.
The result is explicitly not a Route Proof.

Explicit x402 GET is the second typed action vertical. The user must name an
exact public HTTPS resource and a USDC maximum, the host must be in the
reviewed provider allowlist, and the server ceiling still applies. Miorail
persists the action facts before calling Base MCP, keeps the approval URL and
bounded response body ephemeral, and stores only a stable response hash. It is
currently `adapter`, not `proven`: provider completion proves that the paid
resource was returned, but this vertical does not yet independently reconcile
an onchain settlement receipt.

### Paid intelligence (x402)

Two priced surfaces, named separately so switching one on can never silently start charging for the other. Both default off.

| Surface | Flag | Production |
| --- | --- | --- |
| Swap simulation | `MIORAIL_PAID_SWAP_SIMULATION_V1` | off — the same comparison is free in any wallet, and a fork simulation is a *safety* step |
| B20 exit proof | `MIORAIL_PAID_B20_SIMULATION_V1` | on, `0.0002` USDC |

The exit proof is the one answer no other tool on Base gives: whether a B20 position can be exited, at what size, proven by a sequential simulation of both legs against a single state. Turning a paid surface off never removes a safety check.

A bounded **Base Spend Permission** funds these calls. It does not grant Miorail permission to move portfolio assets.

---

## Execution boundary

This is the part that is not negotiable, and most of the codebase's comments exist to defend it.

- Miorail never stores a user private key and never signs a raw transaction.
- For routes, the server prepares exact calls and **only the client opens the wallet**, through the single `useSubmitApprovedBlueprint` path. Base MCP `swap` cannot enter the Extensions action path.
- For a non-routable Extensions action, a deterministic typed adapter may call one exact allowlisted Base MCP tool. Base MCP returns an approval URL; the user reviews and approves in Base Account. Arbitrary `send_calls`, live-discovered writes, and documentation-only plugins are never executable by discovery.
- Direct actions persist immutable intent facts and a provider request ID before continuing. Approval URLs are ephemeral. Completion requires server-read onchain facts and produces an Action Receipt, never a Route Proof.
- Blueprint hashes are bound to what was reviewed. The client does not supply calldata, router, recipient, deadline or minimum output.
- RPC URLs, API keys and provider credentials never reach evidence, hashes, logs or a rendered trace.

---

## Architecture

```text
Natural-language request
  → Intent Engine            typed goal + constraints
  → Curated Skill Registry   approved route sources only
  → Intelligence Layer       free + approved x402 evidence, with provenance
  → Route Engine             normalize + Path Score + confidence
  → Route Card               evidence, alternatives, what is missing
  → Transaction Composer     Execution Blueprint (EIP-5792)
  → Safety Kernel            decode, verify, simulate
  → Base Account approval    the user, in their own wallet
  → Route Proof              expected vs actual
```

pnpm workspace. `artifacts/` holds the three deployables — `api-server`, `interface` (Vite/React), `miniapp` (Next.js, Base App) — and `lib/` holds ~40 packages under `@mioagent/*`. The ones worth knowing first:

| Package | What it owns |
| --- | --- |
| `route-domain`, `route-storage` | The route-run lifecycle and its persistence |
| `opportunity-rail`, `b20-control` | B20 measurement, clearance, and what a rail may claim |
| `swap-adapters` | Uniswap v4 pool resolution, quoting, round trips |
| `security` | Safety Kernel, host allowlists, Base MCP plugin catalogue |
| `mcp`, `tools`, `agent` | Base MCP client, tool classification, the agent loop |
| `x402-gateway`, `x402-actions`, `paid-intelligence` | The paid rail, both sides |
| `wallet-actions` | The one client-side submit path |
| `ui` | The console vocabulary shared by web and Base App |

The repository is named `mioagent` and the namespace stays `@mioagent/*`. The product is Miorail.

---

## Known gaps

Stated here because a README that lists only what works is the same failure mode the product is built to avoid.

- **Wallet balances** in Base App depend on `heldTokens` for decimals; a token missing from that list renders without them.
- Base MCP signing stays classified as ACTION but disabled because it has no typed message policy or durable Action Receipt vertical yet.
- Extensions x402 V1 is intentionally narrow: explicit GET only, canonical USDC cap, reviewed hosts only. Brickken and other provider-specific prepare/pay protocols still need their own adapters and cannot be replaced by this generic URL form.
- Base names, ETH/other ERC-20 transfers, plugin actions, and arbitrary `send_calls` are not part of Send V1.

---

## Development

Requirements: Node 20+, pnpm, PostgreSQL.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Checks:

```bash
pnpm test:unit     # ~4,400 unit tests, no database
pnpm test:db       # database-backed tests, isolated schema
pnpm -r build
```

Two things that have bitten before:

```bash
# pnpm -r build does NOT cover scripts/
npx tsc --noEmit -p scripts/tsconfig.json
```

```bash
# duplicate keys in .env are last-wins and have silently taken the LLM router down
pnpm env:doctor
```

Dependencies are held to `minimumReleaseAge: 7d` in `pnpm-workspace.yaml`. On `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, pin a mature version — do not relax the policy.

### Deploying

`ops/deploy.sh`, run as root on the host. Six steps in order, and it refuses to claim success it has not checked — the last step compares the built entry bundle against the one nginx serves, because a redeploy that leaves the browser on an old bundle has happened here and looked like a fix that did not work.

Services: `miorail-api`, `miorail-b20-discover`, `miorail-b20-measure`.

---

## Safety notice

Miorail is experimental software.

Do not use it with funds you cannot afford to lose until route scoring, data provenance, x402 settlement, Spend Permission limits, transaction preparation, simulation, Base Account approval and Route Proof reconciliation have been production hardened and independently reviewed. As of today the last of those has never run end to end — see *Known gaps*.

---

## License

TBD.
