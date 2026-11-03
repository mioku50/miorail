import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it, test } from 'node:test';
import postgres from 'postgres';
import { assertSafeTestDatabaseEnvironment } from './testDatabaseGuard.js';
import { createDatabaseSpendWalletStoreV1, type SpendWalletStoreV1 } from '../../artifacts/api-server/lib/stillSpendWalletStore.js';
import { spendWalletReadyFixture as run, SPEND_WALLET_NOW_FIXTURE as NOW, SPEND_WALLET_OTHER_FIXTURE as OTHER, SPEND_WALLET_OWNER_FIXTURE as OWNER,
  SPEND_WALLET_TX_FIXTURE as HASH, SPEND_WALLET_FIXTURE as WALLET } from '../../artifacts/api-server/lib/stillSpendWalletTestFixtures.js';

// Still Spend paid from the wallet's own USDC: the store's SQL against a real
// PostgreSQL, in a temporary schema. Every row here is synthetic.
const migrationUrl = resolve(process.cwd(), process.cwd().endsWith('lib/db') ? 'drizzle/0095_spend_wallet_payments.sql' : 'lib/db/drizzle/0095_spend_wallet_payments.sql');

test('migration0095 holds a wallet payment to its owner, its invoice and the run it stores', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /tenant_id = 'eip155:8453:' \|\| wallet_address/);
  assert.match(sql, /UNIQUE \(tenant_id, wallet_address, order_id\)/);
  assert.match(sql, /spend_wallet_payment_run_binding CHECK \(run_json @> jsonb_build_object/);
  assert.match(sql, /ALTER TABLE spend_wallet_payments OWNER TO miorail_user/);
});

const enabled = process.env.MIOAGENT_TEST_SUITE === 'db' && Boolean(process.env.TEST_DATABASE_URL);
describe('wallet payment SQL in an isolated temporary schema', { skip: !enabled }, () => {
  const schema = `spend_test_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  let store: SpendWalletStoreV1;
  before(async () => {
    const safe = assertSafeTestDatabaseEnvironment(process.env);
    assert.equal(safe.source, 'TEST_DATABASE_URL');
    admin = postgres(safe.url!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = postgres(safe.url!, { max: 4, prepare: false, connection: { search_path: schema }, onnotice: () => {} });
    await sql.unsafe('CREATE TABLE users (id text PRIMARY KEY)');
    await sql`INSERT INTO users (id) VALUES (${OWNER.tenantId}), (${`eip155:8453:${OTHER}`})`;
    const migration = (await readFile(migrationUrl, 'utf8')).replaceAll('--> statement-breakpoint', '').replace('ALTER TABLE spend_wallet_payments OWNER TO miorail_user;', '');
    await sql.unsafe(migration);
    store = createDatabaseSpendWalletStoreV1(async (strings, ...values) => await sql(strings, ...(values as never[])) as unknown as Record<string, unknown>[]);
  });
  after(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin) { await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`); await admin.end({ timeout: 5 }); }
  });

  it('prepares one row per invoice again in place, and refuses another address for it', async () => {
    const order = randomUUID();
    const first = await store.putReady({ owner: OWNER, run: run(order), now: NOW });
    const again = await store.putReady({ owner: OWNER, run: run(order, { terms: `0x${'55'.repeat(32)}` }), now: NOW });
    assert.deepEqual([again.paymentId, again.version, again.run.signingTermsHash], [first.paymentId, 1, `0x${'55'.repeat(32)}`]);
    await assert.rejects(store.putReady({ owner: OWNER, run: run(order, { payTo: '0x4444444444444444444444444444444444444444' }), now: NOW }), /question_changed/);
    assert.equal(await store.get({ owner: { walletAddress: OTHER, tenantId: `eip155:8453:${OTHER}` }, orderId: order }), null);
  });

  it('arms once across simultaneous presses, and a decline returns it to ready', async () => {
    const order = randomUUID(), ready = run(order);
    await store.putReady({ owner: OWNER, run: ready, now: NOW });
    const arms = await Promise.all([1, 2, 3].map(() => store.arm({ owner: OWNER, orderId: order, callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash, now: NOW })));
    assert.equal(arms.filter((arm) => arm.ok).length, 1);
    const winner = arms.find((arm) => arm.ok)!; assert(winner.ok);
    assert.equal((await store.putReady({ owner: OWNER, run: run(order, { terms: `0x${'66'.repeat(32)}` }), now: NOW })).state, 'awaiting_wallet');
    const declined = await store.recordSubmission({ owner: OWNER, orderId: order, attemptId: winner.attemptId, outcome: 'rejected', now: NOW });
    assert.deepEqual([declined?.state, declined?.attemptId], ['ready', null]);
  });

  it('keeps the wallet’s first answer, turns two different answers unknown, and records a result only on the version it read', async () => {
    const order = randomUUID(), ready = run(order);
    await store.putReady({ owner: OWNER, run: ready, now: NOW });
    const arm = await store.arm({ owner: OWNER, orderId: order, callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash, now: NOW }); assert(arm.ok);
    const sent = await store.recordSubmission({ owner: OWNER, orderId: order, attemptId: arm.attemptId, outcome: 'submitted', transactionHash: HASH, now: NOW });
    assert.deepEqual([sent?.state, sent?.transactionHash], ['submitted', HASH]);
    const late = await store.recordSubmission({ owner: OWNER, orderId: order, attemptId: arm.attemptId, outcome: 'unknown', now: NOW });
    assert.deepEqual([late?.state, late?.transactionHash], ['submitted', HASH]);
    assert.equal(await store.recordSubmission({ owner: OWNER, orderId: order, attemptId: arm.attemptId, outcome: 'rejected', now: NOW }), null);
    assert.equal(await store.recordVerification({ owner: OWNER, orderId: order, expectedVersion: late!.version - 1, state: 'confirmed', transactionHash: HASH, proof: { fixture: true }, errorCode: null, now: NOW }), null);
    const confirmed = await store.recordVerification({ owner: OWNER, orderId: order, expectedVersion: late!.version, state: 'confirmed', transactionHash: HASH, proof: { fixture: true }, errorCode: null, now: NOW });
    assert.deepEqual([confirmed?.state, confirmed?.verification], ['confirmed', { fixture: true }]);

    const other = randomUUID(), next = run(other);
    await store.putReady({ owner: OWNER, run: next, now: NOW });
    const armed = await store.arm({ owner: OWNER, orderId: other, callsHash: next.callsHash, signingTermsHash: next.signingTermsHash, now: NOW }); assert(armed.ok);
    await store.recordSubmission({ owner: OWNER, orderId: other, attemptId: armed.attemptId, outcome: 'submitted', batchId: 'batch-1', now: NOW });
    const conflicting = await store.recordSubmission({ owner: OWNER, orderId: other, attemptId: armed.attemptId, outcome: 'submitted', batchId: 'batch-2', now: NOW });
    assert.deepEqual([conflicting?.state, conflicting?.errorCode, conflicting?.batchId], ['unknown', 'conflicting_wallet_answers', 'batch-1']);
  });

  it('refuses a row whose run names another invoice, or a confirmed one without its proof', async () => {
    const order = randomUUID();
    await assert.rejects(sql`INSERT INTO spend_wallet_payments (payment_id, tenant_id, wallet_address, order_id, calls_hash, run_json, state, created_at, updated_at, expires_at)
      VALUES (${randomUUID()}, ${OWNER.tenantId}, ${WALLET}, ${order}, ${run(order).callsHash}, ${JSON.stringify(run(randomUUID()))}::text::jsonb, 'ready', now(), now(), now())`, /spend_wallet_payment_run_binding/);
    await assert.rejects(sql`INSERT INTO spend_wallet_payments (payment_id, tenant_id, wallet_address, order_id, calls_hash, run_json, state, attempt_id, created_at, updated_at, expires_at)
      VALUES (${randomUUID()}, ${OWNER.tenantId}, ${WALLET}, ${order}, ${run(order).callsHash}, ${JSON.stringify(run(order))}::text::jsonb, 'confirmed', ${randomUUID()}, now(), now(), now())`, /spend_wallet_payment_verified/);
  });
});
