# `@mioagent/route-domain`

Versioned, provider-neutral contracts for the Miorail route-intelligence
architecture. This package contains schemas, inferred TypeScript types,
canonical serialization, hashing rules, and contract fixtures only.

It has no production runtime registration, database access, network client,
provider adapter, scoring implementation, UI, x402 payment code, wallet code,
or feature-flag side effect.

## Hashing V1

- Algorithm: SHA-256, returned as lowercase `0x`-prefixed `bytes32`.
- Input: `{ domain: "miorail:<contract-domain>", payload: <canonical JSON> }`.
- Object keys are sorted by Unicode code unit; array order is preserved.
- `undefined`, non-finite numbers, bigint values, class instances, and cyclic
  values are rejected or omitted according to `canonicalJsonV1` rules.
- Financial decimal and atomic values are strings, avoiding floating-point
  normalization differences.
- Lifecycle fields (`id`, `createdAt`, `updatedAt`, and `status`) are excluded
  from financial-content hashes. Tenant, wallet, chain, provenance, expiries,
  and financial content remain bound to the hash.
- Each contract uses a distinct domain so identical JSON cannot collide across
  intent, candidate, evidence, score, blueprint, proof, event, and charge types.

Schemas validate their own content hash. Linked hashes are checked where the
linked object is embedded, such as Evidence Set records, Path Score dimensions,
Route Card candidates, Blueprint calls, and Route Proof approved calls.

## T50 boundary

Fixtures use deterministic mock identifiers, addresses, hashes, quotes,
simulation results, and receipts. They are not real quotes or executable wallet
payloads and must never be broadcast.
