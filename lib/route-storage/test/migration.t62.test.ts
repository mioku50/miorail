import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';

// T62: earn persistence. Additive — the only ALTERs are `ADD COLUMN goal`
// (default 'swap') + its CHECK on route_runs and execution_blueprints; the four
// earn tables are new. No swap table is recreated and no data is mutated.

const T62_TABLES = [
  'earn_route_candidates',
  'earn_route_evidence',
  'earn_score_snapshots',
  'earn_route_cards',
] as const;

const EXISTING_TABLES =
  /CREATE TABLE "(?:users|spend_permissions|route_runs|route_candidates|route_evidence|route_evidence_sets|route_score_snapshots|route_cards|execution_blueprints|route_proofs|route_proof_events|intelligence_charges|intelligence_budgets|intelligence_budget_reservations)"/;

test('T62 migration adds exactly the four earn tables and only additive ALTERs', async () => {
  const migration = await readFile(
    resolve(process.cwd(), '../db/drizzle/0014_t62_earn_storage.sql'),
    'utf8',
  );
  const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(createdTables, T62_TABLES);
  assert.doesNotMatch(migration, EXISTING_TABLES, 'must never recreate an existing table');

  // No destructive statements.
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  // Every ALTER is an additive ADD COLUMN / ADD CONSTRAINT — never DROP/RENAME.
  assert.doesNotMatch(migration, /ALTER TABLE[^;]*\b(?:DROP|RENAME|ALTER COLUMN)\b/i);
  const alters = [...migration.matchAll(/ALTER TABLE "([^"]+)" ADD (COLUMN "goal"|CONSTRAINT "[^"]*goal[^"]*")/g)];
  assert.equal(alters.length, 4, 'exactly goal column + check on route_runs and execution_blueprints');
  assert.match(migration, /ALTER TABLE "route_runs" ADD COLUMN "goal" text DEFAULT 'swap' NOT NULL;/);
  assert.match(migration, /ALTER TABLE "execution_blueprints" ADD COLUMN "goal" text DEFAULT 'swap' NOT NULL;/);

  // Every FK is fully RESTRICTed, like the rest of the route storage schema.
  const references = migration.match(/REFERENCES /g) ?? [];
  const restrictedReferences =
    migration.match(/REFERENCES [^,\n]+ ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? [];
  assert.ok(references.length > 0);
  assert.equal(restrictedReferences.length, references.length);

  // Earn candidates/evidence/scores/cards all reference route_runs (shared runs
  // table) — so the reused Blueprint/Proof tables stay consistent.
  for (const table of T62_TABLES) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(migration, /"earn_route_candidates_run_hash_unique"/);
});

test('Drizzle schema declares the four additive earn tables and the goal columns', async () => {
  const schema = await readFile(resolve(process.cwd(), '../db/schema.ts'), 'utf8');
  for (const table of T62_TABLES) {
    assert.match(schema, new RegExp(`pgTable\\(\\s*['"]${table}['"]`));
  }
  assert.match(schema, /goal: text\('goal'\)\.default\('swap'\)\.notNull\(\)/);
  assert.match(schema, /route_runs_goal_check/);
  assert.match(schema, /execution_blueprints_goal_check/);
});

test('_journal.json still registers the 0014 migration at its own index', async () => {
  // T64.2 appended 0015; 0014 keeps its slot, which is what makes the journal
  // append-only rather than rewritten.
  const journalRaw = await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8');
  const journal = JSON.parse(journalRaw) as { entries: Array<{ idx: number; tag: string }> };
  const entry = journal.entries.find((item) => item.idx === 14);
  assert.equal(entry?.tag, '0014_t62_earn_storage');
});
