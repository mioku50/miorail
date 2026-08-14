import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import { b20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { CreateX402MiddlewareOptions } from '@mioagent/x402-gateway';
import { createX402IntelligenceRouterV1 } from './intelligence.js';

const ENV = {
  MIORAIL_X402_SELLER_INTELLIGENCE_V1: 'true',
  X402_FACILITATOR_URL: 'https://facilitator.example',
  X402_FACILITATOR_AUTH_TOKEN: 'test-only',
  X402_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
  X402_NETWORK: 'eip155:8453',
} as NodeJS.ProcessEnv;

function unmeasuredCard() {
  return b20OpportunityCardV1({
    launch: {
      tokenAddress: '0xb200000000000000000000000000000000000001',
      name: 'MIO',
      symbol: 'MIO',
      variant: 'asset',
      decimals: 18,
      blockNumber: '50000000',
      transactionHash: `0x${'11'.repeat(32)}`,
      logIndex: 0,
      detectedAt: '2026-08-14T10:00:00.000Z',
      blockTimestamp: null,
      canonical: true,
    },
    observation: null,
    launchBuyers: null,
    launchBuyerWindow: { status: 'collecting', closesAtBlock: '50010000' },
    now: new Date('2026-08-14T12:00:00.000Z'),
  });
}

test('catalog publishes three fixed 0.001 USDC services without payment', async () => {
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({ env: ENV, dbEnabled: false }));
  const response = await request(app).get('/api/x402/intelligence/v1/catalog').expect(200);
  assert.equal(response.body.payment.amountAtomic, '1000');
  assert.equal(response.body.payment.amountUsdc, '0.001');
  assert.deepEqual(response.body.services.map((service: { id: string }) => service.id), [
    'b20_exit_analysis',
    'b20_liquidity_evidence',
    'enhanced_route_proof',
  ]);
});

test('the official x402 challenge prices a seller resource at exactly 0.001 Base USDC', async () => {
  const facilitator = createServer((req, res) => {
    if (req.url?.endsWith('/supported')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => facilitator.listen(0, '127.0.0.1', resolve));
  const { port } = facilitator.address() as AddressInfo;
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: { ...ENV, X402_FACILITATOR_URL: `http://127.0.0.1:${port}`, BASE_BUILDER_CODE: 'miorail' },
    dbEnabled: false,
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));

  try {
    const response = await request(app)
      .get('/api/x402/intelligence/v1/b20/exit-analysis')
      .query({ tokenAddress: '0xb200000000000000000000000000000000000001' })
      .expect(402);
    const header = response.headers['payment-required'];
    assert.equal(typeof header, 'string');
    const challenge = decodePaymentRequiredHeader(header as string);
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0]?.amount, '1000');
    assert.equal(challenge.accepts[0]?.network, 'eip155:8453');
    assert.equal(challenge.accepts[0]?.asset.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  } finally {
    await new Promise<void>((resolve) => facilitator.close(() => resolve()));
  }
});

test('paid B20 response is deterministic evidence and every route overrides price to 1000 atomic', async () => {
  const middlewareOptions: Array<{ path: string; options: CreateX402MiddlewareOptions }> = [];
  const pass: RequestHandler = (_req, _res, next) => next();
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
    middlewareFactory: (path, options) => {
      middlewareOptions.push({ path, options });
      return pass;
    },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));

  const response = await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: '0xb200000000000000000000000000000000000001' })
    .expect(200);
  assert.equal(response.body.schemaVersion, 'x402-b20-intelligence/v1');
  assert.equal(response.body.analysis.verdict.status, 'not_measured');
  assert.equal(response.body.payment.status, 'settled_by_middleware');
  assert.match(response.body.dataHash, /^0x[0-9a-f]{64}$/);
  assert.equal(response.headers['x-miorail-data-hash'], response.body.dataHash);
  assert.equal(middlewareOptions.length, 3);
  assert.ok(middlewareOptions.every((entry) => entry.options.amountAtomicOverride === '1000'));
});

test('invalid input and disabled feature never reach the payment middleware', async () => {
  let paymentCalls = 0;
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: { ...ENV, MIORAIL_X402_SELLER_INTELLIGENCE_V1: 'false' },
    dbEnabled: false,
    middlewareFactory: () => (_req, _res, next) => {
      paymentCalls += 1;
      next();
    },
  }));
  await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: 'not-an-address' })
    .expect(404);
  assert.equal(paymentCalls, 0);
});

test('a missing or private Route Proof is rejected before any payment is requested', async () => {
  let paymentCalls = 0;
  let proofLookups = 0;
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    middlewareFactory: () => (_req, _res, next) => {
      paymentCalls += 1;
      next();
    },
    loadBundle: async () => {
      proofLookups += 1;
      return null;
    },
  }));

  await request(app)
    .get('/api/x402/intelligence/v1/route-proofs/enhanced')
    .query({ publicId: 'a'.repeat(48) })
    .expect(404);

  assert.equal(proofLookups, 1);
  assert.equal(paymentCalls, 0, 'the buyer must not pay for a proof Miorail cannot deliver');
});
