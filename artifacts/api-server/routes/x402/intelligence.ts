import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { eq } from 'drizzle-orm';

import { db, x402Receipts } from '@mioagent/db';
import {
  MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
  X402B20IntelligenceV1Schema,
  X402EnhancedRouteProofV1Schema,
  X402SellerCatalogV1Schema,
  hashX402IntelligenceDataV1,
  stableHashV1,
  x402IntelligencePaymentV1,
  type PublicProofBundleV1,
  type X402B20IntelligenceV1,
  type X402EnhancedRouteProofV1,
  type X402IntelligenceServiceV1,
} from '@mioagent/route-domain';
import { verifyPublicProofBundleV1 } from '@mioagent/proof-verifier';
import {
  createX402MiddlewareFromEnv,
  x402ConfigFromEnv,
  type CreateX402MiddlewareOptions,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import type { B20OpportunityCardV1 } from '@mioagent/opportunity-rail';
import type { B20OpportunityObservationV1 } from '@mioagent/route-storage';

import { answerB20CopilotV1 } from '../../lib/b20Copilot.js';
import { readB20EvidenceForTokenV1 } from '../b20Control.js';
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

function decimalToAtomicUsdcV1(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
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

function referenceExitAssessmentV1(
  stored: B20OpportunityObservationV1 | null,
  requestedPositionUsdc: string | null,
): Record<string, unknown> {
  if (!stored) return { status: 'not_measured' };
  if (!stored.exitRouteFound) return { status: 'no_supported_exit_route' };
  if (stored.entryOutputAtomic === null || stored.largestPassingSizeAtomic === null) {
    return { status: 'capacity_not_measured' };
  }
  const acquired = BigInt(stored.entryOutputAtomic);
  const capacity = BigInt(stored.largestPassingSizeAtomic);
  const coverageBps = acquired === 0n
    ? null
    : Number(((capacity * 10_000n) / acquired) > 10_000n ? 10_000n : ((capacity * 10_000n) / acquired));
  const requestedAtomic = requestedPositionUsdc ? decimalToAtomicUsdcV1(requestedPositionUsdc) : null;
  const requestComparison = requestedAtomic === null
    ? 'reference_profile_only'
    : stored.referenceQuoteAsset !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      ? 'requested_usdc_not_comparable_to_reference_asset'
      : requestedAtomic !== stored.referencePositionAtomic
        ? 'requested_size_not_measured'
        : coverageBps !== null && coverageBps >= 10_000
          ? 'covered_at_exact_reference_size'
          : 'not_fully_covered_at_exact_reference_size';
  return {
    status: 'measured_reference_bound',
    requestComparison,
    requestedPositionUsdc,
    referenceQuoteAsset: stored.referenceQuoteAsset,
    referencePositionAtomic: stored.referencePositionAtomic,
    acquiredTokenAtomic: stored.entryOutputAtomic,
    largestPassingTokenAtomic: stored.largestPassingSizeAtomic,
    firstFailingTokenAtomic: stored.firstFailingSizeAtomic,
    coverageBps,
    capacityToleranceBps: stored.capacityToleranceBps,
    capacityProbeCount: stored.capacityProbeCount,
    capacityStable: stored.capacityStable,
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
  return X402SellerCatalogV1Schema.parse({
    schemaVersion: 'x402-intelligence-catalog/v1',
    provider: 'Miorail',
    chainId: 8453,
    enabled: sellerEnabledV1(env) && config.configured && config.settleReady === true && config.network === 'eip155:8453',
    payment: {
      network: 'eip155:8453',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      decimals: 6,
      amountAtomic: '1000',
      amountUsdc: '0.001',
    },
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
    ],
    constraints: [
      'Every paid resource costs exactly 0.001 USDC on Base.',
      'B20 intelligence reports stored evidence and missing evidence; it is not a recommendation or executable quote.',
      'A position is compared only with the exact stored reference size. Miorail never interpolates between capacity probes.',
      'Enhanced proofs require an already published, non-revoked Route Proof share.',
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

  const featureGate: RequestHandler = (_req, res, next) => {
    if (!sellerEnabledV1(env)) {
      res.status(404).json({ error: 'x402_intelligence_not_released', code: 'x402_intelligence_not_released' });
      return;
    }
    next();
  };

  function paidMiddleware(service: X402IntelligenceServiceV1, routePath: string): RequestHandler[] {
    const middlewareOptions: CreateX402MiddlewareOptions = {
      routePath,
      serviceName: `Miorail ${service}`,
      amountAtomicOverride: MIORAIL_X402_INTELLIGENCE_PRICE_ATOMIC_V1,
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
