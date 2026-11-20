import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1,
  X402StillLoanQuoteV1Schema,
  hashX402IntelligenceDataV1,
} from '@mioagent/route-domain';
import type { MirrorInput } from '@mioagent/still-engine';
import type { CreateX402MiddlewareOptions } from '@mioagent/x402-gateway';
import { EXAMPLE, calendar, snapshot, universe } from '../../../../lib/still-engine/test/fixtures.js';
import { EvidencePackageV1Schema } from '../mcp/evidencePackage.js';
import {
  X402_INTELLIGENCE_MOUNT_V1,
  createX402IntelligenceRouterV1,
  X402_CHALLENGE_HEADER_BUDGET_V1,
  sellerReceiptDetailsV1,
  userAgentOfV1,
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

const QUOTE = `${X402_INTELLIGENCE_MOUNT_V1}/still/loan-quote`;
const PASS_THROUGH_V1: RequestHandler = (_req, _res, next) => next();
const RETIRED_PATHS_V1 = [
  '/b20/exit-analysis',
  '/b20/liquidity-evidence',
  '/route-proofs/enhanced',
  '/stocks/representations',
  '/address/identity',
];

/** A reading of the example wallet, so a quote that ignores whose wallet was read is tested against a full one. */
function readingV1(): MirrorInput {
  return {
    universe: universe(),
    snapshot: snapshot(EXAMPLE),
    calendar: calendar(),
    subject: { address: '0x00000000000000000000000000000000000b0b0b', name: null, input: 'example' },
    assembledAt: new Date('2026-10-21T15:00:01Z'),
  };
}

function appV1(options: Record<string, unknown> = {}) {
  const app = express();
  app.use(X402_INTELLIGENCE_MOUNT_V1, createX402IntelligenceRouterV1({
    env: ENV,
    dbEnabled: false,
    now: () => new Date('2026-10-21T15:00:02.000Z'),
    middlewareFactory: () => PASS_THROUGH_V1,
    readStillMarket: async () => readingV1(),
    // cbBTC and PAXG held by nothing, and no stock paused, unless a test says otherwise.
    readStillCollateralHold: async () => ({ paused: false, marketFrozen: false, walletFrozen: false }),
    readStillStockTransfersPaused: async () => false,
    ...options,
  }));
  return app;
}

test('the catalog sells one thing, at the one price, and says where each retired answer is free', async () => {
  const response = await request(appV1({ env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' } }))
    .get(`${X402_INTELLIGENCE_MOUNT_V1}/catalog`).expect(200);
  assert.equal(response.body.payment.amountAtomic, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
  assert.equal(response.body.payment.amountUsdc, MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1);
  assert.deepEqual(response.body.services.map((service: { id: string }) => service.id), ['still_loan_quote']);
  assert.equal(response.body.services[0].path, QUOTE);
  assert.deepEqual(
    response.body.retired.map((entry: { path: string }) => entry.path),
    RETIRED_PATHS_V1.map((p) => `${X402_INTELLIGENCE_MOUNT_V1}${p}`),
  );
  for (const entry of response.body.retired as { instead: string; retiredAt: string }[]) {
    assert.equal(entry.retiredAt, '2026-11-16');
    assert.match(entry.instead, /^Free: /);
  }
  // The prose is a price claim too. It shipped once saying 0.001 while the
  // challenge charged 0.002 — a schema literal guards the field and nothing
  // guarded the sentence, so a buyer read one number and paid another.
  for (const line of response.body.constraints as string[]) {
    const quoted = line.match(/(\d+\.\d+) USDC/);
    if (quoted) assert.equal(quoted[1], MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1);
  }
  assert.ok((response.body.constraints as string[]).some((line) => /not offered to US persons/.test(line)));
});

test('the discovery document lists only what can be bought, at its absolute address', async () => {
  const app = appV1({ env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz/' } });
  const discovery = await request(app).get(`${X402_INTELLIGENCE_MOUNT_V1}/well-known`).expect(200);
  assert.deepEqual(discovery.body, { version: 1, resources: [`https://miorail.xyz${QUOTE}`] });

  // Nothing is listed that cannot be bought: the seller switched off, or no
  // public https origin to name the resources by.
  for (const env of [
    { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz', MIORAIL_X402_SELLER_INTELLIGENCE_V1: 'false' },
    { ...ENV, PUBLIC_API_BASE_URL: 'http://miorail.xyz' },
    { ...ENV },
  ] as NodeJS.ProcessEnv[]) {
    await request(appV1({ env })).get(`${X402_INTELLIGENCE_MOUNT_V1}/well-known`).expect(404);
  }
});

test('the OpenAPI document is what x402scan parses: a price, the protocol and the inputs on the paid route', async () => {
  // @agentcash/discovery 1.7.5 (x402scan's "Add Server") reads /openapi.json and nothing else.
  const app = appV1({ env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' } });
  const doc = (await request(app).get(`${X402_INTELLIGENCE_MOUNT_V1}/openapi.json`).expect(200)).body as {
    openapi: string;
    info: { title: string; version: string; 'x-guidance'?: string };
    servers: { url: string }[];
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  assert.match(doc.openapi, /^3\./);
  assert.deepEqual(doc.servers, [{ url: 'https://miorail.xyz' }]);
  assert.ok((doc.info['x-guidance'] ?? '').length > 0 && (doc.info['x-guidance'] ?? '').length < 4000);
  const operation = doc.paths[QUOTE]?.get;
  assert.ok(operation, 'the quote is in the document');
  const responses = operation.responses as Record<string, unknown>;
  assert.ok(responses['402'] && responses['503'] && responses['400']);
  const info = operation['x-payment-info'] as { price: Record<string, string>; protocols: Record<string, unknown>[] };
  assert.deepEqual(info.price, { mode: 'fixed', currency: 'USD', amount: MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1 });
  const parameters = operation.parameters as { in: string; name: string; required: boolean }[];
  assert.deepEqual(parameters.map((p) => [p.name, p.required]), [['asset', true], ['amount', true], ['borrowUsdc', false]]);
  // The retired routes are gone from the document an index registers from.
  for (const retired of RETIRED_PATHS_V1) assert.equal(doc.paths[`${X402_INTELLIGENCE_MOUNT_V1}${retired}`], undefined);
  assert.deepEqual(doc.paths[`${X402_INTELLIGENCE_MOUNT_V1}/catalog`]?.get?.security, []);
  await request(appV1()).get(`${X402_INTELLIGENCE_MOUNT_V1}/openapi.json`).expect(404);
});

test('the official x402 challenge prices the quote in Base USDC and says what it answers', async () => {
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
  let reads = 0;
  const app = express();
  app.use(X402_INTELLIGENCE_MOUNT_V1, createX402IntelligenceRouterV1({
    env: { ...ENV, X402_FACILITATOR_URL: `http://127.0.0.1:${port}`, BASE_BUILDER_CODE: 'miorail', PUBLIC_API_BASE_URL: 'https://miorail.xyz' },
    dbEnabled: false,
    readStillMarket: async () => { reads += 1; return readingV1(); },
  }));
  try {
    for (const query of [{}, { asset: 'NVDAc', amount: '10' }]) {
      const response = await request(app).get(QUOTE).query(query).expect(402);
      const challenge = decodePaymentRequiredHeader(response.headers['payment-required'] as string);
      assert.equal(challenge.x402Version, 2);
      assert.equal(challenge.accepts[0]?.amount, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
      assert.equal(challenge.accepts[0]?.network, 'eip155:8453');
      assert.equal(challenge.accepts[0]?.asset.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
      assert.equal(challenge.resource?.url, `https://miorail.xyz${QUOTE}`);
      assert.match(challenge.resource?.description ?? '', /^What Still would lend in USDC against a tokenized stock/);
      // The whole challenge rides in one header. 3.9 KB of it, with the rest of
      // the headers, overflowed nginx's 4 KB buffer and every client got 502.
      // Named, tagged and pictured for Bazaar search, within the facilitator's rules.
      assert.equal(challenge.resource?.serviceName, 'Still loan quote');
      assert.deepEqual(challenge.resource?.tags, ['lending', 'borrow', 'tokenized-stocks', 'loan-quote', 'base']);
      assert.equal(challenge.resource?.iconUrl, 'https://miorail.xyz/still-favicon-192.png');
      // The icon is a file the app publishes; renaming it would leave the Bazaar a broken image.
      assert.ok(existsSync(packageFileV1('../interface/public/still-favicon-192.png')), 'the Bazaar icon must be a published file');
      const size = String(response.headers['payment-required']).length;
      assert.ok(size <= X402_CHALLENGE_HEADER_BUDGET_V1, `PAYMENT-REQUIRED is ${size} bytes, over ${X402_CHALLENGE_HEADER_BUDGET_V1}`);
    }
    // The price costs no reading of Base, asked or not.
    assert.equal(reads, 0);
  } finally {
    await new Promise<void>((resolve) => facilitator.close(() => resolve()));
  }
});

test('a paid quote is the engine’s, bound by its hash, with an evidence package on its claims', async () => {
  const seen: Array<{ path: string; options: CreateX402MiddlewareOptions }> = [];
  const app = appV1({ middlewareFactory: (p: string, options: CreateX402MiddlewareOptions) => { seen.push({ path: p, options }); return PASS_THROUGH_V1; } });
  const response = await request(app).get(QUOTE).query({ asset: 'nvdac', amount: '10', borrowUsdc: '500' }).expect(200);
  const body = X402StillLoanQuoteV1Schema.parse(response.body);
  assert.equal(body.dataHash, hashX402IntelligenceDataV1(body));
  assert.equal(response.headers['x-miorail-data-hash'], body.dataHash);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(body.question, {
    asset: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', decimals: 8, amount: '10', amountRaw: '1000000000', borrowUsdc: '500',
  });
  // The example wallet owes $240.17 and holds NVDAc; none of it is in the quote.
  assert.equal(body.limit.stillLimitCents, '74167');
  assert.equal(body.limit.protocolLimitCents, '148334');
  assert.equal(body.atStillLimit?.outcome, 'computed');
  if (body.atStillLimit?.outcome === 'computed') {
    assert.equal(body.atStillLimit.figures.healthFactorText, '2.00');
    assert.deepEqual(body.atStillLimit.figures.stress.map((row) => [row.fallBps, row.liquidationCanStart]), [[1000, false], [2000, false], [3000, false]]);
  }
  assert.equal(body.requested?.withinStillLimit, true);
  assert.equal(body.requested?.loan.outcome, 'computed');
  assert.match(body.caveats.join(' '), /not an offer/);
  assert.match(body.caveats.join(' '), /not offered to US persons/);
  assert.ok(!/guarantee|risk-free|no liquidation|cannot be liquidated/i.test(body.caveats.join(' ')));
  const evidence = EvidencePackageV1Schema.parse(body.evidencePackage);
  assert.ok(evidence.claims.some((claim) => claim.paths.includes('/collateral/priceCents') && claim.block === body.reading.block));
  // One route, priced at the one constant, described as what it answers.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.options.amountAtomicOverride, MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1);
  assert.match(seen[0]!.options.description ?? '', /No wallet needed\.$/);
  assert.ok((seen[0]!.options.description ?? '').length <= 180, 'the 402 description is the short one');
});

test('a question that is not one is refused before the price, and nothing is read', async () => {
  let charges = 0;
  let reads = 0;
  const app = appV1({
    middlewareFactory: () => ((_req, _res, next) => { charges += 1; next(); }) as RequestHandler,
    readStillMarket: async () => { reads += 1; return readingV1(); },
  });
  for (const [query, code] of [
    [{ asset: 'NVDA', amount: '10' }, 'unsupported_collateral'], // a ticker names three issuers' contracts
    [{ asset: '0x2222222222222222222222222222222222222222', amount: '10' }, 'unsupported_collateral'],
    [{ asset: 'NVDAc', amount: '0' }, 'invalid_amount'],
    [{ asset: 'NVDAc', amount: '1.000000001' }, 'invalid_amount'], // NVDAc has 8 decimals
    [{ asset: 'NVDAc', amount: '-1' }, 'invalid_amount'],
    [{ asset: 'NVDAc', amount: '10', borrowUsdc: '0' }, 'invalid_borrow'],
    [{ asset: 'NVDAc', amount: '10', borrowUsdc: '1.0000001' }, 'invalid_borrow'],
  ] as const) {
    const response = await request(app).get(QUOTE).query(query).expect(400);
    assert.equal(response.body.code, code);
    assert.match(response.body.message, /Nothing was charged\.$/);
  }
  assert.equal(charges, 0);
  assert.equal(reads, 0);
});

test('when Base cannot be read the answer is 503, so the payment is never settled', async () => {
  const app = appV1({ readStillMarket: async () => { throw new Error('every provider refused'); } });
  const response = await request(app).get(QUOTE).query({ asset: 'cbBTC', amount: '0.01' }).expect(503);
  assert.equal(response.body.code, 'still_reading_unavailable');
  assert.equal(response.headers['retry-after'], '15');
});

test('a reading without everything the quote rests on is 503 and settles nothing (audit QUOTE-1)', async () => {
  // A reading with no Aave in it gave newLoans "open" with every limit null, sold as an answer.
  const noAave = readingV1();
  noAave.universe = { ...noAave.universe, aave: { ok: false, problem: 'unreadable' } } as MirrorInput['universe'];
  const app = appV1({ readStillMarket: async () => noAave });
  const response = await request(app).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(503);
  assert.equal(response.body.code, 'still_reading_unavailable');
  // The same reading still answers for a collateral that does not rest on Aave.
  await request(app).get(QUOTE).query({ asset: 'cbBTC', amount: '0.01' }).expect(200);
});

test('cbBTC and PAXG are asked whether their own contract holds a pledge, at the reading\'s block (audit QUOTE-1)', async () => {
  const asked: string[] = [];
  const held = (answer: { paused: boolean | null; marketFrozen: boolean | null } | null) => appV1({
    readStillCollateralHold: async (asset: { id: string }, block: bigint) => {
      asked.push(`${asset.id}@${block}`);
      return answer === null ? null : { ...answer, walletFrozen: null };
    },
  });
  const paused = await request(held({ paused: true, marketFrozen: false })).get(QUOTE).query({ asset: 'PAXG', amount: '1', borrowUsdc: '100' }).expect(200);
  const quote = X402StillLoanQuoteV1Schema.parse(paused.body);
  assert.deepEqual([quote.limit.newLoans, quote.limit.closedBecause, quote.limit.availableNowCents, quote.atStillLimit],
    ['closed', ['issuer_paused'], '0', null]);
  const frozen = X402StillLoanQuoteV1Schema.parse((await request(held({ paused: false, marketFrozen: true })).get(QUOTE).query({ asset: 'cbBTC', amount: '0.01' }).expect(200)).body);
  assert.deepEqual(frozen.limit.closedBecause, ['venue_frozen_by_issuer']);
  // A hold that could not be read is not read as none: 503, nothing settled.
  for (const answer of [null, { paused: null, marketFrozen: false }, { paused: false, marketFrozen: null }]) {
    const response = await request(held(answer)).get(QUOTE).query({ asset: 'cbBTC', amount: '0.01' }).expect(503);
    assert.equal(response.body.code, 'still_reading_unavailable');
  }
  // Asked at the block the Mirror read; a stock and WETH are never asked.
  assert.ok(asked.every((entry) => entry.endsWith(`@${readingV1().snapshot.block.number}`)), asked.join());
  const before = asked.length;
  await request(held({ paused: true, marketFrozen: true })).get(QUOTE).query({ asset: 'ETH', amount: '1' }).expect(200);
  await request(held({ paused: true, marketFrozen: true })).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(200);
  assert.equal(asked.length, before);
});

// Audit P2-1, 2026-11-18: the quote read Coinbase's registry flag only, and a borrow review also refuses on the
// stock's own B20 transfer pause; and an unread Aave rate passed as a complete quote with a null rate.
test('a stock is asked whether its own B20 contract pauses transfers, at the reading\'s block, and a rate is required', async () => {
  const asked: string[] = [];
  const stockApp = (answer: boolean | null, reading = readingV1()) => appV1({
    readStillMarket: async () => reading,
    readStillStockTransfersPaused: async (asset: { id: string }, block: bigint) => {
      asked.push(`${asset.id}@${block}`);
      return answer;
    },
  });
  const paused = X402StillLoanQuoteV1Schema.parse((await request(stockApp(true)).get(QUOTE).query({ asset: 'NVDAc', amount: '10', borrowUsdc: '100' }).expect(200)).body);
  assert.deepEqual([paused.limit.newLoans, paused.limit.closedBecause, paused.limit.availableNowCents, paused.atStillLimit],
    ['closed', ['issuer_paused'], '0', null]);
  const open = X402StillLoanQuoteV1Schema.parse((await request(stockApp(false)).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(200)).body);
  assert.equal(open.limit.newLoans, 'open');
  assert.ok(asked.every((entry) => entry === `NVDAc@${readingV1().snapshot.block.number}`), asked.join());
  // A pause that could not be read is not read as none: 503, nothing settled.
  const unread = await request(stockApp(null)).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(503);
  assert.equal(unread.body.code, 'still_reading_unavailable');
  // cbBTC is never asked a stock's question.
  const before = asked.length;
  await request(stockApp(true)).get(QUOTE).query({ asset: 'cbBTC', amount: '0.01' }).expect(200);
  assert.equal(asked.length, before);
  // The rate the catalog promises: unread, the quote is not sold.
  const noRate = readingV1();
  noRate.snapshot.aave!.usdcDrawnRateRay = { ok: false, reason: 'reverted' };
  const rateless = await request(stockApp(false, noRate)).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(503);
  assert.equal(rateless.body.code, 'still_reading_unavailable');
});

test('a request that asks for nothing is answered with the price, and reads nothing', async () => {
  const priced: string[] = [];
  let reads = 0;
  const app = appV1({
    middlewareFactory: (p: string) => ((_req, res) => { priced.push(p); res.status(402).json({ x402Version: 2 }); }) as RequestHandler,
    readStillMarket: async () => { reads += 1; return readingV1(); },
  });
  await request(app).get(QUOTE).expect(402);
  assert.deepEqual(priced, ['/still/loan-quote']);
  assert.equal(reads, 0);
});

test('every retired resource answers 410 to every method, names where its answer is free, and charges nothing', async () => {
  let charges = 0;
  const app = appV1({
    env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' },
    middlewareFactory: () => ((_req, _res, next) => { charges += 1; next(); }) as RequestHandler,
  });
  for (const retired of RETIRED_PATHS_V1) {
    for (const method of ['get', 'post', 'head'] as const) {
      const response = await request(app)[method](`${X402_INTELLIGENCE_MOUNT_V1}${retired}`).query({ tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c' }).expect(410);
      if (method !== 'head') {
        assert.equal(response.body.code, 'x402_resource_retired');
        assert.match(response.body.instead, /^Free: /);
      }
    }
  }
  const identity = await request(app).get(`${X402_INTELLIGENCE_MOUNT_V1}/address/identity`).expect(410);
  assert.match(identity.body.instead, /check_address_identity at https:\/\/miorail\.xyz\/mcp/);
  assert.equal(charges, 0);
});

test('another method on the quote is 405, not a 401 that implies a key would help', async () => {
  const app = appV1();
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    const response = await request(app)[method](QUOTE).expect(405);
    assert.equal(response.headers.allow, 'GET');
  }
});

// Audit X402-1, 2026-11-20: a HEAD passed the payment, declared for GET only, and the handler read Base unpaid.
test('a HEAD on the quote is 405 before anything is paid for or read', async () => {
  let charges = 0;
  const app = appV1({ middlewareFactory: () => ((_req, _res, next) => { charges += 1; next(); }) as RequestHandler });
  const response = await request(app).head(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(405);
  assert.equal(response.headers.allow, 'GET');
  assert.equal(response.headers['x-miorail-data-hash'], undefined);
  assert.equal(charges, 0);
});

test('the 402 names an address, not a path, and it is the path this router is mounted at', async () => {
  const seen: CreateX402MiddlewareOptions[] = [];
  const app = appV1({
    env: { ...ENV, PUBLIC_API_BASE_URL: 'https://miorail.xyz' },
    middlewareFactory: (_p: string, options: CreateX402MiddlewareOptions) => { seen.push(options); return PASS_THROUGH_V1; },
  });
  await request(app).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(200);
  assert.equal(seen[0]?.resourceOrigin, `https://miorail.xyz${X402_INTELLIGENCE_MOUNT_V1}`);
  const mounted = readFileSync(packageFileV1('routes/index.ts'), 'utf8');
  assert.ok(mounted.includes(`'${X402_INTELLIGENCE_MOUNT_V1.replace('/api', '')}'`), `routes/index.ts does not mount the router at ${X402_INTELLIGENCE_MOUNT_V1}`);

  // A base that is not https is ignored rather than concatenated.
  const half: CreateX402MiddlewareOptions[] = [];
  await request(appV1({
    env: { ...ENV, PUBLIC_API_BASE_URL: 'miorail.xyz' },
    middlewareFactory: (_p: string, options: CreateX402MiddlewareOptions) => { half.push(options); return PASS_THROUGH_V1; },
  })).get(QUOTE).query({ asset: 'NVDAc', amount: '10' }).expect(200);
  assert.equal(half[0]?.resourceOrigin, undefined);
  // And no icon is named on a host that is not one.
  assert.equal(half[0]?.iconUrl, undefined);
});

test('the paid route declares itself for the discovery list with an example its own preload answers', async () => {
  const seen: CreateX402MiddlewareOptions[] = [];
  let reads = 0;
  const app = appV1({
    middlewareFactory: (_p: string, options: CreateX402MiddlewareOptions) => { seen.push(options); return PASS_THROUGH_V1; },
    readStillMarket: async () => { reads += 1; return readingV1(); },
  });
  const discovery = seen[0]?.discovery as { input?: Record<string, string>; inputSchema?: { required?: string[] }; output?: { example?: unknown } } | undefined;
  assert.ok(discovery?.output?.example, 'it must show the shape it returns');
  assert.deepEqual(discovery?.inputSchema?.required, ['asset', 'amount']);
  // The proof resource declared an example its own validator refused, and every
  // rater that tried it graded the resource broken. This one is sent through.
  const before = reads;
  const response = await request(app).get(QUOTE).query(discovery!.input!).expect(200);
  assert.equal(response.body.question.asset, 'NVDAc');
  assert.equal(reads, before + 1);
});

test('a receipt carries the delivered hash and the buyer’s own client name', () => {
  const delivered = sellerReceiptDetailsV1({
    base: { txHash: '0xabc' },
    service: 'still_loan_quote',
    requestHash: '0xrequest',
    paymentStatus: 'settled',
    delivery: { dataHash: '0xdata', deliveredAt: '2026-11-16T10:00:00.000Z' },
    userAgent: 'lumiere-paycheck-prober/1.0',
  });
  assert.equal(delivered.deliveryStatus, 'delivered');
  assert.equal(delivered.dataHash, '0xdata');
  assert.equal(delivered.txHash, '0xabc', 'the facilitator record must survive');
  assert.deepEqual(delivered.client, { userAgent: 'lumiere-paycheck-prober/1.0' });

  const pending = sellerReceiptDetailsV1({ base: {}, service: 'still_loan_quote', requestHash: '0xrequest', paymentStatus: 'settled', delivery: null });
  assert.equal(pending.deliveryStatus, 'pending');
  assert.equal('dataHash' in pending, false, 'an undelivered sale must not carry a hash key');
  assert.deepEqual(pending.client, { userAgent: null });

  assert.equal(userAgentOfV1('a\u0000b\nc'), 'a b c');
  assert.equal(userAgentOfV1('x'.repeat(500))?.length, 200);
  assert.equal(userAgentOfV1(undefined), null);
});

test('delivery is recorded on the request context before the receipt is looked up', () => {
  // Settlement lands after the response, so the handler reaches delivery first,
  // when no receipt row exists yet. Guarding the source because the failing path
  // writes nothing at all, so no in-process assertion can observe it.
  const source = readFileSync(packageFileV1('routes/x402/intelligence.ts'), 'utf8');
  const body = /async function markSellerDeliveryV1[\s\S]*?\n}/.exec(source)?.[0] ?? '';
  const stamped = body.indexOf('context.delivery =');
  const earlyReturn = body.indexOf('if (!context.receiptId) return;');
  assert.ok(stamped > 0 && earlyReturn > 0 && stamped < earlyReturn,
    'recording delivery after the early return is the defect: it never runs on a real sale');
});
