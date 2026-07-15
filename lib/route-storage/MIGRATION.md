# T51 route storage migration

Migration: `lib/db/drizzle/0012_t51_route_storage.sql`

The migration was scaffolded with:

```bash
pnpm --filter @mioagent/db exec drizzle-kit generate --custom --name t51_route_storage
```

It is additive and creates only the ten route-domain tables, their explicit
`RESTRICT` foreign keys, checks, unique constraints, and indexes. It does not
alter or repurpose legacy tables. Do not apply it to production as part of T51.

For an explicitly configured disposable test database, the existing guarded
workflow applies the schema with:

```bash
NODE_ENV=test TEST_DATABASE_URL='<test-only-url>' pnpm --filter @mioagent/db push:test
```

The repository test runner already requires the project test-database guard and
a run-scoped tenant before it will use that URL.

## Rollback

Preserve any required route history before rollback. Drop only the new tables in
dependency-safe order:

```sql
DROP TABLE IF EXISTS route_proof_events;
DROP TABLE IF EXISTS route_proofs;
DROP TABLE IF EXISTS intelligence_charges;
DROP TABLE IF EXISTS execution_blueprints;
DROP TABLE IF EXISTS route_cards;
DROP TABLE IF EXISTS route_score_snapshots;
DROP TABLE IF EXISTS route_evidence_sets;
DROP TABLE IF EXISTS route_evidence;
DROP TABLE IF EXISTS route_candidates;
DROP TABLE IF EXISTS route_runs;
```

This rollback must not drop or modify `actions`,
`prepared_transaction_intents`, `spend_permissions`,
`spend_permission_proofs`, `autonomy_policies`,
`autonomy_execution_reservations`, `x402_receipts`, or `audit_logs`.
