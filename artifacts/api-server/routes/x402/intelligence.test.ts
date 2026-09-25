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
import {
  X402_INTELLIGENCE_MOUNT_V1,
  createX402IntelligenceRouterV1,
  sellerReceiptDetailsV1,
} from './intelligence.js';

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

test('the discovery document lists every catalogued resource at its absolute address', async () => {
  // x402scan registers a seller from /.well-known/x402 (nginx maps it here).
  const app = express();
  app.use(
    '/api/x402/intelligence/v1',
    createX402IntelligenceRouterV1({ env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz/' }, dbEnabled: false }),
  );
  const catalog = await request(app).get('/api/x402/intelligence/v1/catalog').expect(200);
  const discovery = await request(app).get('/api/x402/intelligence/v1/well-known').expect(200);
  assert.equal(discovery.body.version, 1);
  assert.deepEqual(
    discovery.body.resources,
    (catalog.body.services as { path: string }[]).map((service) => `https://miorail.xyz${service.path}`),
  );

  // Nothing is listed that cannot be bought: the seller switched off, or no
  // public https origin to name the resources by.
  for (const env of [
    { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz', MIORAIL_X402_SELLER_INTELLIGENCE_V1: 'false' },
    { ...ENV, PUBLIC_API_BASE_URL: 'http://miorail.xyz' },
    { ...ENV },
  ] as NodeJS.ProcessEnv[]) {
    const off = express();
    off.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({ env, dbEnabled: false }));
    await request(off).get('/api/x402/intelligence/v1/well-known').expect(404);
  }
});

test('the OpenAPI document is what x402scan parses: a price, the protocol and the inputs on every paid route', async () => {
  // @agentcash/discovery 1.7.5 (x402scan's "Add Server") no longer parses
  // /.well-known/x402; it reads /openapi.json and nothing else.
  const app = express();
  app.use(
    '/api/x402/intelligence/v1',
    createX402IntelligenceRouterV1({ env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' }, dbEnabled: false }),
  );
  const catalog = await request(app).get('/api/x402/intelligence/v1/catalog').expect(200);
  const response = await request(app).get('/api/x402/intelligence/v1/openapi.json').expect(200);
  const doc = response.body as {
    openapi: string;
    info: { title: string; version: string; 'x-guidance'?: string };
    servers: { url: string }[];
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  // The fields their schema requires, and the base path their parser derives
  // from servers[0]: empty, so each key is the full path.
  assert.match(doc.openapi, /^3\./);
  assert.ok(doc.info.title && doc.info.version);
  assert.deepEqual(doc.servers, [{ url: 'https://miorail.xyz' }]);
  assert.ok((doc.info['x-guidance'] ?? '').length > 0 && (doc.info['x-guidance'] ?? '').length < 4000);

  for (const service of catalog.body.services as { id: string; path: string }[]) {
    const operation = doc.paths[service.path]?.get;
    assert.ok(operation, `${service.path} is in the document`);
    // A 402 response, and structured payment info: a fixed price in USD equal
    // to the catalogue's, and the x402 protocol.
    assert.ok((operation.responses as Record<string, unknown>)['402']);
    const info = operation['x-payment-info'] as { price: Record<string, string>; protocols: Record<string, unknown>[] };
    assert.deepEqual(info.price, { mode: 'fixed', currency: 'USD', amount: MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1 });
    assert.ok(info.protocols.some((protocol) => 'x402' in protocol));
    // An input schema, or the audit flags the paid route as uncallable.
    const parameters = operation.parameters as { in: string; name: string; required: boolean }[];
    assert.ok(parameters.length > 0 && parameters.every((parameter) => parameter.in === 'query'));
    assert.ok(parameters.some((parameter) => parameter.required), `${service.path} names its required input`);
  }
  // The free price list says it is free rather than leaving its auth unknown.
  assert.deepEqual(doc.paths['/api/x402/intelligence/v1/catalog']?.get?.security, []);

  const off = express();
  off.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({ env: ENV, dbEnabled: false }));
  await request(off).get('/api/x402/intelligence/v1/openapi.json').expect(404);
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

test('a paid premium says which reference it is against, because three are possible', async () => {
  // These feeds publish through the overnight session, so a bare bps figure
  // can be against the open session, against a close, or against a 03:00
  // print. A buyer comparing two of those is subtracting two denominators.
  const app = paidAppV1({
    loadRepresentations: async () => {
      const board = boardFixtureV1() as { representations: Record<string, unknown>[] };
      board.representations[0]!.basis = {
        status: 'comparable',
        kind: 'off_session_reference',
        premiumDiscountBps: '-12',
        reason: 'Comparable with the feed’s own off-session publication.',
      };
      return board;
    },
  });
  const response = await request(app)
    .get('/api/x402/intelligence/v1/stocks/representations')
    .query({ underlyingKey: 'security:isin:US67066G1040', sizeUsdc: '100' })
    .expect(200);
  const [coinbase, backed] = response.body.representations;
  assert.equal(coinbase.premiumDiscountBps, '-12');
  assert.equal(coinbase.premiumDiscountAgainst, 'off_session_reference');
  // No basis recorded at all is null, and null is not a fourth kind.
  assert.equal(backed.premiumDiscountBps, null);
  assert.equal(backed.premiumDiscountAgainst, null);
  assert.match(response.body.caveats.join(' '), /only comparable against the same/i);
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

// ---------------------------------------------------------------------------
// "What does this cost?" is not a malformed request for the answer.
//
// Every route validated its arguments before the paywall, so a request with no
// query string — exactly what an index, a crawler or an agent meeting the
// resource for the first time sends — got 400 and never saw a price. Measured
// on production 2026-09-19: all five answered 400 bare, CDP's validator
// reported `returns_402: false` with every later check skipped, and a full scan
// of the discovery list held 15,383 resources from 1,331 sellers and none of
// ours. The declaration underneath was correct the whole time; nothing ever
// reached it.
// ---------------------------------------------------------------------------
test('the 402 names an address, not a path, and it is the path this router is mounted at', async () => {
  // CDP's discovery refused every submission: `resource must start with
  // "https://" when protocol type is http`. The challenge carried
  // `resource: "/b20/exit-analysis"` — the route as Express knows it, with no
  // host — and an index cannot come back to that. Every preflight check passed
  // and the extension was read; the submission died one step later.
  const seen: Array<{ path: string; options: CreateX402MiddlewareOptions }> = [];
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' },
    dbEnabled: false,
    middlewareFactory: (path, options) => { seen.push({ path, options }); return PASS_THROUGH_V1; },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));
  await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: '0xb200000000000000000000000000000000000001' })
    .expect(200);

  assert.equal(seen.length, 5);
  for (const entry of seen) {
    assert.equal(
      entry.options.resourceOrigin,
      `https://miorail.xyz${X402_INTELLIGENCE_MOUNT_V1}`,
      `${entry.path} must publish an absolute https resource`,
    );
  }

  // And the mount constant is the mount. Move the router and this fails rather
  // than the listing going quietly stale.
  const mounted = readFileSync(packageFileV1('routes/index.ts'), 'utf8');
  assert.ok(
    mounted.includes(`'${X402_INTELLIGENCE_MOUNT_V1.replace('/api', '')}'`),
    `routes/index.ts does not mount the router at ${X402_INTELLIGENCE_MOUNT_V1}`,
  );
});

test('half an address is not published at all', async () => {
  // A base that is not https is ignored rather than concatenated: a relative
  // path is honest, and a malformed absolute one looks like it works.
  const seen: CreateX402MiddlewareOptions[] = [];
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: { ...ENV, PUBLIC_API_BASE_URL: 'miorail.xyz' },
    dbEnabled: false,
    middlewareFactory: (_path, options) => { seen.push(options); return PASS_THROUGH_V1; },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));
  await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: '0xb200000000000000000000000000000000000001' })
    .expect(200);
  assert.equal(seen[0]?.resourceOrigin, undefined);
});

test('a request that asks for nothing is answered with the price, not a 400', async () => {
  const priced: string[] = [];
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    middlewareFactory: (path) => (_req, res, _next) => {
      priced.push(path);
      res.status(402).json({ x402Version: 2, error: 'Payment Required' });
    },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));

  for (const path of [
    '/b20/exit-analysis',
    '/b20/liquidity-evidence',
    '/stocks/representations',
    '/address/identity',
    '/route-proofs/enhanced',
  ]) {
    await request(app).get(`/api/x402/intelligence/v1${path}`).expect(402);
  }
  assert.deepEqual(priced.sort(), [
    '/address/identity',
    '/b20/exit-analysis',
    '/b20/liquidity-evidence',
    '/route-proofs/enhanced',
    '/stocks/representations',
  ]);
});

test('pricing a bare request reads nothing and promises nothing', async () => {
  // The 402 is the cheapest thing this surface can do: no evidence read, no
  // proof lookup, no answer implied. A price that costs a database query is a
  // free denial-of-service with extra steps.
  let reads = 0;
  let proofLookups = 0;
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    middlewareFactory: () => (_req, res) => res.status(402).json({ x402Version: 2 }),
    loadB20: async () => { reads += 1; return { card: unmeasuredCard(), history: [] }; },
    loadBundle: async () => { proofLookups += 1; return null; },
  }));
  await request(app).get('/api/x402/intelligence/v1/b20/exit-analysis').expect(402);
  await request(app).get('/api/x402/intelligence/v1/route-proofs/enhanced').expect(402);
  assert.equal(reads, 0);
  assert.equal(proofLookups, 0);
});

test('a request that names an input is still validated before it is billed', async () => {
  // The other half. Pricing a bare request must not turn a malformed ask into
  // a charge for an answer nobody can deliver.
  let paymentCalls = 0;
  const app = express();
  app.use('/api/x402/intelligence/v1', createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    middlewareFactory: () => (_req, _res, next) => { paymentCalls += 1; next(); },
    loadB20: async () => ({ card: unmeasuredCard(), history: [] }),
  }));
  await request(app)
    .get('/api/x402/intelligence/v1/b20/exit-analysis')
    .query({ tokenAddress: 'not-an-address' })
    .expect(400);
  await request(app)
    .get('/api/x402/intelligence/v1/route-proofs/enhanced')
    .query({ publicId: 'not a public id' })
    .expect(400);
  assert.equal(paymentCalls, 0);
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
