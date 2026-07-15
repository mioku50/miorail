# @mioagent/swap-adapters

T53 provides isolated read-only Base mainnet quote adapters for Uniswap and
KyberSwap. Both accept the same ready `RouteIntentV1` and return validated
`RouteCandidateV1` plus quote `EvidenceRecordV1` provenance.

The package does not rank routes, persist data, build calldata, prepare
approvals, call wallets, use x402, or register itself in production routing.

Provider selection is explicit and deterministic. `any` returns Uniswap then
KyberSwap, protocol include/exclude constraints are respected, and an empty
selection is a typed failure. Generic quote language is never used to select a
provider.

All token amounts use decimal strings and integer base units. Minimum output is
derived with integer arithmetic from the intent slippage constraint. Request
hashes contain only safe canonical request fields; response hashes contain only
validated provider data and never credentials or headers.

KyberSwap is restricted by the runtime-skill manifest to:

```text
GET /base/api/v1/routes
```

Its fallback quote TTL is injected (20 seconds by default). Token search,
`/route/build`, calldata and transaction submission are outside T53.
