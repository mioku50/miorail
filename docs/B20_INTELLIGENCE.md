# B20 and Fundamental Intelligence

The two evidence layers behind Miorail's Discover surface, in full.

They moved out of the README on 2026-09-05 for the reason any reference does:
a README is read once, to decide whether to keep reading, and these two
sections were a quarter of it. Nothing here changed in the move.

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
