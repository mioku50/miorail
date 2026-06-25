import { describe, it } from 'node:test';
import assert from 'node:assert';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { x402Gateway, MockFacilitator } from './index.js';

describe('x402-gateway', () => {
  const paymentRequired = {
    accepts: [
      {
        amount: '1000000',
        payTo: '0x1234',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: '8453',
      }
    ]
  };

  const app = express();
  const facilitator = new MockFacilitator();
  const gateway = x402Gateway({ paymentRequired, facilitator });

  app.get('/protected', gateway, (req: Request, res: Response) => {
    res.status(200).json({ data: 'success' });
  });

  it('returns 402 with Payment-Required header when missing X-402-Payment', async () => {
    const res = await request(app).get('/protected');
    assert.strictEqual(res.status, 402);
    assert.deepStrictEqual(JSON.parse(res.headers['payment-required']), paymentRequired);
    assert.strictEqual(res.body.error, 'Payment Required');
  });

  it('returns 400 for invalid X-402-Payment header json', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', 'invalid-base64');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header');
  });

  it('returns 400 for missing receipt', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ notReceipt: true })).toString('base64'));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Invalid X-402-Payment header: missing receipt');
  });

  it('returns 402 for invalid receipt', async () => {
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: 'bad-receipt' })).toString('base64'));
    assert.strictEqual(res.status, 402);
    assert.strictEqual(res.body.error, 'Payment Required: Invalid or used receipt');
  });

  it('returns 200 for valid receipt', async () => {
    const validReceipt = 'valid-receipt-amount:1000000';
    const res = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data, 'success');
  });

  it('returns 402 for reused receipt (anti-replay)', async () => {
    const validReceipt = 'valid-receipt-amount:1000000-2';
    // First request succeeds
    await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));

    // Second request with same receipt fails
    const res2 = await request(app)
      .get('/protected')
      .set('x-402-payment', Buffer.from(JSON.stringify({ receipt: validReceipt })).toString('base64'));

    assert.strictEqual(res2.status, 402);
    assert.strictEqual(res2.body.error, 'Payment Required: Invalid or used receipt');
  });
});
