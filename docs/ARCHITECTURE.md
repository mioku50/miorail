# Miorail architecture

Current map, checked against the repository and VPS on 5 September 2026.
Product direction: [MIORAIL_VISION](MIORAIL_VISION.md). Execution boundaries:
[SECURITY-MODEL](SECURITY-MODEL.md). Delivery gaps and audit evidence:
[production audit](audits/PRODUCTION_READINESS_2026-09-05.md).

## Product and surfaces

Coinbase Tokenized Stocks / B20 is the default. Backed and Dinari are separate
representations of the same underlying security. Stocks and Radar expose exact
market measurements and changes. Advanced evidence includes Discover,
Investigate and B20 controls. Routes AI and Base MCP Extensions are existing
capability surfaces. Execution continues a reviewed intelligence question.

## Runtime

- `artifacts/interface`: React/Vite web console. Its built files are published
  to `/var/www/miorail` on the VPS and served by nginx.
- `artifacts/miniapp`: Next.js Base App surface, exposed under `/app`.
- `artifacts/api-server`: Express API, session/wallet authentication, connected
  MCP OAuth, provider coordination, action review and tenant-bound persistence.
- `lib/db`: PostgreSQL adapters, Drizzle schema and checked-in migrations.
  Production is local PostgreSQL on **127.0.0.1:5433**.
- `scripts/rwa_*` and `ops/systemd`: scheduled issuer, supply/ratio, market and
  watchlist reads. Each worker's environment must be checked independently of
  the API's service overrides.

## Evidence path

Issuer sources and onchain reads establish exact representation identity,
supply and structure. `lib/rwa-issuer`, `lib/rwa-cash-exit`, `lib/market-tail`
and `lib/route-storage` collect and preserve evidence. The canonical
`lib/rwa-market-reality` engine separates router outcome, normalization,
reference price, freshness and historical observations.

`artifacts/api-server/routes/rwaMarketReality.ts` coordinates the web Stocks
surface. `routes/mcp/marketRealityTools.ts` projects the same engine into public
and connected MCP reads. Current MCP comparison reads stored evidence; the web
measurement coordinator has no MCP entry point yet. Use & access currently
exists on the web API but has no Stocks MCP tool.

A source snapshot and its asset membership must publish atomically. Failed
provider reads preserve the last successful evidence and expose uncertainty;
they must not manufacture delistings, disabled transfers or absent markets.

## Action path

An exact representation produces a wallet-bound stock draft. `/action/:draft`
refreshes terms and obtains human confirmation. Draft, review and clearance
logic live in `artifacts/api-server/lib/stockAction*`. Confirmed BUY becomes a
typed route intent, then uses the existing route engine, simulation and Safety
Kernel to produce unsigned calls. The Base Account signs and submits them.

Current stock clearance binds cash input for BUY. It does not bind token input
for SELL, so SELL execution is refused until a separate exact-token review
contract is implemented. The route engine's ability to swap tokens does not
close that missing Stocks review flow by itself.

EIP-5792 batch identifiers are submission identifiers. Confirmed transaction
hashes come from receipts. Reconciliation must establish actual asset movement
before claiming success.

## Separate MCP systems

Miorail serves 13 public read-only tools at `/mcp`. Connected MCP adds eight
wallet-bound tools (21 total) for preparation, measurement and execution
evidence. These
counts describe the audited release; new tools must update schemas, tests,
client instructions and deployment smoke checks together.

Miorail also acts as a client of `mcp.base.org`. Base MCP Extensions discovers
and classifies its live tool list, while reviewed typed adapters control what
is callable. The committed 20-plugin catalogue defines reviewed integrations;
its live drift check compares names only. Neither plugin text nor a discovered
tool can independently authorize an action or widen a host allowlist.

## Supporting packages

`lib/agent` and `lib/llm` support language interactions. `lib/route-*`, the
swap/earn/commerce/NFT engines, `lib/security`, and `lib/proof-verifier` supply
existing planning, validation and reconciliation. LLM explanations are
subordinate to typed evidence; a model must not select token contracts from
memory when a deterministic portfolio or identity lookup is available.

The current deployment uses systemd and nginx; see [DEPLOYMENT](DEPLOYMENT.md).
The old terminal architecture and route-family roadmap are historical context,
not authority for adding unrelated primary navigation.
