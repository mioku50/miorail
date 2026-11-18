import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createSpendOrderStoreV1, type SpendOrderV1 } from './stillSpendOrders.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OWNER = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET };
const OPENED = new Date('2026-11-18T12:00:00.000Z');
const HALF_AN_HOUR = 30 * 60_000;

function order(overrides: Partial<SpendOrderV1> = {}): SpendOrderV1 {
  return {
    orderId: 'invoice-1', ...OWNER, productId: 'bitrefill-esim-germany', productName: 'Bitrefill eSIM Germany',
    packageValue: '10GB, 30 Days', faceCurrency: 'USD', priceAtomic: '12000000', payTo: '0x2222222222222222222222222222222222222222',
    email: 'buyer@example.com', refillTo: null, createdAt: OPENED.toISOString(), expiresAt: '2026-11-18T12:15:00.000Z',
    accessToken: 'access-token-fixture', paymentLink: null, ...overrides,
  };
}

// Audit P3 spend email, 2026-11-18: the MCP tool promises the email is held
// "for at most half an hour", and a row was dropped only when the store was
// next used, so an idle process kept it in memory past that.
describe('an open order is forgotten on time, used or not', () => {
  test('the row is gone after half an hour with no access in between', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // The store's own clock never moves: only the timer can have removed the row.
    const orders = createSpendOrderStoreV1({ now: () => OPENED });
    orders.put(order());
    t.mock.timers.tick(HALF_AN_HOUR - 1);
    assert.equal(orders.get(OWNER, 'invoice-1')?.email, 'buyer@example.com');
    t.mock.timers.tick(1);
    assert.equal(orders.get(OWNER, 'invoice-1'), null);
  });

  test('the half hour runs from when the invoice opened, not from when it was stored', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stored = new Date(OPENED.getTime() + 10 * 60_000);
    const orders = createSpendOrderStoreV1({ now: () => stored, ttlMs: HALF_AN_HOUR });
    orders.put(order());
    t.mock.timers.tick(20 * 60_000);
    assert.equal(orders.get(OWNER, 'invoice-1'), null);
  });

  test('an order stored again under the same id is not cut short by the earlier timer', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = OPENED;
    const orders = createSpendOrderStoreV1({ now: () => clock });
    orders.put(order());
    t.mock.timers.tick(20 * 60_000);
    clock = new Date(OPENED.getTime() + 20 * 60_000);
    orders.put(order({ createdAt: clock.toISOString(), email: 'again@example.com' }));
    t.mock.timers.tick(10 * 60_000);
    assert.equal(orders.get(OWNER, 'invoice-1')?.email, 'again@example.com');
    t.mock.timers.tick(20 * 60_000);
    assert.equal(orders.get(OWNER, 'invoice-1'), null);
  });
});
