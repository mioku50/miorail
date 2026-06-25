import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { x402Router } from './index.js';

const app = express();
app.use('/x402', x402Router);

describe('x402 mock endpoint', () => {
  it('returns 402 with Payment-Required header when missing X-402-Payment', async () => {
    const res = await request(app).get('/x402/mock-paid-endpoint');
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'Payment Required');
    assert.ok(res.headers['payment-required']);
  });

  it('returns 400 for invalid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ notReceipt: true })).toString('base64'));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header: missing receipt');
  });

  it('returns 200 for valid X-402-Payment header', async () => {
    const res = await request(app)
      .get('/x402/mock-paid-endpoint')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'valid-receipt-amount:1000000' })).toString('base64'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data, 'This is premium mock data protected by x402 payment.');
  });
});
