import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';

const ROUTE_TABLES = [
  'route_runs',
  'route_candidates',
  'route_evidence',
  'route_evidence_sets',
  'route_score_snapshots',
  'route_cards',
  'execution_blueprints',
  'route_proofs',
  'route_proof_events',
  'intelligence_charges',
] as const;

test('T51 migration is additive and contains only route-domain DDL', async () => {
  const migration = await readFile(
    resolve(process.cwd(), '../db/drizzle/0012_t51_route_storage.sql'),
    'utf8',
  );
  const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(createdTables, ROUTE_TABLES);
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.doesNotMatch(migration, /ALTER TABLE/i);
  assert.doesNotMatch(
    migration,
    /CREATE TABLE "(?:actions|prepared_transaction_intents|spend_permissions|spend_permission_proofs|autonomy_policies|autonomy_execution_reservations|x402_receipts|audit_logs)"/,
  );

  const references = migration.match(/REFERENCES /g) ?? [];
  const restrictedReferences =
    migration.match(/REFERENCES [^,\n]+ ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? [];
  assert.ok(references.length > 0);
  assert.equal(restrictedReferences.length, references.length);
});

test('Drizzle schema declares every additive route-domain table', async () => {
  const schema = await readFile(resolve(process.cwd(), '../db/schema.ts'), 'utf8');
  for (const table of ROUTE_TABLES) {
    assert.match(schema, new RegExp(`pgTable\\(\\s*['"]${table}['"]`));
  }
});
