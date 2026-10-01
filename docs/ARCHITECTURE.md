# Miorail architecture

Current map, updated against the repository and Aeza VPS on 1 October 2026.
Execution boundaries: [SECURITY-MODEL](SECURITY-MODEL.md). Capability stages:
[PLUGIN_REGISTRY](PLUGIN_REGISTRY.md).

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
and connected MCP reads. Comparison reads stored evidence; connected
`miorail_measure_market_reality` invokes the web measurement coordinator.
Stocks MCP also returns measured Use & access, including exact-address DeFi
availability rather than treating announcements as venue listings.

`stockBriefRead.ts` serves the personal overview through the web and connected
MCP, deriving the wallet from its authenticated session/grant. Balances and
Cobalt multiplier getters share a pinned block; reference values remain separate
from market quotes. Explicit `stockPositionQuoteRead.ts` requests use the existing
cash-exit engine for the entire freshly read raw balance, persist tenant-scoped
evidence, and share the SELL terms request budget. They do not grant a clearance
or check wallet execution. Both web and Base App render these shared UI components.

The personal inbox keeps a fixed initial baseline and per-event read receipts
in PostgreSQL. Each overview freshly reads its bounded snapshot independently
of cached balances. Unread entries survive past seven days; fifty-row pages
use a signed cursor with a recording-time/ID total order. Public change feeds
keep occurrence-time ordering. Each entry explains current holding/watch
relevance and links to exact-contract inspection.

Explicit Mark as read submits an HMAC proof bound to the authenticated wallet,
returned event IDs and a fifteen-minute expiry. It cannot acknowledge unseen
pages or arbitrary timestamps. One SQL statement inserts all receipts and
updates the shared review date atomically; duplicate receipts are idempotent.
Web, Base App and Connected MCP share them. A failed feed issues no proof;
failed writes cannot become an optimistic success. The initial baseline is
bookkeeping only and never marks a signal as read. Old local browser cursors
are not imported. No receipt enrolls a watch or initiates a trade. Migration
0077 is additive and applied explicitly before deploying this release.

A source snapshot and its asset membership must publish atomically. Failed
provider reads preserve the last successful evidence and expose uncertainty;
they must not manufacture delistings, disabled transfers or absent markets.

## Action path

An exact representation produces a wallet-bound stock draft. `/action/:draft`
refreshes terms and obtains human confirmation. Draft, review and clearance
logic live in `artifacts/api-server/lib/stockAction*`. Confirmed BUY becomes a
typed route intent, then uses the existing route engine, simulation and Safety
Kernel to produce unsigned calls. The Base Account signs and submits them.

Stock clearance binds cash input for BUY and a user-chosen exact token input
for SELL. SELL terms are measured for that exact amount before confirmation;
the execution step refreshes the output while preserving the confirmed token
size. The separate certified B20 entry path remains buy-only.

EIP-5792 batch identifiers are submission identifiers. Confirmed transaction
hashes come from receipts. Reconciliation must establish actual asset movement
before claiming success.

## Separate MCP systems

Miorail serves 16 public read-only tools at `/mcp`. Connected MCP 1.5.0 adds thirteen
wallet-bound tools (29 total) for personal reads, preparation, measurement and
execution evidence. These
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
