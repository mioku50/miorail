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
import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1,
} from '@mioagent/route-domain';
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

test('catalog publishes every fixed-price service without payment', async () => {
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({ env: ENV, dbEnabled: false }));
  const response = await request(app).get('/api/x402/intelligence/v1/catalog').expect(200);
  // One price for every resource: the thing being sold is the same in each —
  // a measurement Miorail already took, with what it does not establish named
  // beside it. Read from the constant so the catalogue and the challenge
  // cannot disagree about what a call costs.
  assert.equal(response.body.payment.amountAtomic, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
  assert.equal(response.body.payment.amountUsdc, MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1);
  assert.deepEqual(response.body.services.map((service: { id: string }) => service.id), [
    'b20_exit_analysis',
    'b20_liquidity_evidence',
    'enhanced_route_proof',
    'stock_representation_choice',
    'address_identity_check',
  ]);
  // Every advertised path is a real mount, not a description of one.
  for (const service of response.body.services as { path: string }[]) {
    assert.match(service.path, /^\/api\/x402\/intelligence\/v1\//);
  }
  // The prose is a price claim too. It shipped once saying 0.001 while the
  // challenge charged 0.002 — a schema literal guards the field and nothing
  // guarded the sentence, so a buyer read one number and paid another.
  const priced = (response.body.constraints as string[]).filter((line) => /USDC/.test(line));
  assert.ok(priced.length > 0, 'the catalogue must state its price in words');
  for (const line of priced) {
    const quoted = line.match(/(\d+\.\d+) USDC/);
    if (!quoted) continue;
    assert.equal(quoted[1], MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1);
  }
});

test('the official x402 challenge prices a seller resource at the catalogue price in Base USDC', async () => {
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
    assert.equal(challenge.accepts[0]?.amount, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
    assert.equal(challenge.accepts[0]?.network, 'eip155:8453');
    assert.equal(challenge.accepts[0]?.asset.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  } finally {
    await new Promise<void>((resolve) => facilitator.close(() => resolve()));
  }
});

test('paid B20 response is deterministic evidence and every route overrides price to the one constant', async () => {
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
  assert.equal(middlewareOptions.length, 5);
  assert.ok(
    middlewareOptions.every(
      (entry) => entry.options.amountAtomicOverride === MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
    ),
  );
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

// ---------------------------------------------------------------------------
// The two questions an agent gets wrong silently, sold.
//
// Both read stored evidence and measure nothing — a paid read must never be a
// way to make Miorail spend router calls for somebody else — and both carry
// what was NOT established beside what was.
// ---------------------------------------------------------------------------

const PASS_THROUGH_V1: RequestHandler = (_req, _res, next) => next();

function boardFixtureV1(overrides: Record<string, unknown> = {}) {
  return {
    question: { underlyingKey: 'security:isin:US67066G1040' },
    underlying: { isin: 'US67066G1040', assetClass: 'equity' },
    representations: [
      {
        tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
        issuerId: 'coinbase',
        issuerInstrumentKey: 'coinbase:NVDAc',
        representationKind: 'b20_asset',
        supply: { state: 'positive_supply', decimals: 8 },
        routePolicyKey: `0x${'ab'.repeat(32)}`,
        sources: [{ source: 'kyberswap', status: 'quoted' }],
        exactTestedTokenAtomic: '55500',
        returnedCashAtomic: '99500',
        effectivePriceAtomic: '17927927927',
        premiumDiscountBps: '-12',
        observedAt: '2026-09-06T18:00:00.000Z',
        expiresAt: '2026-09-06T18:00:20.000Z',
        liveness: 'live',
      },
      {
        // The one an agent picking by ticker would have chosen by coincidence.
        tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        issuerId: 'backed',
        issuerInstrumentKey: 'backed:bNVDA',
        representationKind: 'rebasing_erc20',
        supply: { state: 'positive_supply', decimals: 18 },
        routePolicyKey: null,
        sources: [],
        exactTestedTokenAtomic: null,
        returnedCashAtomic: null,
        effectivePriceAtomic: null,
        premiumDiscountBps: null,
        observedAt: null,
        expiresAt: null,
        liveness: 'never_measured',
      },
    ],
    ...overrides,
  };
}

function dossierFixtureV1(overrides: Record<string, unknown> = {}) {
  return {
    tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
    dossierHash: `0x${'cd'.repeat(32)}`,
    identity: {
      standing: 'official',
      official: {
        ticker: 'NVDAc',
        displayName: 'NVIDIA Corporation',
        issuer: 'coinbase',
        listedIn: ['base_product_list'],
        sourceDiscrepancy: false,
      },
      lookalike: null,
      origin: { status: 'relayed', deployerAddress: null, relation: 'bundler', readAt: '2026-09-01T00:00:00.000Z' },
    },
    established: [{ code: 'official_identity_bound' }],
    unknown: [{ code: 'holder_concentration_not_read' }],
    ...overrides,
  };
}

function paidAppV1(options: Record<string, unknown>) {
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    now: () => new Date('2026-09-06T18:05:00.000Z'),
    middlewareFactory: () => PASS_THROUGH_V1,
    ...options,
  }));
  return app;
}

test('the representation answer names every contract and which of them the market took', async () => {
  const asked: unknown[] = [];
  const app = paidAppV1({
    loadRepresentations: async (input: unknown) => {
      asked.push(input);
      return boardFixtureV1();
    },
  });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/stocks/representations')
    .query({ underlyingKey: 'security:isin:US67066G1040', sizeUsdc: '100' })
    .expect(200);

  assert.equal(response.body.schemaVersion, 'x402-stock-representation-choice/v1');
  assert.deepEqual(asked, [
    { underlyingKey: 'security:isin:US67066G1040', direction: 'buy', requestedCashAtomic: '100000000' },
  ]);
  assert.equal(response.body.representations.length, 2);
  const [coinbase, backed] = response.body.representations;
  assert.equal(coinbase.issuerId, 'coinbase');
  assert.equal(coinbase.routePolicyEstablished, true);
  assert.deepEqual(coinbase.sources, [{ source: 'kyberswap', status: 'quoted' }]);
  // The second one is the whole point: same security, no policy, nobody has
  // measured it. An agent picking by ticker had a 50% chance of this.
  assert.equal(backed.issuerId, 'backed');
  assert.equal(backed.routePolicyEstablished, false);
  assert.deepEqual(backed.sources, []);
  assert.match(response.body.missingEvidence.join(' '), /no measurement at this exact size/);
  assert.match(response.body.caveats.join(' '), /ticker cannot select/i);
  assert.equal(response.body.payment.amountAtomic, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
  assert.equal(response.headers['x-miorail-data-hash'], response.body.dataHash);
});

test('a size nobody measured is refused rather than measured to satisfy a paid read', async () => {
  let called = false;
  const app = paidAppV1({
    loadRepresentations: async () => {
      called = true;
      return boardFixtureV1();
    },
  });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/stocks/representations')
    .query({ underlyingKey: 'security:isin:US67066G1040', sizeUsdc: '250' })
    .expect(400);
  assert.equal(response.body.code, 'unmeasured_size_requested');
  assert.equal(called, false, 'a refused size must not reach the evidence read');
});

test('an underlying this corpus does not review is absent, never invented', async () => {
  const app = paidAppV1({ loadRepresentations: async () => null });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/stocks/representations')
    .query({ underlyingKey: 'security:isin:XX0000000000' })
    .expect(404);
  assert.equal(response.body.code, 'underlying_not_reviewed');
});

test('the identity answer carries the resemblance, the origin and what was not read', async () => {
  const app = paidAppV1({
    loadIdentity: async () =>
      dossierFixtureV1({
        identity: {
          ...dossierFixtureV1().identity,
          standing: 'indexed_launch',
          official: null,
          lookalike: {
            officialAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
            officialTicker: 'NVDAc',
            matchKind: 'symbol_exact',
            matchedAlias: 'published_ticker',
            matchedValue: 'NVDAc',
            firstFlaggedAt: '2026-09-01T00:00:00.000Z',
          },
        },
      }),
  });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/address/identity')
    .query({ tokenAddress: '0xcccccccccccccccccccccccccccccccccccccccc' })
    .expect(200);

  assert.equal(response.body.schemaVersion, 'x402-address-identity-check/v1');
  assert.equal(response.body.standing, 'indexed_launch');
  assert.equal(response.body.official, null);
  // A resemblance names the contract it resembles, so the buyer compares
  // ADDRESSES rather than trusting that two symbols matching means anything.
  assert.equal(response.body.lookalike.officialAddress, '0xb20000000000000000000078ee7ce2fe4908108c');
  assert.match(response.body.caveats.join(' '), /RESEMBLANCE/);
  // A bundler that relayed a UserOperation is not a deployer.
  assert.equal(response.body.origin.relation, 'bundler');
  assert.equal(response.body.origin.deployerAddress, null);
  assert.deepEqual(response.body.unknown, ['holder_concentration_not_read']);
  assert.equal(response.headers['x-miorail-data-hash'], response.body.dataHash);
});

test('an address is refused before any evidence read when it is not an address', async () => {
  let called = false;
  const app = paidAppV1({
    loadIdentity: async () => {
      called = true;
      return dossierFixtureV1();
    },
  });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/address/identity')
    .query({ tokenAddress: 'NVDA' })
    .expect(400);
  assert.equal(response.body.code, 'invalid_token_address');
  assert.equal(called, false);
});

test('every paid route declares itself for the discovery list', async () => {
  // Settling payments does not list a resource: three settled through the CDP
  // facilitator in August and its discovery list held zero Miorail entries.
  // A declaration on the 402 challenge is what lists it — so every route must
  // carry one, and it must describe THAT route rather than a generic shape.
  const seen: Array<{ path: string; options: CreateX402MiddlewareOptions }> = [];
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    middlewareFactory: (path, options) => {
      seen.push({ path, options });
      return PASS_THROUGH_V1;
    },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));
  await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: '0xb200000000000000000000000000000000000001' })
    .expect(200);

  assert.equal(seen.length, 5);
  for (const entry of seen) {
    const discovery = entry.options.discovery as
      | { input?: Record<string, unknown>; inputSchema?: { required?: string[] }; output?: { example?: unknown } }
      | undefined;
    assert.ok(discovery, `${entry.path} must declare itself`);
    assert.ok(discovery.output?.example, `${entry.path} must show the shape it returns`);
    assert.ok(
      (discovery.inputSchema?.required ?? []).length > 0,
      `${entry.path} must name the input a caller has to send`,
    );
    // The declaration describes THIS route, not a template: every required
    // input must actually appear in the example input.
    for (const key of discovery.inputSchema?.required ?? []) {
      assert.ok(key in (discovery.input ?? {}), `${entry.path} example must include ${key}`);
    }
  }
});
