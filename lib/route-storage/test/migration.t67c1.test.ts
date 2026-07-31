import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  OUTCOME_ELIGIBLE_PROOF_STATUSES_V1,
  OUTCOME_PROVIDER_IDS_V1,
} from '@mioagent/route-outcomes';

// T67C.1: assertions about the SHAPE of migration 0023. The properties that
// make an outcome a reading rather than a claim are database constraints, and
// this is what checks they are still there.

async function migration(): Promise<string> {
  return readFile(
    resolve(process.cwd(), '../db/drizzle/0023_t67c1_route_outcome_feedback.sql'),
    'utf8',
  );
}

function tableBody(sql: string, table: string): string {
  return new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? '';
}

test('0023 is additive — no existing proof, card or score is touched', async () => {
  // Comments are stripped first: this file explains at length that there is no
  // update path, and the check must not trip over its own prose.
  const statements = (await migration())
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.ok(!/DROP TABLE|DELETE FROM|DROP COLUMN|ALTER COLUMN|UPDATE /i.test(statements));
});

test('one proof produces one outcome, by id AND by hash', async () => {
  // Two rows would count one trade twice, and that count is the denominator of
  // every rate built on top of it.
  const sql = await migration();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "route_provider_outcomes_proof_unique"\s+ON "route_provider_outcomes" \("proof_id"\)/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "route_provider_outcomes_proof_hash_unique"\s+ON "route_provider_outcomes" \("proof_hash"\)/,
  );
});

test('an outcome carries no calldata, response body, key or client payload', async () => {
  // The absence is the guarantee: a table with nowhere to put a provider's
  // answer cannot leak one, and nowhere to put a client's field cannot be
  // steered by a client.
  const sql = await migration();
  const table = tableBody(sql, 'route_provider_outcomes');
  for (const banned of ['calldata', 'calls', 'response', 'payload', 'api_key', 'request_body', 'signature']) {
    assert.equal(table.includes(`"${banned}"`), false, `an outcome must not carry ${banned}`);
  }
});

test('only verified terminal statuses are storable', async () => {
  // cancelled, pending, submitted_unknown and reconciliation_required are
  // excluded by construction, not by a code path that could be forgotten.
  const sql = await migration();
  const match = /route_provider_outcomes_status_check" CHECK \("proof_final_status" IN \(([^)]+)\)\)/.exec(sql);
  assert.ok(match, 'the status CHECK must be present');
  const allowed = match[1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
  assert.deepEqual([...allowed].sort(), [...OUTCOME_ELIGIBLE_PROOF_STATUSES_V1].sort());
  for (const excluded of ['cancelled', 'pending', 'submitted_unknown', 'reconciliation_required']) {
    assert.equal(allowed.includes(excluded), false, `${excluded} must not be storable`);
  }
});

test('the provider list is the V1 swap set, and matches the contract', async () => {
  const sql = await migration();
  const match = /route_provider_outcomes_provider_check" CHECK \("provider_id" IN \(([^)]+)\)\)/.exec(sql);
  assert.ok(match);
  const allowed = match[1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
  assert.deepEqual([...allowed].sort(), [...OUTCOME_PROVIDER_IDS_V1].sort());
});

test('a verified revert carries no delivered amount, shortfall or floor verdict', async () => {
  // Recording a revert as a 100% shortfall would let one bad execution move
  // two independent statistics.
  const sql = await migration();
  assert.match(sql, /route_provider_outcomes_delivery_check" CHECK \(/);
  const check = /route_provider_outcomes_delivery_check" CHECK \(([\s\S]*?)\n\t\)/.exec(sql)?.[1] ?? '';
  assert.match(check, /'failed'[\s\S]*"actual_output_atomic" IS NULL/);
  assert.match(check, /<> 'failed'[\s\S]*"actual_output_atomic" IS NOT NULL/);
});

test('a shortfall can never be stored negative', async () => {
  const sql = await migration();
  assert.match(sql, /adverse_shortfall_bps" IS NULL OR "adverse_shortfall_bps" >= 0/);
});

test('a snapshot is either fully personal or fully anonymous', async () => {
  // Half-bound would leak a tenant into a statistic other tenants read.
  const sql = await migration();
  const check = /provider_reliability_snapshots_binding_check" CHECK \(([\s\S]*?)\n\t\)/.exec(sql)?.[1] ?? '';
  assert.match(check, /'personal' AND "user_id" IS NOT NULL AND "wallet_address" IS NOT NULL/);
  assert.match(check, /'network' AND "user_id" IS NULL AND "wallet_address" IS NULL/);
});

test('an empty snapshot cannot exist and the counts must add up', async () => {
  const sql = await migration();
  assert.match(sql, /provider_reliability_snapshots_sample_check" CHECK \("sample_size" > 0\)/);
  assert.match(
    sql,
    /"completed_count" \+ "failed_count" \+ "partial_failure_count" = "sample_size"/,
  );
});

test('p90 can never be stored below the median', async () => {
  const sql = await migration();
  assert.match(sql, /"p90_adverse_shortfall_bps" >= "median_adverse_shortfall_bps"/);
});

test('membership is ordered and unique, so the set hash is recomputable', async () => {
  const sql = await migration();
  assert.match(sql, /CREATE TABLE "provider_reliability_snapshot_members"/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "provider_reliability_snapshot_members_ordinal_unique"\s+ON "provider_reliability_snapshot_members" \("snapshot_id", "ordinal"\)/,
  );
});

test('the journal records 0023 exactly once, in order', async () => {
  const journal = JSON.parse(
    await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const tags = journal.entries.map((entry) => entry.tag);
  assert.equal(tags.filter((tag) => tag === '0023_t67c1_route_outcome_feedback').length, 1);
  journal.entries.forEach((entry, index) => assert.equal(entry.idx, index));
});
