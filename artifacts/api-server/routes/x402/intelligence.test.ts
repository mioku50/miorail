import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import { b20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { CreateX402MiddlewareOptions } from '@mioagent/x402-gateway';
import { createX402IntelligenceRouterV1, sellerReceiptDetailsV1 } from './intelligence.js';

/** This package declares no `"type"`, so `module: NodeNext` typechecks it as
 * CommonJS and rejects `import.meta`. */
function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

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

// ---------------------------------------------------------------------------
// Settlement and delivery are written in an order nobody chose.
//
// The resource server raises settlement on `onAfterSettle` — AFTER the handler
// has produced the response — so on every real sale the handler reaches
// delivery first, when no receipt row exists yet. The first version returned
// early in exactly that case, so the first genuine production sale
// (0.001 USDC, tx 0xeddde5aa…, delivered with HTTP 200) was stored as
// `deliveryStatus: pending` with no dataHash, and `x402IntelligenceSold` —
// which counts a sale only when settlement AND delivery both exist — reported
// 0 through it.
//
// The receipt body is now built from the delivery it is given, so whichever
// of the two runs second writes both.
// ---------------------------------------------------------------------------

test('a receipt written after delivery carries the delivered hash, not "pending"', () => {
  const details = sellerReceiptDetailsV1({
    base: { txHash: '0xabc' },
    service: 'b20_exit_analysis',
    requestHash: '0xrequest',
    paymentStatus: 'settled',
    delivery: { dataHash: '0xdata', deliveredAt: '2026-08-14T23:05:00.000Z' },
  });
  assert.equal(details.deliveryStatus, 'delivered');
  assert.equal(details.dataHash, '0xdata');
  assert.equal(details.deliveredAt, '2026-08-14T23:05:00.000Z');
  assert.equal(details.txHash, '0xabc', 'the facilitator record must survive');
  assert.equal(details.paymentStatus, 'settled');
});

test('a receipt written before delivery stays pending and claims no data hash', () => {
  const details = sellerReceiptDetailsV1({
    base: {},
    service: 'b20_liquidity_evidence',
    requestHash: '0xrequest',
    paymentStatus: 'settled',
    delivery: null,
  });
  assert.equal(details.deliveryStatus, 'pending');
  assert.equal('dataHash' in details, false, 'an undelivered sale must not carry a hash key');
  assert.equal('deliveredAt' in details, false);
});

test('delivery is recorded on the request context before the receipt is looked up', () => {
  // The ordering above is only safe if the handler stamps the context
  // unconditionally. Guarding the source because the failing path writes
  // nothing at all, so no in-process assertion can observe it.
  const source = readFileSync(packageFileV1('routes/x402/intelligence.ts'), 'utf8');
  const body = /async function markSellerDeliveryV1[\s\S]*?\n}/.exec(source)?.[0] ?? '';
  assert.ok(body.length > 0, 'markSellerDeliveryV1 must still exist');
  const stamped = body.indexOf('context.delivery =');
  const earlyReturn = body.indexOf('if (!context.receiptId) return;');
  assert.ok(stamped > 0, 'delivery must be recorded on the context');
  assert.ok(earlyReturn > 0, 'the no-receipt-yet path must still return early');
  assert.ok(
    stamped < earlyReturn,
    'recording delivery after the early return is the defect: it never runs on a real sale',
  );
});
