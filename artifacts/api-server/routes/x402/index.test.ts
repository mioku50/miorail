import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { x402Router } from './index.js';
import { db } from '@mioagent/db';
import { x402Receipts } from '@mioagent/db/schema';
import { eq } from 'drizzle-orm';

const app = express();
app.use(express.json());
app.use('/x402', x402Router);

describe('x402 mock endpoint', () => {
  it('returns 402 with Payment-Required header when missing X-402-Payment', async () => {
    const res = await request(app).get('/x402/mock-paid-endpoint');

    assert.strictEqual(res.status, 402);
    assert.ok(res.headers['payment-required']);

    const paymentRequired = JSON.parse(res.headers['payment-required']);
    assert.ok(paymentRequired.accepts);
    assert.strictEqual(paymentRequired.accepts[0].amount, '1000000');
    assert.strictEqual(paymentRequired.accepts[0].asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('returns 400 for invalid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ notReceipt: true })).toString('base64'));

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid payment receipt');
  });

  it('returns 200 for valid X-402-Payment header and then 400 on replay', async () => {
    const receiptId = `mock-receipt-${Date.now()}`;
    const payment = {
      receipt: {
        id: receiptId,
        amount: '1000000',
        payTo: '0x1234567890123456789012345678901234567890',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: '8453',
      }
    };
    const paymentHeader = Buffer.from(JSON.stringify(payment)).toString('base64');

    const res1 = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', paymentHeader);

    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.data, 'This is premium mock data protected by x402 payment.');

    // Replay should fail
    const res2 = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', paymentHeader);

    assert.strictEqual(res2.status, 400);
    assert.strictEqual(res2.body.error, 'Payment receipt has already been used');

    // Cleanup
    await db.delete(x402Receipts).where(eq(x402Receipts.id, receiptId));
  });
});
