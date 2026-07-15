# `@mioagent/route-storage`

Additive persistence for the versioned Miorail route-intelligence domain.
The package owns repository contracts, an in-memory implementation, and a
Postgres implementation. Complete T50 payloads remain JSONB; query-critical
identity, tenant, status, lineage, expiry, and content-hash fields are stored in
relational envelope columns.

Every write is validated with `@mioagent/route-domain` before SQL or in-memory
state is changed. Every read validates the JSONB payload again and checks it
against the relational envelope before returning it. Invalid or mismatched
stored payloads fail closed.

`route_evidence_sets` is intentionally included in addition to the tables named
in T51 because `EvidenceSetV1` is a required persistence round trip. It keeps the
set hash, missing-evidence state, source independence, and exact record lineage
independent from score snapshots.

## Isolation and idempotency

- Every read is scoped by both route/run identity and `user_id`.
- Payload `tenantId` must equal the relational `user_id`.
- Same-content retries are idempotent for immutable objects.
- Conflicting IDs or run-scoped hashes are rejected.
- Proof events are append-only and reject duplicate sequence or event hash.
- Identical intent hashes may create separate runs when IDs and user-scoped
  idempotency keys differ.
- No repository method signs, broadcasts, reserves funds, charges a Spend
  Permission, or changes an x402 receipt.

Current repository methods each persist one aggregate record using a single SQL
statement. Future methods that span multiple records must receive and use an
explicit transaction executor; they must not compose these methods as an
unprotected multi-write workflow.

## Runtime boundary

No production runtime imports this package in T51. There are no API routes,
feature-flag changes, Route Card generation, scoring, provider calls, wallet
calls, payment execution, or compatibility writes to legacy `actions`.

Migration and rollback instructions are in [`MIGRATION.md`](MIGRATION.md).
