# @mioagent/route-engine

Deterministic, provider-neutral swap evidence evaluation for T54. The package calls injected
eligible adapters concurrently, revalidates all domain artifacts, builds candidate-specific
evidence sets, detects cross-candidate provenance overlap, produces the four canonical Path Score
V1 dimensions, and ranks only optimization modes supported by available evidence.

The package has no production wiring. It does not read environment variables, build calldata,
prepare approvals, call an LLM, execute wallet operations, or perform network enrichment. Adapter
and storage dependencies are explicit inputs to `SwapRouteEngine.evaluate()`.
