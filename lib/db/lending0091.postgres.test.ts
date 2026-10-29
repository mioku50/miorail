import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import postgres from 'postgres';
import { assertSafeTestDatabaseEnvironment } from './testDatabaseGuard.js';
import { createDatabaseLoanExecutionStoreV1, type LoanExecutionStoreV1 } from '../../artifacts/api-server/lib/loanExecutionStore.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_OTHER_WALLET_FIXTURE as OTHER, LOAN_NOW_FIXTURE as NOW, LOAN_TX_FIXTURE as TX } from '../../artifacts/api-server/lib/loanExecutionTestFixtures.js';

const migrationUrl = resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle/0091_lending_executions.sql' : 'lib/db/drizzle/0091_lending_executions.sql');
test('migration0091 makes ownership, run identity and one active market attempt database constraints', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /tenant_id = 'eip155:8453:' \|\| wallet_address/);
  assert.match(sql, /UNIQUE \(tenant_id, wallet_address, draft_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS lending_execution_active_market/);
  assert.match(sql, /WHERE state IN \('awaiting_wallet', 'submitted', 'unknown'\)/);
  assert.match(sql, /CASE WHEN venue = 'aave-v4' THEN 'aave-v4' ELSE market_id END/);
  assert.match(sql, /lending_execution_run_binding CHECK \(run_json @> jsonb_build_object/);
  assert.match(sql, /ALTER TABLE lending_executions OWNER TO miorail_user/);
});

const enabled = process.env.MIOAGENT_TEST_SUITE === 'db' && Boolean(process.env.TEST_DATABASE_URL);
describe('lending execution SQL races in an isolated temporary schema', { skip: !enabled }, () => {
  const schema = `lending_test_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  let store: LoanExecutionStoreV1;
  before(async () => {
    // The normal project guard refuses production identity and forbids a
    // DATABASE_URL fallback. No .env loader is imported or evaluated here.
    const safe = assertSafeTestDatabaseEnvironment(process.env);
    assert.equal(safe.source, 'TEST_DATABASE_URL');
    admin = postgres(safe.url!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = postgres(safe.url!, { max: 4, prepare: false, connection: { search_path: schema }, onnotice: () => {} });
    await sql.unsafe('CREATE TABLE users (id text PRIMARY KEY)');
    await sql`INSERT INTO users (id) VALUES (${OWNER.tenantId}), (${`eip155:8453:${OTHER}`})`;
    // Only this randomly named schema is affected. Table-owner syntax is
    // separately checked above; changing ownership in a temp schema would
    // require privileges irrelevant to the CAS/unique-index behavior tested.
    const migration = (await readFile(migrationUrl, 'utf8')).replaceAll('--> statement-breakpoint', '').replace('ALTER TABLE lending_executions OWNER TO miorail_user;', '');
    await sql.unsafe(migration);
    const execute: Parameters<typeof createDatabaseLoanExecutionStoreV1>[0] = async (strings, ...values) =>
      await sql(strings, ...(values as never[])) as unknown as Record<string, unknown>[];
    store = createDatabaseLoanExecutionStoreV1(execute);
  });
  after(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin) { await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end({ timeout: 5 }); }
  });
  const create = (draftId: string) => store.putReady({ owner: OWNER, draftId, run: loanReadyFixture(), now: NOW });
  it('two concurrent requests cannot arm different drafts for one market', async () => {
    const a = await create('db-race-a'), b = await create('db-race-b');
    const outcomes = await Promise.all([a, b].map(row => store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW })));
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    assert.equal(outcomes.filter(result => !result.ok && result.refusal === 'execution_active').length, 1);
    const winner = outcomes.find(result => result.ok)!; assert(winner.ok);
    await store.recordSubmission({ owner: OWNER, executionId: winner.execution.executionId, attemptId: winner.attemptId, outcome: 'rejected', now: NOW });
  });
  it('the same execution has only one winning arm and keeps active review bytes immutable', async () => {
    const row = await create('db-one-arm');
    const outcomes = await Promise.all([1, 2].map(() => store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW })));
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    const winner = outcomes.find(result => result.ok)!; assert(winner.ok);
    const changed = loanReadyFixture(); changed.facts.debtBeforeAssets = '999';
    const existing = await store.putReady({ owner: OWNER, draftId: row.draftId, run: changed, now: NOW });
    assert.equal(existing.run.facts.debtBeforeAssets, row.run.facts.debtBeforeAssets);
    await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: winner.attemptId, outcome: 'rejected', now: NOW });
  });
  it('unknown remains locked and cannot be erased by a late rejection or another owner', async () => {
    const row = await create('db-unknown');
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    const record = await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'unknown', now: NOW }); assert.equal(record!.state, 'unknown');
    assert.equal(await store.recordSubmission({ owner: OWNER, executionId: row.executionId, attemptId: armed.attemptId, outcome: 'rejected', now: NOW }), null);
    assert.equal(await store.get({ owner: { walletAddress: OTHER, tenantId: `eip155:8453:${OTHER}` }, executionId: row.executionId }), null);
    const next = await create('db-after-unknown');
    assert.equal((await store.arm({ owner: OWNER, executionId: next.executionId, callsHash: next.run.callsHash, signingTermsHash: next.run.signingTermsHash, now: NOW })).ok, false);
    // Release only through synthetic independent-chain proof, not browser data.
    await store.recordVerification({ owner: OWNER, executionId: row.executionId, expectedVersion: record!.version, state: 'failed', transactionHash: TX, proof: { fixtureExactOperationReverted: true }, errorCode: 'loan_operation_reverted', now: NOW });
  });
  it('verification CAS lets only one concurrent projection win', async () => {
    const row = await create('db-verification-cas');
    const armed = await store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW }); assert(armed.ok);
    const input = { owner: OWNER, executionId: row.executionId, expectedVersion: armed.execution.version, state: 'confirmed' as const, transactionHash: TX, proof: { fixtureVerifiedEffects: true }, errorCode: null, now: NOW };
    const results = await Promise.all([store.recordVerification(input), store.recordVerification(input)]);
    assert.equal(results.filter(Boolean).length, 1);
  });
  it('the SQL arm also binds measured terms when an unchanged call list was reviewed in another tab', async () => {
    const first = await create('db-stale-terms'); const fresh = loanReadyFixture(); fresh.facts.debtAfterAssets = '1100000'; fresh.signingTermsHash = `0x${'8'.repeat(64)}`;
    const updated = await store.putReady({ owner: OWNER, draftId: first.draftId, run: fresh, now: NOW });
    assert.equal((await store.arm({ owner: OWNER, executionId: first.executionId, callsHash: first.run.callsHash, signingTermsHash: first.run.signingTermsHash, now: NOW })).ok, false);
    const result = await store.arm({ owner: OWNER, executionId: updated.executionId, callsHash: updated.run.callsHash, signingTermsHash: updated.run.signingTermsHash, now: NOW }); assert(result.ok);
    await store.recordSubmission({ owner: OWNER, executionId: updated.executionId, attemptId: result.attemptId, outcome: 'rejected', now: NOW });
  });
  it('Aave reviews for different stock reserves share one database lock', async () => {
    const make = async (symbol: string) => { const run = loanReadyFixture(); run.facts.venue = 'aave-v4'; run.facts.marketId = `aave-v4:${symbol}`;
      return store.putReady({ owner: OWNER, draftId: `db-aave-${symbol}`, run, now: NOW }); };
    const a = await make('NVDAc'), b = await make('AAPLc');
    const results = await Promise.all([a, b].map(row => store.arm({ owner: OWNER, executionId: row.executionId, callsHash: row.run.callsHash, signingTermsHash: row.run.signingTermsHash, now: NOW })));
    assert.equal(results.filter(result => result.ok).length, 1); const winner = results.find(result => result.ok)!; assert(winner.ok);
    await store.recordSubmission({ owner: OWNER, executionId: winner.execution.executionId, attemptId: winner.attemptId, outcome: 'rejected', now: NOW });
  });
});
