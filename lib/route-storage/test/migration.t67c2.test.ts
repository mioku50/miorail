import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { RECOVERABLE_ATTEMPT_STATUSES_V1, SubmissionAttemptStatusV1Schema } from '@mioagent/route-domain';

// T67C.2: assertions about the SHAPE of migration 0022, so schema drift is
// caught before Postgres ever sees it. The two rules this feature rests on are
// database guarantees, not application logic, and that is what these check.

async function migration(): Promise<string> {
  return readFile(resolve(process.cwd(), '../db/drizzle/0022_t67c2_submission_recovery.sql'), 'utf8');
}

test('0022 is additive — nothing is dropped or deleted', async () => {
  const sql = await migration();
  assert.ok(!/DROP TABLE|DELETE FROM|DROP COLUMN|ALTER COLUMN/i.test(sql));
});

test('one wallet batch belongs to exactly one attempt', async () => {
  // Two attempts claiming one batch would make "which route did this
  // transaction execute?" ambiguous, and that question has one answer.
  const sql = await migration();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "submission_attempts_batch_unique"\s+ON "submission_attempts" \("batch_id"\) WHERE "batch_id" IS NOT NULL/,
  );
});

test('one blueprint has at most one attempt in flight, and terminal ones free it', async () => {
  const sql = await migration();
  const match = /CREATE UNIQUE INDEX "submission_attempts_active_unique"[\s\S]*?WHERE "status" IN \(([^)]+)\)/.exec(sql);
  assert.ok(match, 'the active-unique index must be present');
  const indexed = match[1]!.split(',').map((value) => value.trim().replace(/'/g, ''));
  // The SQL predicate and the contract's notion of "still open" must be the
  // same set: drift shows up as an attempt the UI offers to resume and the
  // query never returns.
  assert.deepEqual([...indexed].sort(), [...RECOVERABLE_ATTEMPT_STATUSES_V1].sort());
});

test('the status CHECK matches the contract exactly', async () => {
  const sql = await migration();
  const match = /submission_attempts_status_check" CHECK \("status" IN \(([\s\S]*?)\)\)/.exec(sql);
  assert.ok(match, 'the status CHECK must be present');
  const allowed = match[1]!
    .split(',')
    .map((value) => value.trim().replace(/'/g, ''))
    .filter(Boolean);
  assert.deepEqual([...allowed].sort(), [...SubmissionAttemptStatusV1Schema.options].sort());
});

test('a state that presupposes a batch cannot exist without one', async () => {
  const sql = await migration();
  assert.match(sql, /submission_attempts_batch_presence_check" CHECK \(/);
  for (const status of ['batch_observed', 'submitted', 'submitted_unknown', 'confirmed']) {
    assert.ok(
      new RegExp(`submission_attempts_batch_presence_check[\\s\\S]*?'${status}'`).test(sql),
      `${status} must require a batch id`,
    );
  }
});

test('an attempt carries no receipt, transaction hash, calldata or amount', async () => {
  // The absence is the guarantee: a table with nowhere to put onchain evidence
  // cannot be read as evidence of an execution it never witnessed.
  const sql = await migration();
  const table = /CREATE TABLE "submission_attempts" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
  for (const banned of ['receipt', 'transaction_hash', 'calldata', 'calls', 'amount', 'value']) {
    assert.equal(table.includes(`"${banned}"`), false, `submission_attempts must not carry ${banned}`);
  }
});

test('one live share per proof, and a revoked id is never reissued', async () => {
  const sql = await migration();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "public_proof_shares_active_unique"\s+ON "public_proof_shares" \("proof_family", "proof_id"\) WHERE "revoked_at" IS NULL/,
  );
  // 24 random bytes as hex. Enumeration is the obvious attack on a link that
  // opens without a login, so the column shape refuses anything shorter.
  assert.match(sql, /public_proof_shares_id_check" CHECK \("public_id" ~ '\^\[0-9a-f\]\{48,\}\$'\)/);
});

test('a share holds no proof content, so revoking removes access and nothing else', async () => {
  const sql = await migration();
  const table = /CREATE TABLE "public_proof_shares" \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
  for (const banned of ['payload', 'bundle', 'proof_hash', 'receipts']) {
    assert.equal(table.includes(`"${banned}"`), false, `public_proof_shares must not copy ${banned}`);
  }
});

test('the journal records 0022 exactly once, in order', async () => {
  const journal = JSON.parse(
    await readFile(resolve(process.cwd(), '../db/drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const tags = journal.entries.map((entry) => entry.tag);
  assert.equal(tags.filter((tag) => tag === '0022_t67c2_submission_recovery').length, 1);
  // Append-only: idx must equal position.
  journal.entries.forEach((entry, index) => assert.equal(entry.idx, index));
});
