import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { db, x402Receipts } from '@mioagent/db';
import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  X402AddressIdentityCheckV1Schema,
  X402B20IntelligenceV1Schema,
  X402EnhancedRouteProofV1Schema,
  X402SellerCatalogV1Schema,
  X402StockRepresentationChoiceV1Schema,
  hashX402IntelligenceDataV1,
  stableHashV1,
  x402IntelligencePaymentV1,
  type PublicProofBundleV1,
  type X402AddressIdentityCheckV1,
  type X402B20IntelligenceV1,
  type X402EnhancedRouteProofV1,
  type X402IntelligenceServiceV1,
  type X402StockRepresentationChoiceV1,
} from '@mioagent/route-domain';
import { verifyPublicProofBundleV1 } from '@mioagent/proof-verifier';
import {
  createX402MiddlewareFromEnv,
  x402ConfigFromEnv,
  type DeclareDiscoveryExtensionInput,
  type CreateX402MiddlewareOptions,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import type { B20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { B20OpportunityObservationV1 } from '@mioagent/route-storage';

import { answerB20CopilotV1 } from '../../lib/b20Copilot.js';
// The ONE exit judgement. A paid answer and a holder's own portfolio must not
// disagree about whether a sale was measured, or at what size.
import { decimalToAtomicUsdcV1, referenceExitAssessmentV1 } from '../../lib/b20ExitAssessment.js';
import { readB20EvidenceForTokenV1 } from '../b20Control.js';
import { readAddressDossierForX402V1 } from '../rwaInvestigate.js';
import { readMarketRealityForX402V1 } from '../rwaMarketReality.js';
import { loadPublicBundleV1 } from '../publicProof.js';
import { MIORAIL_MCP_CAVEATS_V1 } from '../mcp/tools.js';

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const PUBLIC_ID_V1 = /^[0-9a-f]{48,}$/;
const USDC_DECIMAL_V1 = /^\d{1,7}(?:\.\d{1,6})?$/;

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
}

interface B20EvidenceV1 {
  card: B20OpportunityCardV1;
  history: B20OpportunityObservationV1[];
}

interface CreateX402IntelligenceRouterOptionsV1 {
  env?: NodeJS.ProcessEnv;
  dbEnabled?: boolean;
  now?: () => Date;
  middlewareFactory?: (
    routePath: string,
    options: CreateX402MiddlewareOptions,
  ) => RequestHandler;
  loadB20?: (tokenAddress: string) => Promise<B20EvidenceV1 | null>;
  loadBundle?: (publicId: string) => Promise<PublicProofBundleV1 | null>;
  /** Stored reviewed evidence, both of them. Seams so a test can hand in an
   * answer without a database — and so neither paid read can be pointed at
   * anything that measures. */
  loadRepresentations?: (input: {
    underlyingKey: string;
    direction: 'buy' | 'sell';
    requestedCashAtomic: string;
  }) => Promise<unknown | null>;
  loadIdentity?: (tokenAddress: string) => Promise<unknown | null>;
}

const requestContext = new AsyncLocalStorage<SellerRequestContextV1>();

function sellerEnabledV1(env: NodeJS.ProcessEnv): boolean {
  return env.MIORAIL_X402_SELLER_INTELLIGENCE_V1?.trim().toLowerCase() === 'true';
}

function receiptIdV1(record: X402SettlementRecord): string {
  return record.txHash
    ? `x402:seller:${record.network}:${record.txHash.toLowerCase()}`
    : `x402:seller:${randomUUID()}`;
}

/**
 * The `details` of a seller receipt.
 *
 * Settlement and delivery are two independently persisted facts, and "sold"
 * means both. Which of the two is written first is NOT stable — settlement
 * arrives on `onAfterSettle`, i.e. after the response — so this takes the
 * delivery as an argument and carries it whenever it is already known. Pure,
 * so the joint state is testable without a database.
 */
export function sellerReceiptDetailsV1(input: {
  base: Record<string, unknown>;
  service: X402IntelligenceServiceV1;
  requestHash: string;
  paymentStatus: string;
  delivery: { dataHash: string; deliveredAt: string } | null;
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

function missingEvidenceV1(card: B20OpportunityCardV1, history: B20OpportunityObservationV1[]): string[] {
  return answerB20CopilotV1({ card, history, question: 'What evidence is missing?' }).missingEvidence;
}

function currentStoredObservationV1(
  evidence: B20EvidenceV1,
): B20OpportunityObservationV1 | null {
  const id = evidence.card.observation?.observationId;
  return id ? evidence.history.find((entry) => entry.id === id) ?? null : null;
}

function observationRefV1(card: B20OpportunityCardV1, stored: B20OpportunityObservationV1 | null) {
  const observation = card.observation;
  if (!observation || !stored) return null;
  return {
    observationId: observation.observationId,
    // The Discover Card schema has already validated this as a canonical
    // 32-byte evidence hash; keep that branded shape in the seller contract.
    evidenceHash: observation.evidenceHash as `0x${string}`,
    observationBlockNumber: observation.observationBlockNumber,
    measuredAt: observation.measuredAt,
    staleAfter: observation.staleAfter,
    freshness: observation.freshness,
    measurementVersion: stored.measurementVersion,
  };
}

function b20AnalysisV1(
  service: 'b20_exit_analysis' | 'b20_liquidity_evidence',
  evidence: B20EvidenceV1,
  requestedPositionUsdc: string | null,
): Record<string, unknown> {
  const card = evidence.card;
  const display = card.observation;
  const stored = currentStoredObservationV1(evidence);
  if (service === 'b20_exit_analysis') {
    return {
      verdict: referenceExitAssessmentV1(stored, requestedPositionUsdc),
      state: display?.state ?? 'not_measured',
      reasonCode: display?.reasonCode ?? null,
      entryRouteFound: display?.entryRouteFound ?? null,
      exitRouteFound: display?.exitRouteFound ?? null,
      routeCoverage: display?.routeCoverage ?? null,
      optimisticRoundTripBps: display?.optimisticRoundTripBps ?? null,
      maxRoundTripBps: display?.maxRoundTripBps ?? null,
      controlsComplete: display?.controlsComplete ?? null,
      transfersPaused: display?.transfersPaused ?? null,
      routeHandoffRequired: true,
    };
  }
  return {
    state: display?.state ?? 'not_measured',
    reasonCode: display?.reasonCode ?? null,
    routeCoverage: display?.routeCoverage ?? null,
    entry: {
      found: display?.entryRouteFound ?? null,
      sourceKey: display?.entrySourceKey ?? null,
      routeHash: stored?.entryRouteHash ?? null,
    },
    exit: {
      found: display?.exitRouteFound ?? null,
      sourceKey: display?.exitSourceKey ?? null,
      routeHash: stored?.exitRouteHash ?? null,
    },
    capacity: stored
      ? {
          acquiredTokenAtomic: stored.entryOutputAtomic,
          largestPassingTokenAtomic: stored.largestPassingSizeAtomic,
          firstFailingTokenAtomic: stored.firstFailingSizeAtomic,
          toleranceBps: stored.capacityToleranceBps,
          probeCount: stored.capacityProbeCount,
          samplesHash: stored.capacitySamplesHash,
          stable: stored.capacityStable,
        }
      : null,
    quoteAlignment: display?.quoteAlignment ?? null,
    poolHook: display?.poolHook ?? null,
    launchBuying: {
      aggregate: display?.launchBuyers ?? null,
      window: display?.launchBuyerWindow ?? null,
    },
    controls: display
      ? {
          snapshotHash: stored?.controlsSnapshotHash ?? null,
          blockNumber: display.controlsBlockNumber,
          complete: display.controlsComplete,
          transfersPaused: display.transfersPaused,
          transferPolicyState: display.transferPolicyState,
        }
      : null,
  };
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
        id: 'b20_exit_analysis',
        method: 'GET',
        path: '/api/x402/intelligence/v1/b20/exit-analysis',
        description: 'Exact-reference B20 exit coverage from the latest immutable Miorail observation.',
        input: ['tokenAddress (required)', 'positionUsdc (optional; only exact measured size is comparable)'],
      },
      {
        id: 'b20_liquidity_evidence',
        method: 'GET',
        path: '/api/x402/intelligence/v1/b20/liquidity-evidence',
        description: 'Route sources, capacity ladder, controls, hook and launch-window provenance for one B20 token.',
        input: ['tokenAddress (required)'],
      },
      {
        id: 'enhanced_route_proof',
        method: 'GET',
        path: '/api/x402/intelligence/v1/route-proofs/enhanced',
        description: 'A published Route Proof bundle plus deterministic hash, event-chain and proof verification results.',
        input: ['publicId (required; owner-created live public proof share)'],
      },
      {
        id: 'stock_representation_choice',
        method: 'GET',
        path: '/api/x402/intelligence/v1/stocks/representations',
        description:
          'Every reviewed Base representation of one tokenized security, with issuer, supply, route policy and which of them the reviewed routers actually took at an exact size.',
        input: [
          'underlyingKey (required; e.g. security:isin:US67066G1040)',
          'direction (optional; buy or sell, default buy)',
          'sizeUsdc (optional; a measured ladder size, default 100)',
        ],
      },
      {
        id: 'address_identity_check',
        method: 'GET',
        path: '/api/x402/intelligence/v1/address/identity',
        description:
          'What a Base address IS against the reviewed corpus: official standing and issuer, any lookalike it resembles, who put it on chain, and what Miorail did not establish.',
        input: ['tokenAddress (required; an exact Base contract address)'],
      },
    ],
    constraints: [
      'Every paid resource costs exactly 0.001 USDC on Base.',
      'B20 intelligence reports stored evidence and missing evidence; it is not a recommendation or executable quote.',
      'A position is compared only with the exact stored reference size. Miorail never interpolates between capacity probes.',
      'Enhanced proofs require an already published, non-revoked Route Proof share.',
      'Representation and identity answers report the stored reviewed corpus. An address absent from it is absent from MIORAIL — never a statement that the contract is fake.',
      'A lookalike is a resemblance between strings, never a claim that two addresses are the same contract.',
      'No endpoint signs, broadcasts, approves, or prepares wallet calls.',
    ],
  });
}

export function createX402IntelligenceRouterV1(options: CreateX402IntelligenceRouterOptionsV1 = {}) {
  const router = Router();
  const env = options.env ?? process.env;
  const dbEnabled = options.dbEnabled !== false;
  const now = options.now ?? (() => new Date());
  const loadB20 = options.loadB20 ?? readB20EvidenceForTokenV1;
  const loadBundle = options.loadBundle ?? loadPublicBundleV1;
  const loadRepresentations = options.loadRepresentations ?? readMarketRealityForX402V1;
  const loadIdentity = options.loadIdentity ?? readAddressDossierForX402V1;

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
   */
  const DISCOVERY_V1: Record<X402IntelligenceServiceV1, DeclareDiscoveryExtensionInput> = {
    b20_exit_analysis: {
      input: { tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c', positionUsdc: '1000' },
      inputSchema: {
        properties: {
          tokenAddress: { type: 'string', description: 'Exact Base contract address' },
          positionUsdc: { type: 'string', description: 'Optional; compared only against the exact measured size' },
        },
        required: ['tokenAddress'],
      },
      output: {
        example: {
          service: 'b20_exit_analysis',
          analysis: { verdict: { status: 'measured' } },
          missingEvidence: ['exit capacity above the largest measured size is not established'],
        },
      },
    },
    b20_liquidity_evidence: {
      input: { tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c' },
      inputSchema: {
        properties: { tokenAddress: { type: 'string', description: 'Exact Base contract address' } },
        required: ['tokenAddress'],
      },
      output: {
        example: {
          service: 'b20_liquidity_evidence',
          analysis: { sources: [], capacity: {} },
          missingEvidence: [],
        },
      },
    },
    enhanced_route_proof: {
      input: { publicId: 'a1b2c3d4e5f6a7b8' },
      inputSchema: {
        properties: { publicId: { type: 'string', description: 'An owner-published, non-revoked Route Proof share' } },
        required: ['publicId'],
      },
      output: {
        example: {
          service: 'enhanced_route_proof',
          explanation: { finalStatus: 'settled', independentlyRecomputable: true },
        },
      },
    },
    stock_representation_choice: {
      input: { underlyingKey: 'security:isin:US67066G1040', direction: 'buy', sizeUsdc: '100' },
      inputSchema: {
        properties: {
          underlyingKey: { type: 'string', description: 'Reviewed security key, e.g. security:isin:US67066G1040' },
          direction: { type: 'string', description: 'buy or sell; default buy' },
          sizeUsdc: { type: 'string', description: 'A measured ladder size: 100, 1000, 10000 or 100000' },
        },
        required: ['underlyingKey'],
      },
      output: {
        example: {
          service: 'stock_representation_choice',
          representations: [
            {
              tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
              issuerId: 'coinbase',
              routePolicyEstablished: true,
              sources: [{ source: 'kyberswap', status: 'quoted' }],
            },
          ],
          missingEvidence: ['at least one reviewed representation has no measurement at this exact size and direction'],
        },
      },
    },
    address_identity_check: {
      input: { tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c' },
      inputSchema: {
        properties: { tokenAddress: { type: 'string', description: 'Exact Base contract address' } },
        required: ['tokenAddress'],
      },
      output: {
        example: {
          service: 'address_identity_check',
          standing: 'official',
          lookalike: null,
          origin: { status: 'relayed', relation: 'bundler', deployerAddress: null },
          unknown: ['holder_concentration_not_read'],
        },
      },
    },
  };

  function paidMiddleware(service: X402IntelligenceServiceV1, routePath: string): RequestHandler[] {
    const middlewareOptions: CreateX402MiddlewareOptions = {
      routePath,
      serviceName: `Miorail ${service}`,
      amountAtomicOverride: MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
      // Settling payments does not put a resource in the discovery list —
      // three settled in August and the list held zero Miorail entries. A
      // declaration does.
      discovery: DISCOVERY_V1[service],
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
    return [
      (req: Request, res: Response, next: NextFunction) => {
        const requestHash = String(res.locals.x402IntelligenceRequestHash ?? '');
        requestContext.run(
          { service, requestHash, receiptId: null, delivery: null },
          () => gateway(req, res, next),
        );
      },
    ];
  }

  const preloadB20 = (service: 'b20_exit_analysis' | 'b20_liquidity_evidence'): RequestHandler =>
    async (req, res, next) => {
      try {
        const tokenAddress = String(req.query.tokenAddress ?? '').toLowerCase();
        const positionUsdc = req.query.positionUsdc === undefined ? null : String(req.query.positionUsdc).trim();
        if (!ADDRESS_V1.test(tokenAddress) || (positionUsdc !== null && (!USDC_DECIMAL_V1.test(positionUsdc) || BigInt(decimalToAtomicUsdcV1(positionUsdc)) === 0n))) {
          res.status(400).json({ error: 'invalid_x402_intelligence_request', code: 'invalid_x402_intelligence_request' });
          return;
        }
        const evidence = await loadB20(tokenAddress);
        if (!evidence) {
          res.status(404).json({ error: 'b20_evidence_not_found', code: 'b20_evidence_not_found' });
          return;
        }
        res.locals.x402IntelligenceB20 = evidence;
        res.locals.x402IntelligencePositionUsdc = positionUsdc;
        res.locals.x402IntelligenceRequestHash = stableHashV1('x402-intelligence-request/v1', {
          service,
          tokenAddress,
          positionUsdc,
          observationId: evidence.card.observation?.observationId ?? null,
          evidenceHash: evidence.card.observation?.evidenceHash ?? null,
        });
        next();
      } catch {
        res.status(503).json({ error: 'b20_evidence_unavailable', code: 'b20_evidence_unavailable' });
      }
    };

  const sendB20 = (service: 'b20_exit_analysis' | 'b20_liquidity_evidence'): RequestHandler =>
    async (_req, res) => {
      const evidence = res.locals.x402IntelligenceB20 as B20EvidenceV1;
      const stored = currentStoredObservationV1(evidence);
      const draft: Omit<X402B20IntelligenceV1, 'dataHash'> = {
        schemaVersion: 'x402-b20-intelligence/v1',
        service,
        answerSource: 'stored_deterministic_evidence',
        chainId: 8453,
        token: {
          address: evidence.card.launch.tokenAddress,
          name: evidence.card.launch.name,
          symbol: evidence.card.launch.symbol,
          decimals: evidence.card.launch.decimals,
          variant: evidence.card.launch.variant,
        },
        observation: observationRefV1(evidence.card, stored),
        analysis: b20AnalysisV1(service, evidence, res.locals.x402IntelligencePositionUsdc ?? null),
        missingEvidence: missingEvidenceV1(evidence.card, evidence.history),
        caveats: [
          MIORAIL_MCP_CAVEATS_V1.provisional,
          MIORAIL_MCP_CAVEATS_V1.routeCoverage,
          MIORAIL_MCP_CAVEATS_V1.capacity,
          MIORAIL_MCP_CAVEATS_V1.poolHook,
          MIORAIL_MCP_CAVEATS_V1.launchBuying,
          'This paid response prepares no call. Routes must obtain fresh quotes and Safety Kernel approval before any wallet action.',
        ],
        generatedAt: now().toISOString(),
        payment: x402IntelligencePaymentV1(),
        requestHash: res.locals.x402IntelligenceRequestHash,
      };
      const payload = X402B20IntelligenceV1Schema.parse({
        ...draft,
        dataHash: hashX402IntelligenceDataV1(draft),
      });
      await markSellerDeliveryV1(payload.dataHash, dbEnabled).catch(() => undefined);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Miorail-Data-Hash', payload.dataHash);
      res.json(payload);
    };

  // ------------------------------------------------------------------
  // Two questions an agent cannot answer for itself.
  //
  // Both read stored reviewed evidence and measure nothing: a paid read must
  // never be a way to make Miorail spend router calls on somebody else's
  // behalf. Both carry what was NOT established beside what was, because for
  // an agent that is the difference between an answer and a hallucination.
  // ------------------------------------------------------------------

  /** A reviewed ladder size, so the answer names a size somebody measured
   * rather than one this request invented. */
  const LADDER_USDC_V1 = new Set(['100', '1000', '10000', '100000']);

  const preloadRepresentations: RequestHandler = async (req, res, next) => {
    try {
      const underlyingKey = String(req.query.underlyingKey ?? '').trim();
      const direction = String(req.query.direction ?? 'buy').trim() === 'sell' ? 'sell' : 'buy';
      const sizeUsdc = String(req.query.sizeUsdc ?? '100').trim();
      if (!/^[a-z0-9_]+:[a-z0-9_]+:.+$/.test(underlyingKey) || underlyingKey.length > 200) {
        res.status(400).json({ error: 'invalid_underlying_key', code: 'invalid_underlying_key' });
        return;
      }
      if (!LADDER_USDC_V1.has(sizeUsdc)) {
        // Only sizes the public ladder measures on a schedule. Any other size
        // would answer from evidence nobody has taken, and this surface must
        // not measure one to satisfy a paid read.
        res.status(400).json({
          error: 'unmeasured_size_requested',
          code: 'unmeasured_size_requested',
          detail: 'Sizes are the measured ladder: 100, 1000, 10000 or 100000 USDC.',
        });
        return;
      }
      const requestedCashAtomic = (BigInt(sizeUsdc) * 1_000_000n).toString();
      const answer = await loadRepresentations({ underlyingKey, direction, requestedCashAtomic });
      if (!answer) {
        res.status(404).json({ error: 'underlying_not_reviewed', code: 'underlying_not_reviewed' });
        return;
      }
      res.locals.x402IntelligenceBoard = answer;
      res.locals.x402IntelligenceQuestion = { direction, requestedCashAtomic };
      res.locals.x402IntelligenceRequestHash = stableHashV1('x402-intelligence-request/v1', {
        service: 'stock_representation_choice',
        underlyingKey,
        direction,
        requestedCashAtomic,
      });
      next();
    } catch {
      res.status(503).json({ error: 'market_reality_unavailable', code: 'market_reality_unavailable' });
    }
  };

  const sendRepresentations: RequestHandler = async (_req, res) => {
    const board = res.locals.x402IntelligenceBoard as {
      question: { underlyingKey: string };
      underlying?: { isin?: string | null; assetClass?: string | null };
      representations: readonly Record<string, never>[];
    };
    const question = res.locals.x402IntelligenceQuestion as {
      direction: 'buy' | 'sell';
      requestedCashAtomic: string;
    };
    const rows = (board.representations ?? []) as readonly Record<string, unknown>[];
    const draft: Omit<X402StockRepresentationChoiceV1, 'dataHash'> = {
      schemaVersion: 'x402-stock-representation-choice/v1',
      service: 'stock_representation_choice',
      answerSource: 'stored_deterministic_evidence',
      chainId: 8453,
      underlying: {
        underlyingKey: board.question.underlyingKey,
        isin: (board.underlying?.isin as string | undefined) ?? null,
        assetClass: (board.underlying?.assetClass as string | undefined) ?? null,
      },
      question: { ...question, destination: 'USDC' },
      representations: rows.slice(0, 24).map((row) => {
        const supply = (row.supply ?? {}) as { state?: string; decimals?: number | null };
        const sources = (row.sources ?? []) as readonly { source?: string; status?: string }[];
        return {
          tokenAddress: String(row.tokenAddress ?? ''),
          issuerId: String(row.issuerId ?? 'unknown'),
          issuerInstrumentKey: String(row.issuerInstrumentKey ?? 'unknown'),
          representationKind: String(row.representationKind ?? 'unknown'),
          supplyState: String(supply.state ?? 'not_established'),
          supplyDecimals: supply.decimals ?? null,
          routePolicyEstablished: row.routePolicyKey !== null && row.routePolicyKey !== undefined,
          sources: sources
            .slice(0, 16)
            .map((source) => ({ source: String(source.source ?? ''), status: String(source.status ?? '') })),
          exactTestedTokenAtomic: (row.exactTestedTokenAtomic as string | null) ?? null,
          returnedCashAtomic: (row.returnedCashAtomic as string | null) ?? null,
          effectivePriceAtomic: (row.effectivePriceAtomic as string | null) ?? null,
          premiumDiscountBps: (row.premiumDiscountBps as string | null) ?? null,
          observedAt: (row.observedAt as string | null) ?? null,
          expiresAt: (row.expiresAt as string | null) ?? null,
          liveness: String(row.liveness ?? 'never_measured'),
        };
      }),
      caveats: [
        'A ticker cannot select between these. Three issuers publish contracts for the same security on Base, with different structures and different markets — the address is the identity.',
        'An empty `sources` list means nobody has measured THIS exact size and direction. It is never a statement that no route exists.',
        'A zero-supply representation is a real contract with nothing outstanding; a supply that is not established is a Miorail read that failed. They are different facts.',
        'Figures are the stored measurement with its own two clocks. This response prepares no call and obtains no fresh quote.',
      ],
      missingEvidence: rows.some((row) => ((row.sources ?? []) as unknown[]).length === 0)
        ? ['at least one reviewed representation has no measurement at this exact size and direction']
        : [],
      generatedAt: now().toISOString(),
      payment: x402IntelligencePaymentV1(),
      requestHash: res.locals.x402IntelligenceRequestHash,
    };
    const payload = X402StockRepresentationChoiceV1Schema.parse({
      ...draft,
      dataHash: hashX402IntelligenceDataV1(draft),
    });
    await markSellerDeliveryV1(payload.dataHash, dbEnabled).catch(() => undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Miorail-Data-Hash', payload.dataHash);
    res.json(payload);
  };

  const preloadIdentity: RequestHandler = async (req, res, next) => {
    try {
      const tokenAddress = String(req.query.tokenAddress ?? '').toLowerCase();
      if (!ADDRESS_V1.test(tokenAddress)) {
        res.status(400).json({ error: 'invalid_token_address', code: 'invalid_token_address' });
        return;
      }
      const dossier = await loadIdentity(tokenAddress);
      if (!dossier) {
        res.status(503).json({ error: 'address_dossier_unavailable', code: 'address_dossier_unavailable' });
        return;
      }
      res.locals.x402IntelligenceDossier = dossier;
      res.locals.x402IntelligenceRequestHash = stableHashV1('x402-intelligence-request/v1', {
        service: 'address_identity_check',
        tokenAddress,
        dossierHash: (dossier as { dossierHash?: string }).dossierHash ?? null,
      });
      next();
    } catch {
      res.status(503).json({ error: 'address_dossier_unavailable', code: 'address_dossier_unavailable' });
    }
  };

  const sendIdentity: RequestHandler = async (_req, res) => {
    const dossier = res.locals.x402IntelligenceDossier as {
      tokenAddress: string;
      identity: {
        standing: string;
        official: {
          ticker: string;
          displayName: string | null;
          issuer: string;
          listedIn: readonly string[];
          sourceDiscrepancy: boolean;
        } | null;
        lookalike: {
          officialAddress: string;
          officialTicker: string;
          matchKind: string;
          matchedAlias: string;
          matchedValue: string;
          firstFlaggedAt: string;
        } | null;
        origin: {
          status: string;
          deployerAddress: string | null;
          relation: string | null;
          readAt: string | null;
        };
      };
      established: readonly { code?: string }[];
      unknown: readonly { code?: string }[];
    };
    const identity = dossier.identity;
    const draft: Omit<X402AddressIdentityCheckV1, 'dataHash'> = {
      schemaVersion: 'x402-address-identity-check/v1',
      service: 'address_identity_check',
      answerSource: 'stored_deterministic_evidence',
      chainId: 8453,
      tokenAddress: dossier.tokenAddress,
      standing: identity.standing,
      official: identity.official
        ? {
            ticker: identity.official.ticker,
            displayName: identity.official.displayName,
            issuer: identity.official.issuer,
            listedIn: [...identity.official.listedIn].slice(0, 8),
            sourceDiscrepancy: identity.official.sourceDiscrepancy,
          }
        : null,
      lookalike: identity.lookalike ? { ...identity.lookalike } : null,
      origin: { ...identity.origin },
      established: dossier.established.slice(0, 24).map((fact) => String(fact.code ?? '')).filter(Boolean),
      unknown: dossier.unknown.slice(0, 24).map((fact) => String(fact.code ?? '')).filter(Boolean),
      caveats: [
        'A lookalike is a RESEMBLANCE between strings. Two symbols matching is not two addresses matching — compare the addresses.',
        '`unknown_to_miorail` is a statement about this corpus, never a statement that the contract is fraudulent.',
        'A deployer address is shown only when the launch transaction went straight to the factory. A bundler that relayed a UserOperation is not a deployer, so any other relation carries the relation and no address.',
        'This response prepares no call, obtains no quote and makes no recommendation.',
      ],
      generatedAt: now().toISOString(),
      payment: x402IntelligencePaymentV1(),
      requestHash: res.locals.x402IntelligenceRequestHash,
    };
    const payload = X402AddressIdentityCheckV1Schema.parse({
      ...draft,
      dataHash: hashX402IntelligenceDataV1(draft),
    });
    await markSellerDeliveryV1(payload.dataHash, dbEnabled).catch(() => undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Miorail-Data-Hash', payload.dataHash);
    res.json(payload);
  };

  router.get('/catalog', (_req, res) => res.json(sellerCatalogV1(env)));

  router.get(
    '/b20/exit-analysis',
    featureGate,
    preloadB20('b20_exit_analysis'),
    ...paidMiddleware('b20_exit_analysis', '/b20/exit-analysis'),
    sendB20('b20_exit_analysis'),
  );
  router.get(
    '/b20/liquidity-evidence',
    featureGate,
    preloadB20('b20_liquidity_evidence'),
    ...paidMiddleware('b20_liquidity_evidence', '/b20/liquidity-evidence'),
    sendB20('b20_liquidity_evidence'),
  );

  router.get(
    '/stocks/representations',
    featureGate,
    preloadRepresentations,
    ...paidMiddleware('stock_representation_choice', '/stocks/representations'),
    sendRepresentations,
  );
  router.get(
    '/address/identity',
    featureGate,
    preloadIdentity,
    ...paidMiddleware('address_identity_check', '/address/identity'),
    sendIdentity,
  );

  router.get(
    '/route-proofs/enhanced',
    featureGate,
    async (req, res, next) => {
      try {
        const publicId = String(req.query.publicId ?? '').toLowerCase();
        if (!PUBLIC_ID_V1.test(publicId)) {
          res.status(400).json({ error: 'invalid_public_proof_id', code: 'invalid_public_proof_id' });
          return;
        }
        const bundle = await loadBundle(publicId);
        if (!bundle || bundle.proofFamily !== 'route') {
          res.status(404).json({ error: 'public_route_proof_not_found', code: 'public_route_proof_not_found' });
          return;
        }
        const verification = verifyPublicProofBundleV1(bundle);
        if (!verification.valid) {
          res.status(409).json({ error: 'public_route_proof_invalid', code: 'public_route_proof_invalid' });
          return;
        }
        res.locals.x402IntelligenceBundle = bundle;
        res.locals.x402IntelligenceVerification = verification;
        res.locals.x402IntelligenceRequestHash = stableHashV1('x402-intelligence-request/v1', {
          service: 'enhanced_route_proof',
          publicId,
          bundleHash: bundle.bundleHash,
        });
        next();
      } catch {
        res.status(503).json({ error: 'public_route_proof_unavailable', code: 'public_route_proof_unavailable' });
      }
    },
    ...paidMiddleware('enhanced_route_proof', '/route-proofs/enhanced'),
    async (_req, res: Response) => {
      const bundle = res.locals.x402IntelligenceBundle as Extract<PublicProofBundleV1, { proofFamily: 'route' }>;
      const verification = res.locals.x402IntelligenceVerification as ReturnType<typeof verifyPublicProofBundleV1>;
      const draft: Omit<X402EnhancedRouteProofV1, 'dataHash'> = {
        schemaVersion: 'x402-enhanced-route-proof/v1',
        service: 'enhanced_route_proof',
        chainId: 8453,
        bundle,
        verification,
        explanation: {
          finalStatus: bundle.proof.finalStatus,
          reconciliationState: bundle.proof.reconciliationState,
          transactionCount: bundle.proof.transactionHashes.length,
          eventCount: bundle.events.length,
          independentlyRecomputable: true,
        },
        caveats: [
          'Verification proves internal hash and event-chain consistency; it is not a Miorail signature or an onchain hash anchor.',
          'Transaction hashes are onchain evidence. Receipt success alone is not proof of the expected economic result.',
          'The owner can revoke the public share; this paid response is bound to the bundleHash returned here.',
        ],
        generatedAt: now().toISOString(),
        payment: x402IntelligencePaymentV1(),
        requestHash: res.locals.x402IntelligenceRequestHash,
      };
      const payload = X402EnhancedRouteProofV1Schema.parse({
        ...draft,
        dataHash: hashX402IntelligenceDataV1(draft),
      });
      await markSellerDeliveryV1(payload.dataHash, dbEnabled).catch(() => undefined);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Miorail-Data-Hash', payload.dataHash);
      res.json(payload);
    },
  );

  return router;
}

export const x402IntelligenceRouterV1 = createX402IntelligenceRouterV1();
