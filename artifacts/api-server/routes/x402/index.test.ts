import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { x402Router } from './index';

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
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header');
  });

  it('returns 200 for valid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'mock-receipt-data' })).toString('base64'));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data, 'This is premium mock data protected by x402 payment.');
  });
});
