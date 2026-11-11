import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HashV1 } from '@mioagent/route-domain';

import { MemorySpendWalletStoreV1 } from './stillSpendWalletStore.js';
import { spendWalletReadyFixture, SPEND_WALLET_NOW_FIXTURE as NOW, SPEND_WALLET_OTHER_FIXTURE as OTHER, SPEND_WALLET_OWNER_FIXTURE as OWNER,
  SPEND_WALLET_TX_FIXTURE as HASH } from './stillSpendWalletTestFixtures.js';

// One row per invoice and wallet: prepared again in place while ready, armed
// once, and never prepared or armed again once it left ready. Synthetic only.
const ORDER = '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34';
const repo = (file: string) => process.cwd().endsWith(`${path.sep}artifacts${path.sep}api-server`) ? path.join(process.cwd(), '../..', file) : path.join(process.cwd(), file);

const run = (patch: { payTo?: string; assets?: string; terms?: string; orderId?: string } = {}) => spendWalletReadyFixture(patch.orderId ?? ORDER, patch);
async function armedStore() {
  const store = new MemorySpendWalletStoreV1(), ready = run();
  await store.putReady({ owner: OWNER, run: ready, now: NOW });
  const arm = await store.arm({ owner: OWNER, orderId: ORDER, callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash, now: NOW });
  if (!arm.ok) throw new Error('not armed');
  return { store, attemptId: arm.attemptId };
}

describe('a wallet payment’s record', () => {
  it('is one row per invoice, prepared again in place, and never for another address or amount', async () => {
    const store = new MemorySpendWalletStoreV1();
    const first = await store.putReady({ owner: OWNER, run: run(), now: NOW });
    const again = await store.putReady({ owner: OWNER, run: run({ terms: `0x${'55'.repeat(32)}` }), now: NOW });
    assert.deepEqual([again.paymentId, again.version, again.run.signingTermsHash], [first.paymentId, 1, `0x${'55'.repeat(32)}`]);
    await assert.rejects(store.putReady({ owner: OWNER, run: run({ payTo: '0x4444444444444444444444444444444444444444' }), now: NOW }), /question_changed/);
    await assert.rejects(store.putReady({ owner: OWNER, run: run({ assets: '2000001' }), now: NOW }), /question_changed/);
    // Another wallet, or a malformed invoice id or call, is never this row.
    assert.equal(await store.get({ owner: { walletAddress: OTHER, tenantId: `eip155:8453:${OTHER}` }, orderId: ORDER }), null);
    await assert.rejects(store.putReady({ owner: OWNER, run: run({ orderId: 'not-an-invoice' }), now: NOW }), /ready_invalid/);
    await assert.rejects(store.putReady({ owner: OWNER, run: { ...run(), callsHash: `0x${'00'.repeat(32)}` as HashV1 }, now: NOW }), /ready_invalid/);
  });

  it('arms one exact review once across simultaneous presses, and not after it expired', async () => {
    const store = new MemorySpendWalletStoreV1(), ready = run();
    await store.putReady({ owner: OWNER, run: ready, now: NOW });
    const arm = (at = NOW) => store.arm({ owner: OWNER, orderId: ORDER, callsHash: ready.callsHash, signingTermsHash: ready.signingTermsHash, now: at });
    assert.deepEqual(await store.arm({ owner: OWNER, orderId: ORDER, callsHash: ready.callsHash, signingTermsHash: `0x${'66'.repeat(32)}`, now: NOW }), { ok: false, refusal: 'payment_not_ready' });
    assert.deepEqual(await arm(new Date(NOW.getTime() + 120_000)), { ok: false, refusal: 'payment_not_ready' });
    const results = await Promise.all([arm(), arm(), arm()]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    // Once armed, preparing again returns it as it is.
    assert.equal((await store.putReady({ owner: OWNER, run: run({ terms: `0x${'77'.repeat(32)}` }), now: NOW })).state, 'awaiting_wallet');
  });

  it('a decline returns it to ready; a sent payment keeps its first answer, and two answers stay unknown', async () => {
    const declined = await armedStore();
    assert.equal((await declined.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: declined.attemptId, outcome: 'rejected', now: NOW }))?.state, 'ready');

    const sent = await armedStore();
    const first = await sent.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: sent.attemptId, outcome: 'submitted', transactionHash: HASH, now: NOW });
    assert.deepEqual([first?.state, first?.transactionHash], ['submitted', HASH]);
    assert.equal(await sent.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: sent.attemptId, outcome: 'rejected', now: NOW }), null);
    const late = await sent.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: sent.attemptId, outcome: 'unknown', now: NOW });
    assert.deepEqual([late?.state, late?.transactionHash], ['submitted', HASH]);
    const other = await sent.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: sent.attemptId, outcome: 'submitted', transactionHash: `0x${'cd'.repeat(32)}` as HashV1, now: NOW });
    assert.deepEqual([other?.state, other?.errorCode], ['unknown', 'conflicting_wallet_answers']);
    await assert.rejects(sent.store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId: sent.attemptId, outcome: 'submitted', now: NOW }), /submission_invalid/);
  });

  it('records a result only on the version it read', async () => {
    const { store, attemptId } = await armedStore();
    const sent = await store.recordSubmission({ owner: OWNER, orderId: ORDER, attemptId, outcome: 'submitted', transactionHash: HASH, now: NOW });
    const proof = { receiptFingerprint: '0x1' };
    assert.equal(await store.recordVerification({ owner: OWNER, orderId: ORDER, expectedVersion: sent!.version - 1, state: 'confirmed', transactionHash: HASH, proof, errorCode: null, now: NOW }), null);
    assert.equal((await store.recordVerification({ owner: OWNER, orderId: ORDER, expectedVersion: sent!.version, state: 'confirmed', transactionHash: HASH, proof, errorCode: null, now: NOW }))?.state, 'confirmed');
    await assert.rejects(store.recordVerification({ owner: OWNER, orderId: ORDER, expectedVersion: sent!.version + 1, state: 'confirmed', transactionHash: null, proof, errorCode: null, now: NOW }), /verification_invalid/);
  });

  it('is held by its table to one row per invoice and wallet, bound to the run it stores', () => {
    const migration = readFileSync(repo('lib/db/drizzle/0095_spend_wallet_payments.sql'), 'utf8');
    assert.match(migration, /UNIQUE \(tenant_id, wallet_address, order_id\)/);
    assert.match(migration, /'facts', jsonb_build_object\('payment', jsonb_build_object\('orderId', order_id\)\)/);
    assert.match(migration, /ALTER TABLE spend_wallet_payments OWNER TO miorail_user;/);
    const journal = JSON.parse(readFileSync(repo('lib/db/drizzle/meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((row) => row.tag === '0095_spend_wallet_payments');
    assert.deepEqual(entry, { ...entry, idx: 95, tag: '0095_spend_wallet_payments' });
  });
});
