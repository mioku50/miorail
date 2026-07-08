import { describe, it } from 'node:test';
import assert from 'node:assert';
import express, { Request, Response } from 'express';
import request from 'supertest';
import { encodeBuilderCodeSuffix } from '@x402/extensions/builder-code';
import {
  x402Gateway,
  MockFacilitator,
  createX402RoutesConfig,
  paymentRequiredFromRuntimeConfig,
  settlementRecordFromSettleResult,
  verifyBuilderCodeAttributionFromCalldata,
  x402ConfigFromEnv,
} from './index.js';

describe('x402-gateway', () => {
  const paymentRequired = {
    accepts: [
      {
        amount: '1000000',
        payTo: '0x1234',
        asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC on Base Sepolia
        network: '84532', // Base Sepolia
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

  it('fails closed when real x402 env is missing or invalid', () => {
    const missing = x402ConfigFromEnv({});
    assert.strictEqual(missing.status, 'simulated');
    assert.strictEqual(missing.configured, false);

    const invalid = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1234',
      X402_NETWORK: 'eip155:1',
    });
    assert.strictEqual(invalid.status, 'missing');
    assert.strictEqual(invalid.configured, false);
    assert.ok(invalid.missingConfig.includes('X402_PAYTO_ADDRESS'));
    assert.ok(invalid.missingConfig.includes('X402_NETWORK'));
  });

  it('builds payment requirements from supported Base network and canonical USDC', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_AMOUNT_ATOMIC_USDC: '2500',
      BUILDER_CODE: 'miorail',
    });
    assert.strictEqual(config.status, 'configured');
    assert.strictEqual(config.network, 'eip155:8453');
    assert.strictEqual(config.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.strictEqual(config.amountAtomic, '2500');

    const paymentRequired = paymentRequiredFromRuntimeConfig(config);
    assert.strictEqual(paymentRequired.accepts[0].network, 'eip155:8453');
    assert.strictEqual(paymentRequired.accepts[0].asset, config.asset);
    assert.strictEqual(paymentRequired.accepts[0].amount, '2500');
  });

  it('declares Builder Code seller extension in official route config', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:84532',
      BUILDER_CODE: 'miorail',
    });
    const routes = createX402RoutesConfig(config);
    const route = (routes as Record<string, any>)['GET /mock-paid-endpoint'];
    assert.strictEqual(route.extensions['builder-code'].info.a, 'miorail');
    assert.strictEqual(route.accepts.network, 'eip155:84532');
    assert.strictEqual(route.accepts.price.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('verifies Builder Code suffix roles from calldata', () => {
    const suffix = encodeBuilderCodeSuffix({ a: 'miorail', s: ['buyer_app'] });
    const calldata = `0x1234${suffix.slice(2)}` as const;
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'miorail', 'seller'), true);
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'buyer_app', 'buyer'), true);
    assert.strictEqual(verifyBuilderCodeAttributionFromCalldata(calldata, 'other', 'buyer'), false);
  });

  it('normalizes settled facilitator records for ledger storage', () => {
    const config = x402ConfigFromEnv({
      X402_FACILITATOR_URL: 'https://facilitator.example.test',
      X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
      X402_NETWORK: 'eip155:8453',
      X402_AMOUNT_ATOMIC_USDC: '1000',
      BUILDER_CODE: 'miorail',
    });
    const record = settlementRecordFromSettleResult(
      {
        success: true,
        transaction: '0xabc',
        network: 'eip155:8453',
        amount: '1000',
        extensions: { 'builder-code': { a: 'miorail', s: ['buyer_app'] } },
      },
      {
        asset: config.asset,
        amount: config.amountAtomic,
        payTo: config.payTo,
      },
      config,
      '2026-07-08T00:00:00.000Z',
    );
    assert.strictEqual(record.status, 'settled');
    assert.strictEqual(record.txHash, '0xabc');
    assert.strictEqual(record.asset, config.asset);
    assert.strictEqual(record.attribution.sellerVerified, true);
    assert.strictEqual(record.checkedAt, '2026-07-08T00:00:00.000Z');
  });
});
