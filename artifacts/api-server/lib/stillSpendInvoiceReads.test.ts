import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SpendCheckoutResultV1, SpendInvoiceStatusNameV1, SpendInvoiceStatusV1 } from '@mioagent/commerce-engine';

import { createSpendInvoiceReadsV1 } from './stillSpendInvoiceReads.js';

// Audit SPEND-2 (2026-11-10): a page waiting for a delivery must not spend the
// window everyone buys through. Every Bitrefill answer here is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222';
const ORDER = { orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', accessToken: 'access-token-0123456789' };
const SECOND = { orderId: '11111111-2222-4333-8444-555555555555', accessToken: 'access-token-9876543210' };
const status = (name: SpendInvoiceStatusNameV1): SpendInvoiceStatusV1 => ({ status: name, accessLink: null, esimInstallLink: null });

function bitrefill(first: SpendInvoiceStatusNameV1 = 'payment_detected') {
  const state = { answer: { ok: true, value: status(first) } as SpendCheckoutResultV1<SpendInvoiceStatusV1>, asked: [] as string[] };
  const checkout = {
    readInvoice: async (input: { invoiceId: string }, options?: { purpose?: 'display' | 'payment' }) => {
      state.asked.push(`${options?.purpose ?? 'payment'} ${input.invoiceId}`);
      return state.answer;
    },
  };
  return { state, checkout };
}

describe('Bitrefill’s word for an invoice, as a page shows it', () => {
  it('asks once per order in fifteen seconds, whoever asks, from the ordinary part of the window', async () => {
    let at = Date.parse('2026-11-11T12:00:00Z');
    const { state, checkout } = bitrefill();
    const reads = createSpendInvoiceReadsV1({ now: () => at });
    const first = await reads.display({ wallet: WALLET, order: ORDER, checkout });
    assert.deepEqual(first, { status: status('payment_detected'), readAt: '2026-11-11T12:00:00.000Z', error: null });
    state.answer = { ok: true, value: status('complete') };
    at += 14_999;
    assert.deepEqual(await reads.display({ wallet: WALLET, order: ORDER, checkout }), first);
    assert.deepEqual(state.asked, [`display ${ORDER.orderId}`]);
    at += 1;
    const second = await reads.display({ wallet: WALLET, order: ORDER, checkout });
    assert.deepEqual(second, { status: status('complete'), readAt: '2026-11-11T12:00:15.000Z', error: null });
    assert.deepEqual(state.asked, [`display ${ORDER.orderId}`, `display ${ORDER.orderId}`]);
  });

  it('answers everyone asking at the same moment from one read', async () => {
    const { state, checkout } = bitrefill();
    const reads = createSpendInvoiceReadsV1();
    const answers = await Promise.all(Array.from({ length: 12 }, () => reads.display({ wallet: WALLET, order: ORDER, checkout })));
    assert.equal(state.asked.length, 1);
    assert.ok(answers.every((answer) => answer.status?.status === 'payment_detected' && answer.error === null));
  });

  it('keeps the last reading, with its time and the reason, when Bitrefill cannot be asked', async () => {
    let at = Date.parse('2026-11-11T12:00:00Z');
    const { state, checkout } = bitrefill('pending');
    const reads = createSpendInvoiceReadsV1({ now: () => at });
    await reads.display({ wallet: WALLET, order: ORDER, checkout });
    at += 20_000;
    state.answer = { ok: false, reason: 'bitrefill_rate_limited' };
    assert.deepEqual(await reads.display({ wallet: WALLET, order: ORDER, checkout }),
      { status: status('pending'), readAt: '2026-11-11T12:00:00.000Z', error: 'bitrefill_rate_limited' });
    // A failure is never kept: the next ask goes to Bitrefill again.
    state.answer = { ok: true, value: status('complete') };
    assert.deepEqual(await reads.display({ wallet: WALLET, order: ORDER, checkout }),
      { status: status('complete'), readAt: '2026-11-11T12:00:20.000Z', error: null });
    // Nothing was ever read: nothing is claimed.
    state.answer = { ok: false, reason: 'bitrefill_unreachable' };
    assert.deepEqual(await reads.display({ wallet: WALLET, order: SECOND, checkout }), { status: null, readAt: null, error: 'bitrefill_unreachable' });
    // A thrown read is Bitrefill not answering, never a crash of the page's request.
    const thrown = await reads.display({ wallet: OTHER, order: SECOND, checkout: { readInvoice: async () => { throw new Error('socket'); } } });
    assert.equal(thrown.error, 'bitrefill_unreachable');
  });

  it('asks Bitrefill four times a minute for one wallet at most, and another wallet has its own four', async () => {
    let at = Date.parse('2026-11-11T12:00:00Z');
    const { state, checkout } = bitrefill();
    // No reading is kept at all, so every ask would reach Bitrefill but for the wallet's own limit.
    const reads = createSpendInvoiceReadsV1({ now: () => at, displayTtlMs: 0 });
    for (let index = 0; index < 4; index++) {
      at += 1;
      assert.equal((await reads.display({ wallet: WALLET, order: ORDER, checkout })).error, null);
    }
    at += 1;
    const fifth = await reads.display({ wallet: WALLET, order: ORDER, checkout });
    assert.deepEqual([fifth.status?.status, fifth.error], ['payment_detected', 'bitrefill_rate_limited']);
    assert.equal(state.asked.length, 4);
    assert.equal((await reads.display({ wallet: OTHER, order: SECOND, checkout })).error, null);
    assert.equal(state.asked.length, 5);
  });

  it('holds a bounded number of readings', async () => {
    const { checkout } = bitrefill();
    const reads = createSpendInvoiceReadsV1({ max: 3, displayPerMinute: 100 });
    const orders = Array.from({ length: 5 }, (_, index) => ({ orderId: `0000000${index}-2222-4333-8444-555555555555`, accessToken: ORDER.accessToken }));
    for (const order of orders) await reads.display({ wallet: WALLET, order, checkout });
    const silent = { readInvoice: async () => ({ ok: false as const, reason: 'bitrefill_unreachable' as const }) };
    // The two oldest were dropped; the three newest still stand.
    assert.equal((await reads.display({ wallet: WALLET, order: orders[4]!, checkout: silent })).status?.status, 'payment_detected');
    assert.equal((await reads.display({ wallet: WALLET, order: orders[0]!, checkout: silent })).status, null);
  });
});

describe('Bitrefill’s word for an invoice, before it is paid', () => {
  it('is always Bitrefill’s own answer, never a kept one, and the page then shows it', async () => {
    const { state, checkout } = bitrefill('unpaid');
    const reads = createSpendInvoiceReadsV1();
    await reads.display({ wallet: WALLET, order: ORDER, checkout });
    state.answer = { ok: true, value: status('payment_detected') };
    const paying = await reads.payment({ wallet: WALLET, order: ORDER, checkout });
    assert.deepEqual(paying, { ok: true, value: status('payment_detected') });
    assert.deepEqual(state.asked, [`display ${ORDER.orderId}`, `payment ${ORDER.orderId}`]);
    // What the payment check learned is what the page shows next, without another call.
    assert.equal((await reads.display({ wallet: WALLET, order: ORDER, checkout })).status?.status, 'payment_detected');
    assert.equal(state.asked.length, 2);
  });

  it('is asked three times a minute for one wallet at most, so one wallet cannot spend what is kept for buying', async () => {
    const { state, checkout } = bitrefill('unpaid');
    const reads = createSpendInvoiceReadsV1();
    for (let index = 0; index < 3; index++) assert.equal((await reads.payment({ wallet: WALLET, order: ORDER, checkout })).ok, true);
    assert.deepEqual(await reads.payment({ wallet: WALLET, order: ORDER, checkout }), { ok: false, reason: 'bitrefill_rate_limited' });
    assert.equal(state.asked.length, 3);
    assert.equal((await reads.payment({ wallet: OTHER, order: SECOND, checkout })).ok, true);
  });

  it('before a step of a loan under way: never limited by wallet, and one failed read is tried once more', async () => {
    const { state, checkout } = bitrefill('unpaid');
    const waits: number[] = [];
    const reads = createSpendInvoiceReadsV1({ wait: async (ms) => { waits.push(ms); } });
    for (let index = 0; index < 8; index++) assert.equal((await reads.step({ order: ORDER, checkout })).ok, true);
    assert.equal(state.asked.length, 8);
    assert.deepEqual(waits, []);
    // Bitrefill does not answer, then does.
    let failures = 1;
    const flaky = { readInvoice: async () => (failures-- > 0 ? { ok: false as const, reason: 'bitrefill_unreachable' as const } : { ok: true as const, value: status('unpaid') }) };
    assert.deepEqual(await reads.step({ order: ORDER, checkout: flaky }), { ok: true, value: status('unpaid') });
    assert.deepEqual(waits, [1_000]);
    // Twice silent is a refusal, and an answer that is not a passing failure is not asked for again.
    failures = 2;
    assert.deepEqual(await reads.step({ order: ORDER, checkout: flaky }), { ok: false, reason: 'bitrefill_unreachable' });
    assert.deepEqual(waits, [1_000, 1_000]);
    let asked = 0;
    const refused = { readInvoice: async () => { asked++; return { ok: false as const, reason: 'bitrefill_refused' as const }; } };
    assert.deepEqual(await reads.step({ order: ORDER, checkout: refused }), { ok: false, reason: 'bitrefill_refused' });
    assert.equal(asked, 1);
  });
});
