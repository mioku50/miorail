import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEND_VALUATIONS_PER_MINUTE_V1,
  SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1,
  SendValuationBusyErrorV1,
  reserveSendValuationV1,
  sendValuationBudgetV1,
} from './sendValuationBudget.js';

// Audit SS-6, 2026-11-14: a send is priced within a per-wallet budget and a ceiling for the whole server.

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

test('ten prices a minute for one wallet, the eleventh refused, and another wallet unaffected', async (t) => {
  sendValuationBudgetV1.reset();
  t.after(() => sendValuationBudgetV1.reset());
  for (let i = 0; i < SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1; i++) await reserveSendValuationV1(wallet(1));
  // The same wallet in another case is the same wallet.
  await assert.rejects(reserveSendValuationV1(wallet(1).toUpperCase().replace('0X', '0x')), (error) =>
    error instanceof SendValuationBusyErrorV1 && error.scope === 'wallet' && /at most 10 times a minute for one wallet/.test(error.message));
  await reserveSendValuationV1(wallet(2));
});

test('however many wallets ask, the server prices at most sixty a minute', async (t) => {
  sendValuationBudgetV1.reset();
  t.after(() => sendValuationBudgetV1.reset());
  for (let i = 0; i < SEND_VALUATIONS_PER_MINUTE_V1; i++) await reserveSendValuationV1(wallet(100 + i));
  await assert.rejects(reserveSendValuationV1(wallet(999)), (error) => error instanceof SendValuationBusyErrorV1 && error.scope === 'server');
});
