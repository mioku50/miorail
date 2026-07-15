# `@mioagent/intent-engine`

T52's isolated Swap Intent V2 resolver converts an English or Russian user
request into one of three deterministic outcomes: a validated
`RouteIntentV1`, a structured clarification, or a rejection. It is not
registered in the production chat/runtime graph.

The pipeline is:

```text
strict LLM JSON extraction
  → message and authenticated-context grounding
  → deterministic EN/RU normalization
  → clarification or rejection
  → RouteIntentV1Schema + canonical intentHash
```

The strict extractor cannot call tools and its output is never trusted by
itself. Amounts and assets must be present in the current message or in one
recent, tenant-and-wallet-bound `PendingSwapIntentV2`. Assistant text and
conversation metadata never provide financial fields.

## Deterministic mappings

- Optimization: best result (default), lowest risk, lowest fees, simplest
  route, fastest execution, or MEV protected.
- Verification: standard (default), enhanced, or maximum.
- Protocols: canonical lowercase `uniswap` and `kyberswap`, represented as
  `any`, `include_only`, or `exclude`. Mixed or conflicting constraints fail
  closed.
- Slippage: explicit percentages are converted exactly to basis points. The
  centralized absent-value default is 50 bps (0.5%) with `source: default`.
- Execution intent: quotes/comparisons and explicit “do not execute” phrases
  are false; ordinary swap and prepare requests are true. T52 never executes
  either form.

Only exact positive token amounts are ready. `all`, `half`, percentages,
approximations, unsupported tokens, missing fields, invalid slippage, and an
identical asset pair produce clarification. Prompt injection, approval bypass,
unsupported chains, conflicting amounts/protocol constraints, unsafe token
addresses, and requests for server signing or broadcasting are rejected.

## Optional persistence

`persistReadyRouteIntentV2` can write a ready intent through
`RouteStorageRepository`. It requires an explicit authenticated tenant/wallet
binding and is disabled unless `MIORAIL_ROUTE_INTELLIGENCE_V1` is exactly
`true`. Clarifications and rejections are never persisted. Storage errors are
not caught or downgraded to legacy execution.

T52 adds no API route, provider request, score, Route Card, blueprint, wallet
call, x402 payment, Spend Permission operation, database migration, or feature
flag default change.
