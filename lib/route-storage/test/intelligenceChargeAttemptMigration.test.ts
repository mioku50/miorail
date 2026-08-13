import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

function workspaceRoot(): string {
  return process.cwd().endsWith('lib/route-storage')
    ? resolve(process.cwd(), '..', '..')
    : process.cwd();
}

test('0041 makes one external Spend Permission charge attempt a database invariant', async () => {
  const root = workspaceRoot();
  const migration = await readFile(resolve(root, 'lib/db/drizzle/0041_intelligence_charge_attempts.sql'), 'utf8');
  const runtime = await readFile(resolve(root, 'artifacts/api-server/lib/spendPermissionChargeAttempts.ts'), 'utf8');

  assert.match(migration, /CREATE TABLE "intelligence_charge_attempts"/);
  assert.match(migration, /"idempotency_key" text PRIMARY KEY/);
  assert.match(migration, /UNIQUE \("charge_id"\)/);
  assert.match(migration, /'claimed', 'settled', 'outcome_unknown'/);
  assert.match(migration, /"expected_payer" ~ '\^0x\[0-9a-f\]\{40\}\$'/);
  assert.match(migration, /intelligence_budgets_active_wallet_unique/);
  assert.match(runtime, /INSERT INTO intelligence_charge_attempts[\s\S]*ON CONFLICT DO NOTHING/);
  assert.match(runtime, /status = 'outcome_unknown'/);
});
