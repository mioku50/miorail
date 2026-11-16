import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { db, x402Receipts } from '@mioagent/db';
import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1,
  X402_INTELLIGENCE_RETIRED_AT_V1,
  X402SellerCatalogV1Schema,
  X402StillLoanQuoteV1Schema,
  hashX402IntelligenceDataV1,
  stableHashV1,
  x402IntelligencePaymentV1,
  type X402ActiveIntelligenceServiceV1,
  type X402IntelligenceServiceV1,
} from '@mioagent/route-domain';
import type { MirrorInput } from '@mioagent/still-engine';
import {
  createX402MiddlewareFromEnv,
  x402ConfigFromEnv,
  type DeclareDiscoveryExtensionInput,
  type CreateX402MiddlewareOptions,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';

import { stillMirrorRuntimeV1 } from '../../lib/stillMirror.js';
import {
  parseStillQuoteQuestionV1,
  stillLoanQuoteDraftV1,
  stillLoanQuoteFromReadingV1,
  type StillQuoteQuestionV1,
} from './stillLoanQuote.js';

interface SellerRequestContextV1 {
  service: X402IntelligenceServiceV1;
  requestHash: string;
  receiptId: string | null;
  /**
   * The delivered response hash, recorded the moment the handler produces it.
   *
   * Settlement runs on the resource server's `onAfterSettle` hook, which fires
   * AFTER the response has been produced — so the handler always reaches
   * delivery first, when no receipt row exists yet. Keeping the hash on the
   * request context is what makes the two facts order-independent: whichever
   * of the two runs second writes both.
   */
  delivery: { dataHash: string; deliveredAt: string } | null;
  /** Who asked, as their own client names itself: the one way to tell a probe from a buyer (2026-11-16). */
  userAgent: string | null;
}

interface CreateX402IntelligenceRouterOptionsV1 {
  env?: NodeJS.ProcessEnv;
  dbEnabled?: boolean;
  now?: () => Date;
  middlewareFactory?: (
    routePath: string,
    options: CreateX402MiddlewareOptions,
  ) => RequestHandler;
  /** One market reading for a quote: Still's own reading of Base at one block. A seam, so a test hands one in. */
  readStillMarket?: () => Promise<MirrorInput>;
}

const requestContext = new AsyncLocalStorage<SellerRequestContextV1>();

/**
 * Where these routes actually live, so the 402 can name an address rather than
 * a path.
 *
 * CDP's discovery refused every submission with `resource must start with
 * 'https://' when protocol type is http`, because the challenge carried
 * `resource: "/b20/exit-analysis"` — the path as Express knows it, with no
 * host. An index cannot come back to that.
 *
 * Pinned against `routes/index.ts` by `intelligence.test.ts`: move the mount
 * and the test fails rather than the listing silently going stale.
 */
export const X402_INTELLIGENCE_MOUNT_V1 = '/api/x402/intelligence/v1';

function resourceOriginV1(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base || !/^https:\/\//.test(base)) return undefined;
  return `${base}${X402_INTELLIGENCE_MOUNT_V1}`;
}

/** The public origin resources are named by: `PUBLIC_API_BASE_URL`, https only. */
function publicOriginV1(env: NodeJS.ProcessEnv): string | null {
  const base = env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  return base && /^https:\/\//.test(base) ? base : null;
}

/** What an operation's declaration is read for. `@x402/extensions` types the
 * input schema loosely, so this is the part of it the document relies on. */
interface DeclaredInputV1 {
  inputSchema?: { properties?: Record<string, { description?: string }>; required?: readonly string[] };
  output?: { example?: unknown };
}

const X402_OPENAPI_GUIDANCE_V1 = [
  'Every paid operation is a GET that answers 402 first. Read the x402 v2 challenge from the PAYMENT-REQUIRED header, sign the USDC authorization on Base (eip155:8453) for exactly the amount it names, and repeat the same request with the PAYMENT-SIGNATURE header.',
  'Inputs are checked before the price: a malformed input answers 400 and is not charged. A payment settles only when the answer is delivered: if Base cannot be read, the answer is 503 and nothing is charged.',
  'A loan quote is what Still would lend now against an exact amount, read live at one Base block with the engine of Still’s own loan review. It is not an offer or a recommendation, and Still is not offered to US persons.',
  'Assets are Still’s own: eight Coinbase tokenized stocks (AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc), cbBTC, ETH and PAXG, by that name or by exact Base token address. A ticker such as NVDA is refused: three issuers publish NVIDIA on Base.',
].join(' ');

/**
 * The paid surface as an OpenAPI document.
 *
 * x402scan registers a seller from `/openapi.json` alone. Its discovery tool
 * (`@agentcash/discovery` 1.7.5) says of `/.well-known/x402` that it "no longer
 * parses these", and on 2026-09-25 "Add Server" answered "No discovery document
 * found" while that document was live. Built from the catalog and each route's
 * Bazaar declaration, so the price, the paths and the inputs are the ones the
 * 402 challenge carries.
 */
export function x402OpenApiDocumentV1(input: {
  origin: string;
  services: readonly { id: X402ActiveIntelligenceServiceV1; method: string; path: string; description: string }[];
  declarations: Readonly<Record<X402ActiveIntelligenceServiceV1, DeclaredInputV1>>;
  payment: { network: string; asset: string; amountAtomic: string; amountUsdc: string };
}) {
  const paths: Record<string, unknown> = {};
  for (const service of input.services) {
    const declared = input.declarations[service.id];
    const required = new Set(declared?.inputSchema?.required ?? []);
    paths[service.path] = {
      [service.method.toLowerCase()]: {
        operationId: service.id,
        summary: service.description,
        tags: ['x402'],
        parameters: Object.entries(declared?.inputSchema?.properties ?? {}).map(([name, schema]) => ({
          in: 'query',
          name,
          required: required.has(name),
          ...(schema.description ? { description: schema.description } : {}),
          schema: { type: 'string' },
        })),
        responses: {
          '200': {
            description: 'The quote, with every read that could not be made named in missingEvidence.',
            content: {
              'application/json': {
                schema: { type: 'object' },
                ...(declared?.output?.example !== undefined ? { example: declared.output.example } : {}),
              },
            },
          },
          '400': { description: 'Malformed input or a collateral Still does not lend against, refused before the price. Nothing is charged.' },
          '402': {
            description:
              'Payment required. The x402 v2 challenge is in the PAYMENT-REQUIRED header; a refused payment also says why in the body (`payment_refused`).',
          },
          '503': { description: 'Base could not be read at one block. The payment is not settled and nothing is charged; ask again.' },
        },
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: input.payment.amountUsdc },
          protocols: [
            {
              x402: {
                version: 2,
                scheme: 'exact',
                network: input.payment.network,
                asset: input.payment.asset,
                amount: input.payment.amountAtomic,
              },
            },
          ],
        },
      },
    };
  }
  paths[`${X402_INTELLIGENCE_MOUNT_V1}/catalog`] = {
    get: {
      operationId: 'catalog',
      summary: 'The price list: what is sold, its inputs, what it does not establish, and where each retired answer is free.',
      tags: ['x402'],
      security: [],
      responses: { '200': { description: 'The catalog.', content: { 'application/json': { schema: { type: 'object' } } } } },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Miorail paid API: Still loan quotes',
      version: 'x402-intelligence-v1',
      description:
        'What Still would lend in USDC against an exact amount of a tokenized stock, bitcoin, ether or gold on Base, read live with Still’s own engine, with no wallet: Still’s limit beside the protocol’s own, the venue’s rate and liquidity, the liquidation price and a stress table. Sold per request over x402 in USDC on Base.',
      'x-guidance': X402_OPENAPI_GUIDANCE_V1,
    },
    servers: [{ url: input.origin }],
    tags: [{ name: 'x402' }],
    paths,
  };
}

function sellerEnabledV1(env: NodeJS.ProcessEnv): boolean {
  return env.MIORAIL_X402_SELLER_INTELLIGENCE_V1?.trim().toLowerCase() === 'true';
}

function receiptIdV1(record: X402SettlementRecord): string {
  return record.txHash
    ? `x402:seller:${record.network}:${record.txHash.toLowerCase()}`
    : `x402:seller:${randomUUID()}`;
}

/** A client's own name for itself, bounded and with no control characters. */
export function userAgentOfV1(value: string | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return clean || null;
}

/**
 * The `details` of a seller receipt.
 *
 * Settlement and delivery are two independently persisted facts, and "sold"
 * means both. Which of the two is written first is NOT stable — settlement
 * arrives on `onAfterSettle`, i.e. after the response — so this takes the
 * delivery as an argument and carries it whenever it is already known. Pure,
 * so the joint state is testable without a database.
 *
 * `client` is the buyer's own User-Agent. Until 2026-11-16 telling a probe
 * from a buyer meant matching nginx's log to the second of the settlement.
 */
export function sellerReceiptDetailsV1(input: {
  base: Record<string, unknown>;
  service: X402IntelligenceServiceV1;
  requestHash: string;
  paymentStatus: string;
  delivery: { dataHash: string; deliveredAt: string } | null;
  userAgent?: string | null;
}): Record<string, unknown> {
  return {
    ...input.base,
    service: input.service,
    requestHash: input.requestHash,
    paymentStatus: input.paymentStatus,
    deliveryStatus: input.delivery ? 'delivered' : 'pending',
    ...(input.delivery
      ? { dataHash: input.delivery.dataHash, deliveredAt: input.delivery.deliveredAt }
      : {}),
    client: { userAgent: input.userAgent ?? null },
  };
}

async function persistSellerSettlementV1(record: X402SettlementRecord, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const context = requestContext.getStore();
  if (!context) return;
  const id = receiptIdV1(record);
  context.receiptId = id;
  const receipt = {
    ...record,
    id,
    direction: 'incoming_seller_payment',
    category: 'seller_intelligence',
    service: context.service,
    details: sellerReceiptDetailsV1({
      base: record.details ?? {},
      service: context.service,
      requestHash: context.requestHash,
      paymentStatus: record.status,
      delivery: context.delivery,
      userAgent: context.userAgent,
    }),
  };
  await db
    .insert(x402Receipts)
    .values({ id, receipt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: x402Receipts.id,
      set: { receipt, updatedAt: new Date() },
    });
}

async function markSellerDeliveryV1(dataHash: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const context = requestContext.getStore();
  if (!context) return;
  // Record the delivery on the context FIRST, unconditionally. On the real
  // ordering there is no receipt row yet, and the previous version returned
  // here — so a settled, delivered sale stayed `deliveryStatus: pending` with
  // no dataHash forever, and `x402IntelligenceSold` (which counts only when
  // both facts exist) reported 0 through a genuine sale.
  context.delivery = { dataHash, deliveredAt: new Date().toISOString() };
  if (!context.receiptId) return;
  const rows = await db.select().from(x402Receipts).where(eq(x402Receipts.id, context.receiptId)).limit(1);
  const existing = rows[0]?.receipt && typeof rows[0].receipt === 'object'
    ? rows[0].receipt as Record<string, unknown>
    : null;
  if (!existing) return;
  const details = existing.details && typeof existing.details === 'object'
    ? existing.details as Record<string, unknown>
    : {};
  await db.update(x402Receipts).set({
    receipt: {
      ...existing,
      details: {
        ...details,
        deliveryStatus: 'delivered',
        dataHash,
        deliveredAt: context.delivery.deliveredAt,
      },
    },
    updatedAt: new Date(),
  }).where(eq(x402Receipts.id, context.receiptId));
}

const STILL_LOAN_QUOTE_PATH_V1 = '/still/loan-quote';

/** One sentence: the line the Bazaar indexes and an agent's model reads to choose this resource. */
const STILL_LOAN_QUOTE_DESCRIPTION_V1 =
  'What Still would lend in USDC against an exact amount of a Coinbase tokenized stock, cbBTC, ETH or PAXG on Base, read live: Still’s limit beside the protocol’s own, the venue’s rate and liquidity, the liquidation price and a 10/20/30% fall table. No wallet needed.';

/**
 * Retired 2026-11-16, each with where its answer is free (see
 * X402_INTELLIGENCE_RETIRED_SERVICES_V1 for why). They answer 410 to every
 * method and charge nothing.
 */
function retiredV1(origin: string | null) {
  const mcp = `${origin ?? ''}/mcp`;
  return [
    {
      id: 'b20_exit_analysis' as const,
      path: '/b20/exit-analysis',
      instead: `Free: the MCP tool miorail_get_b20_opportunity at ${mcp}. The B20 launch feed has been frozen since 2026-09-09, and that tool says how old each measurement is.`,
    },
    {
      id: 'b20_liquidity_evidence' as const,
      path: '/b20/liquidity-evidence',
      instead: `Free: the MCP tool miorail_get_b20_opportunity at ${mcp}, with route sources, controls and pool hooks. The B20 launch feed has been frozen since 2026-09-09.`,
    },
    {
      id: 'enhanced_route_proof' as const,
      path: '/route-proofs/enhanced',
      instead: `Free: ${origin ?? ''}/api/public/proofs/{publicId}/bundle, checked by the open-source verifier (@mioagent/proof-verifier) or on the proof page itself.`,
    },
    {
      id: 'stock_representation_choice' as const,
      path: '/stocks/representations',
      instead: `Free: the MCP tools get_representations and compare_market_reality at ${mcp}, with an evidence package on every claim.`,
    },
    {
      id: 'address_identity_check' as const,
      path: '/address/identity',
      instead: `Free: the MCP tool check_address_identity at ${mcp}, with an evidence package on every claim.`,
    },
  ];
}

function sellerCatalogV1(env: NodeJS.ProcessEnv) {
  const config = x402ConfigFromEnv(env);
  // `status` describes a DELIVERED payment and has no meaning on a price list.
  // Dropped by name rather than spread as undefined: the catalogue schema is
  // strict, and a key carrying undefined is still a key.
  const { status: _status, ...price } = x402IntelligencePaymentV1();
  return X402SellerCatalogV1Schema.parse({
    schemaVersion: 'x402-intelligence-catalog/v1',
    provider: 'Miorail',
    chainId: 8453,
    enabled: sellerEnabledV1(env) && config.configured && config.settleReady === true && config.network === 'eip155:8453',
    // The price is written ONCE, in the contract. It was written twice here
    // and the second copy is how a catalogue advertising 0.001 could have sat
    // above a challenge charging 0.002 — the schema's literals caught it,
    // which is what the literals are for.
    payment: price,
    services: [
      {
        id: 'still_loan_quote',
        method: 'GET',
        path: `${X402_INTELLIGENCE_MOUNT_V1}${STILL_LOAN_QUOTE_PATH_V1}`,
        description: STILL_LOAN_QUOTE_DESCRIPTION_V1,
        input: [
          'asset (required; AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc, cbBTC, ETH or PAXG, or its exact Base token address)',
          'amount (required; tokens to pledge, as a decimal: 10 or 0.25)',
          'borrowUsdc (optional; a loan to compute at that size, in USDC: 500)',
        ],
      },
    ],
    retired: retiredV1(publicOriginV1(env)).map((entry) => ({
      id: entry.id,
      path: `${X402_INTELLIGENCE_MOUNT_V1}${entry.path}`,
      retiredAt: X402_INTELLIGENCE_RETIRED_AT_V1,
      instead: entry.instead,
    })),
    constraints: [
      `Every paid resource costs exactly ${MIORAIL_X402_INTELLIGENCE_PRICE_USDC_V1} USDC on Base.`,
      'A loan quote is read live at one Base block with Still’s own engine. It is not an offer, a recommendation or a commitment to lend, and Still is not offered to US persons.',
      'Inputs are checked before the price; a malformed ask answers 400 and is not charged. A payment settles only with a delivered answer: when Base cannot be read the answer is 503 and nothing is charged.',
      'A figure the reading could not carry is null and the read that failed is named; nothing is estimated.',
      'No endpoint signs, broadcasts, approves, or prepares wallet calls.',
      'The five resources retired on 2026-11-16 answer 410 and name where their answers are free.',
    ],
  });
}

/** A reading of Base for a quote: Still's own, for an address that holds nothing, at one block, kept twenty seconds. */
async function readStillMarketV1(): Promise<MirrorInput> {
  const reading = await stillMirrorRuntimeV1.service().reading('0x0000000000000000000000000000000000000000');
  if (reading.outcome !== 'report') throw new Error(`still market reading: ${reading.outcome}`);
  return reading.input;
}

export function createX402IntelligenceRouterV1(options: CreateX402IntelligenceRouterOptionsV1 = {}) {
  const router = Router();
  const env = options.env ?? process.env;
  const dbEnabled = options.dbEnabled !== false;
  const now = options.now ?? (() => new Date());
  const readStillMarket = options.readStillMarket ?? readStillMarketV1;

  const featureGate: RequestHandler = (_req, res, next) => {
    if (!sellerEnabledV1(env)) {
      res.status(404).json({ error: 'x402_intelligence_not_released', code: 'x402_intelligence_not_released' });
      return;
    }
    next();
  };

  /**
   * What each resource IS, for the facilitator's discovery list.
   *
   * Written here rather than in the gateway because only this file knows what
   * the endpoints answer. The `output.example` is a SHAPE, not a promise: it
   * shows an agent the fields it will get so it can tell whether this resource
   * answers its question before paying — including the fields that say what
   * Miorail did not establish, which is the half a quote never carries.
   *
   * The example input must be one the route answers: on 2026-11-16 the proof
   * resource declared `publicId: a1b2c3d4e5f6a7b8`, which its own validator
   * refused with a 400, and every rater that tried the example graded it broken.
   * A test sends it through the preload.
   */
  const DISCOVERY_V1: Record<X402ActiveIntelligenceServiceV1, DeclareDiscoveryExtensionInput> = {
    still_loan_quote: {
      input: { asset: 'NVDAc', amount: '10' },
      inputSchema: {
        properties: {
          asset: {
            type: 'string',
            description: 'AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc, cbBTC, ETH or PAXG, or its exact Base token address',
          },
          amount: { type: 'string', description: 'Tokens to pledge, as a decimal: 10 or 0.25' },
          borrowUsdc: { type: 'string', description: 'Optional: a loan to compute at that size, in USDC: 500' },
        },
        required: ['asset', 'amount'],
      },
      output: {
        example: {
          service: 'still_loan_quote',
          question: { asset: 'NVDAc', amount: '10', borrowUsdc: null },
          reading: { block: '58159930', blockTime: '2026-11-16T09:46:01.000Z' },
          collateral: { symbol: 'NVDAc', priceCents: '21190', protocolFactorBps: 7000, stillFactorBps: 3500, limits: [] },
          venue: { label: 'Aave V4 · Coinbase Stocks', liquidityCents: '109645815', borrowRateBps: 366 },
          limit: { stillLimitCents: '74167', protocolLimitCents: '148334', availableNowCents: '74167', newLoans: 'open' },
          atStillLimit: {
            outcome: 'computed',
            figures: {
              healthFactorText: '2.00',
              marginBps: 5000,
              state: 'calm',
              liquidationPriceCents: '10596',
              stress: [{ fallBps: 3000, liquidationCanStart: false }],
            },
          },
          missingEvidence: [],
        },
      },
    },
  };

  /**
   * The paid chain for one route: price it, check it, charge for it.
   *
   * The preload travels THROUGH here rather than being typed beside it at each
   * `router.get`, because the order of these three is the whole correctness of
   * the surface and it was a per-route decision written out five times.
   *
   * "WHAT DOES THIS COST?" IS NOT A MALFORMED REQUEST FOR THE ANSWER.
   *
   * Every route ran its argument check first, so a request with no query
   * string — which is exactly what a crawler, an index or an agent meeting the
   * resource for the first time sends — got `400
   * invalid_x402_intelligence_request` and never saw a price. Measured
   * 2026-09-19: all five resources answered 400 bare, and CDP's own validator
   * reported `returns_402: false — Endpoint returned HTTP 400 instead of 402`
   * with every later check skipped.
   *
   * So a request that names none of the required inputs is answered with the
   * 402 challenge: the price, the network, the payTo and the Bazaar
   * declaration saying what to send and what comes back. It performs no read,
   * promises no answer and charges nothing.
   *
   * A request that DOES name an input keeps the old order — validated first,
   * so a malformed ask is refused rather than billed.
   */
  function paidMiddleware(
    service: X402ActiveIntelligenceServiceV1,
    routePath: string,
    description: string,
    preload: RequestHandler,
  ): RequestHandler[] {
    const middlewareOptions: CreateX402MiddlewareOptions = {
      routePath,
      serviceName: `Miorail ${service}`,
      amountAtomicOverride: MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
      description,
      // Settling payments does not put a resource in the discovery list —
      // three settled in August and the list held zero Miorail entries. A
      // declaration does.
      discovery: DISCOVERY_V1[service],
      // An address, not a path. Without it the discovery submission is refused
      // and nothing downstream ever runs.
      resourceOrigin: resourceOriginV1(env),
      onSettlement: async (record) => {
        try {
          await persistSellerSettlementV1(record, dbEnabled);
        } catch {
          // A storage outage must not turn a settled payment into a withheld
          // response. The response dataHash remains the buyer's service proof.
        }
      },
      runtimeMode: 'auto',
    };
    const gateway = options.middlewareFactory
      ? options.middlewareFactory(routePath, middlewareOptions)
      : createX402MiddlewareFromEnv(middlewareOptions, env);
    const requiredInputs: readonly string[] =
      (DISCOVERY_V1[service].inputSchema?.required as readonly string[] | undefined) ?? [];
    const context = (req: Request, requestHash: string): SellerRequestContextV1 =>
      ({ service, requestHash, receiptId: null, delivery: null, userAgent: userAgentOfV1(req.header('user-agent')) });
    return [
      (req: Request, res: Response, next: NextFunction) => {
        // Already paying (x402 v1 or v2), or already asking a real question: the old path.
        if (req.header('x-payment') !== undefined || req.header('payment-signature') !== undefined) return next();
        if (requiredInputs.some((name) => req.query[name] !== undefined)) return next();
        // Nothing asked. Answer with the price.
        requestContext.run(context(req, ''), () => gateway(req, res, next));
      },
      preload,
      (req: Request, res: Response, next: NextFunction) => {
        const requestHash = String(res.locals.x402IntelligenceRequestHash ?? '');
        requestContext.run(context(req, requestHash), () => gateway(req, res, next));
      },
    ];
  }

  // ------------------------------------------------------------------
  // still_loan_quote.
  //
  // The question is checked before the price and reads nothing: an unpaid
  // probe costs one regex. Base is read only after the payment verifies, and a
  // reading that fails answers 503 — the middleware settles nothing on an
  // answer of 400 or more, so a quote that could not be read is never charged.
  // ------------------------------------------------------------------
  const preloadQuote: RequestHandler = (req, res, next) => {
    const parsed = parseStillQuoteQuestionV1(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.code, code: parsed.code, message: parsed.message });
      return;
    }
    res.locals.x402StillQuestion = parsed.question;
    res.locals.x402IntelligenceRequestHash = stableHashV1('x402-intelligence-request/v1', {
      service: 'still_loan_quote',
      asset: parsed.question.ask.asset,
      amountRaw: parsed.question.ask.raw.toString(),
      borrowAtomic: parsed.question.ask.borrowAtomic === null ? null : parsed.question.ask.borrowAtomic.toString(),
    });
    next();
  };

  const sendQuote: RequestHandler = async (_req, res) => {
    const question = res.locals.x402StillQuestion as StillQuoteQuestionV1;
    let draft;
    try {
      const reading = await readStillMarket();
      draft = stillLoanQuoteDraftV1({
        quote: stillLoanQuoteFromReadingV1(reading, question),
        question,
        now: now(),
        payment: x402IntelligencePaymentV1(),
        requestHash: res.locals.x402IntelligenceRequestHash,
      });
    } catch {
      res.setHeader('Retry-After', '15');
      res.status(503).json({
        error: 'still_reading_unavailable',
        code: 'still_reading_unavailable',
        message: 'Base could not be read at one block right now. This is our failure; the payment is not settled and nothing was charged. Ask again shortly.',
      });
      return;
    }
    const payload = X402StillLoanQuoteV1Schema.parse({ ...draft, dataHash: hashX402IntelligenceDataV1(draft) });
    await markSellerDeliveryV1(payload.dataHash, dbEnabled).catch(() => undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Miorail-Data-Hash', payload.dataHash);
    res.json(payload);
  };

  router.get('/catalog', (_req, res) => res.json(sellerCatalogV1(env)));

  // x402scan and indexes like it discover a seller from one document at
  // /.well-known/x402 (nginx maps that path here): the absolute URL of every
  // paid resource, each of which answers a bare GET with its 402. Built from
  // the catalog, so a resource cannot be listed here and absent there, and
  // withheld whenever the catalog says payments cannot settle.
  router.get('/well-known', (_req, res) => {
    const catalog = sellerCatalogV1(env);
    const origin = publicOriginV1(env);
    if (!catalog.enabled || !origin) {
      res.status(404).json({ error: 'x402_intelligence_not_released', code: 'x402_intelligence_not_released' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ version: 1, resources: catalog.services.map((service) => `${origin}${service.path}`) });
  });

  // nginx maps /openapi.json here. Withheld on the same terms as the list.
  router.get('/openapi.json', (_req, res) => {
    const catalog = sellerCatalogV1(env);
    const origin = publicOriginV1(env);
    if (!catalog.enabled || !origin) {
      res.status(404).json({ error: 'x402_intelligence_not_released', code: 'x402_intelligence_not_released' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(
      x402OpenApiDocumentV1({
        origin,
        services: catalog.services,
        declarations: DISCOVERY_V1 as Record<X402ActiveIntelligenceServiceV1, DeclaredInputV1>,
        payment: catalog.payment,
      }),
    );
  });

  router.get(
    STILL_LOAN_QUOTE_PATH_V1,
    featureGate,
    ...paidMiddleware('still_loan_quote', STILL_LOAN_QUOTE_PATH_V1, STILL_LOAN_QUOTE_DESCRIPTION_V1, preloadQuote),
    sendQuote,
  );
  // Scanners send POST, PUT and PATCH to a GET resource; those fell through to
  // tenant auth and read as 401, a claim that a key would help. CORS
  // preflights pass on to the CORS handler.
  router.all(STILL_LOAN_QUOTE_PATH_V1, (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed', code: 'method_not_allowed', message: 'This resource answers GET.' });
  });

  for (const entry of retiredV1(publicOriginV1(env))) {
    router.all(entry.path, (req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(410).json({
        error: 'x402_resource_retired',
        code: 'x402_resource_retired',
        service: entry.id,
        retiredAt: X402_INTELLIGENCE_RETIRED_AT_V1,
        instead: entry.instead,
        message: 'This paid resource was retired because its answer is free. Nothing is charged here.',
      });
    });
  }

  return router;
}

export const x402IntelligenceRouterV1 = createX402IntelligenceRouterV1();
