# `@mioagent/intent-core`

Shared pure safety and normalization primitives used by both the frozen legacy
semantic intent flow and Intent Engine V2. The package owns strict JSON-object
parsing, prompt-injection and approval-bypass detection, exact/relative amount
normalization, the trusted Base asset registry, sanitized conversation
serialization, and recipient/address grounding.

Moving these helpers here keeps `artifacts/api-server/lib/semanticIntent.ts`
backward compatible while preventing a second divergent security parser. This
package performs no provider, wallet, database, x402, or network operation.
