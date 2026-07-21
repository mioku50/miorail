import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';

const T60_TABLES = ['intelligence_budgets', 'intelligence_budget_reservations'] as const;

test('T60 migration is additive and contains only the two new Intelligence Budget tables', async () => {
  const migration = await readFile(
    resolve(process.cwd(), '../db/drizzle/0013_t60_intelligence_budget.sql'),
    'utf8',
  );
  const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(createdTables, T60_TABLES);
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.doesNotMatch(migration, /ALTER TABLE/i);
  assert.doesNotMatch(
    migration,
    /CREATE TABLE "(?:users|spend_permissions|spend_permission_proofs|route_runs|route_candidates|route_evidence|route_evidence_sets|route_score_snapshots|route_cards|execution_blueprints|route_proofs|route_proof_events|intelligence_charges|autonomy_policies|autonomy_execution_reservations|x402_receipts|audit_logs|prepared_transaction_intents)"/,
  );

  const references = migration.match(/REFERENCES /g) ?? [];
  const restrictedReferences =
    migration.match(/REFERENCES [^,\n]+ ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? [];
  assert.ok(references.length > 0);
  assert.equal(restrictedReferences.length, references.length);

  // Every reservation amount and budget limit/spend column is a base-unit
  // integer (numeric(78,0)) — never a decimal, never a JS-number-range float.
  assert.match(migration, /"period_limit_atomic" numeric\(78, 0\) NOT NULL/);
  assert.match(migration, /"period_spent_atomic" numeric\(78, 0\) DEFAULT '0' NOT NULL/);
  assert.match(migration, /"reserved_atomic" numeric\(78, 0\) DEFAULT '0' NOT NULL/);
  assert.match(migration, /"max_per_call_atomic" numeric\(78, 0\) NOT NULL/);
  assert.match(migration, /"amount_atomic" numeric\(78, 0\) NOT NULL/);

  // The one-active-budget-per-permission invariant is a partial unique index.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "intelligence_budgets_active_permission_unique" ON "intelligence_budgets" USING btree \("spend_permission_id"\) WHERE "intelligence_budgets"\."status" = 'active';/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "intelligence_budget_reservations_idempotency_key_unique" ON "intelligence_budget_reservations" USING btree \("idempotency_key"\);/,
  );
});

test('Drizzle schema declares both additive Intelligence Budget tables', async () => {
  const schema = await readFile(resolve(process.cwd(), '../db/schema.ts'), 'utf8');
  for (const table of T60_TABLES) {
    assert.match(schema, new RegExp(`pgTable\\(\\s*['"]${table}['"]`));
  }
});

test('_journal.json registers the 0013 migration at idx 13', async () => {
  const journalRaw = await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8');
  const journal = JSON.parse(journalRaw) as { entries: Array<{ idx: number; tag: string }> };
  // Later migrations (T62 → 0014) may follow; assert 0013 is registered, not last.
  const entry = journal.entries.find((candidate) => candidate.idx === 13);
  assert.equal(entry?.tag, '0013_t60_intelligence_budget');
});
