import { Router, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createX402MiddlewareFromEnv,
  x402MiddlewareDiagnosticsFromEnv,
  x402ConfigFromEnv,
  x402StatusFromEnv,
  classifyX402SettleFailureReason,
  type X402MiddlewareRuntimeMode,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import { db, auditLogs, x402Receipts } from '@mioagent/db';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  X402LedgerResponseSchema,
  X402PricingResponseSchema,
} from '@mioagent/api-zod';

const smokeRunIdStorage = new AsyncLocalStorage<string | undefined>();

function extractRunId(req: Request): string | undefined {
  const q = req.query.runId || req.query.attemptId;
  if (typeof q === 'string' && q) return q;
  const h = req.headers['x-miorail-smoke-run-id'] || req.headers['x-idempotency-key'];
  if (typeof h === 'string' && h) return h;
  return undefined;
}

interface CreateX402RouterOptions {
  env?: NodeJS.ProcessEnv;
  runtimeMode?: X402MiddlewareRuntimeMode;
}

function receiptId(record: X402SettlementRecord): string {
  if (record.txHash) return `x402:${record.network}:${record.txHash}`;
  return `x402:${randomUUID()}`;
}

let lastSmokeSettlement: {
  status: string;
  payer?: string;
  txHash?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  settledAt?: string;
  errorReason?: string;
  errorMessage?: string;
} | null = null;

let lastBrowserRun: {
  runId: string;
  status: string;
  txHash?: string;
  payer?: string;
  settledAt?: string;
  errorReason?: string;
} | null = null;

async function persistSettlement(record: X402SettlementRecord): Promise<void> {
  const id = receiptId(record);
  const runId = smokeRunIdStorage.getStore() || (record as any).runId || undefined;
  lastSmokeSettlement = {
    status: record.status || 'settled',
    payer: record.payer || undefined,
    txHash: record.txHash || undefined,
    network: record.network,
    amount: record.amount,
    asset: record.asset,
    payTo: record.payTo,
    settledAt: new Date().toISOString(),
  };
  if (runId) {
    lastBrowserRun = {
      runId,
      status: record.status || 'settled',
      txHash: record.txHash || undefined,
      payer: record.payer || undefined,
      settledAt: new Date().toISOString(),
    };
  }
  if (record.txHash) {
    console.info('[x402] x402-browser-payment-settled', {
      status: 'settled',
      payer: record.payer || 'unknown',
      txHash: record.txHash,
      runId,
    });
  } else {
    console.info('[x402] x402-browser-payment-settled-degraded', {
      status: 'settled',
      payer: record.payer || 'unknown',
      proofStatus: 'state_only_tx_unavailable',
      runId,
    });
  }
  const detailsRecord = record.details && typeof record.details === 'object' ? record.details : {};
  const receipt = {
    ...record,
    id,
    runId,
    details: {
      ...detailsRecord,
      ...(runId ? { runId } : {}),
    },
    userId: record.userId || 'default-user',
  };
  try {
    await db.insert(x402Receipts).values({
      id,
      receipt,
      updatedAt: new Date(),
    });
  } catch (error) {
    // Duplicate tx hashes should not turn a successful paid response into a
    // user-visible failure. The facilitator remains source of truth.
    console.warn('[x402] failed to persist settlement record', {
      code: error instanceof Error ? error.name : 'unknown_error',
    });
  }
}

function recordSettlementFailure(failure: { errorReason?: string; errorMessage?: string; checkedAt: string }): void {
  const reason = classifyX402SettleFailureReason(failure.errorReason, failure.errorMessage);
  const runId = smokeRunIdStorage.getStore();
  lastSmokeSettlement = {
    status: 'failed',
    settledAt: failure.checkedAt,
    errorReason: reason,
    errorMessage: failure.errorMessage,
  };
  if (runId) {
    lastBrowserRun = {
      runId,
      status: 'failed',
      settledAt: failure.checkedAt,
      errorReason: reason,
    };
  }
  console.info('[x402] x402-browser-payment-settlement-failed', {
    status: 'failed',
    reason,
    runId,
  });
}

function receiptRecord(row: { id: string; receipt: unknown; createdAt: Date }): X402SettlementRecord & {
  id: string;
  createdAt: Date;
  userId?: string;
  runId?: string;
} {
  const receipt = row.receipt && typeof row.receipt === 'object' ? row.receipt as Record<string, unknown> : {};
  const details = receipt.details && typeof receipt.details === 'object' ? receipt.details as Record<string, unknown> : {};
  const runId =
    typeof receipt.runId === 'string'
      ? receipt.runId
      : typeof details.runId === 'string'
        ? details.runId
        : undefined;
  return {
    id: String(receipt.id || row.id),
    userId: typeof receipt.userId === 'string' ? receipt.userId : undefined,
    runId,
    actionId: typeof receipt.actionId === 'string' ? receipt.actionId : undefined,
    actionType: typeof receipt.actionType === 'string' ? receipt.actionType : undefined,
    cost: typeof receipt.cost === 'string' ? receipt.cost : null,
    txHash: typeof receipt.txHash === 'string' ? receipt.txHash : null,
    network: typeof receipt.network === 'string' ? receipt.network : '',
    asset: typeof receipt.asset === 'string' ? receipt.asset : '',
    amount: typeof receipt.amount === 'string' ? receipt.amount : '0',
    payTo: typeof receipt.payTo === 'string' ? receipt.payTo : '',
    payer: typeof receipt.payer === 'string' ? receipt.payer : undefined,
    status: receipt.status === 'pending' || receipt.status === 'failed' ? receipt.status : 'settled',
    attribution: receipt.attribution && typeof receipt.attribution === 'object' ? receipt.attribution as any : {},
    checkedAt: typeof receipt.checkedAt === 'string' ? receipt.checkedAt : row.createdAt.toISOString(),
    source: receipt.source === 'mock' ? 'mock' : 'x402-facilitator',
    errorReason: typeof receipt.errorReason === 'string' ? receipt.errorReason : undefined,
    errorMessage: typeof receipt.errorMessage === 'string' ? receipt.errorMessage : undefined,
    createdAt: row.createdAt,
  };
}

function atomicUsdcToDecimal(amount: string): string {
  try {
    const value = BigInt(amount || '0');
    const units = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${units}.${fraction}` : units.toString();
  } catch {
    return '0';
  }
}

function decodePaymentHeaderProof(headerVal: unknown): { payer?: string; txHash?: string; network?: string } {
  if (typeof headerVal !== 'string' || !headerVal) return {};
  try {
    let parsed: any;
    try {
      parsed = JSON.parse(atob(headerVal));
    } catch {
      parsed = JSON.parse(headerVal);
    }
    if (parsed && typeof parsed === 'object') {
      const txHash = typeof parsed.txHash === 'string' ? parsed.txHash : typeof parsed.transaction === 'string' ? parsed.transaction : undefined;
      const payer = typeof parsed.payer === 'string' ? parsed.payer : undefined;
      const network = typeof parsed.network === 'string' ? parsed.network : undefined;
      return { payer, txHash, network };
    }
  } catch {
    // ignore malformed header
  }
  return {};
}

export function createX402Router(options: CreateX402RouterOptions = {}) {
  const router = Router();
  const env = options.env || process.env;
  const runtimeMode = options.runtimeMode || 'auto';
  const commonMiddlewareOptions = {
    serviceName: 'Miorail',
    onSettlement: persistSettlement,
    onSettlementFailure: recordSettlementFailure,
    runtimeMode,
  };
  const legacyGateway = createX402MiddlewareFromEnv({
    ...commonMiddlewareOptions,
    routePath: '/mock-paid-endpoint',
  }, env);
  const smokeGateway = createX402MiddlewareFromEnv({
    ...commonMiddlewareOptions,
    routePath: '/smoke-paid',
  }, env);

  router.get('/mock-paid-endpoint', legacyGateway, (_req: Request, res: Response) => {
    res.status(200).json({ data: 'This is premium mock data protected by x402 payment.' });
  });

  router.get(
    '/smoke-paid',
    (req: Request, _res: Response, next) => {
      const runId = extractRunId(req);
      smokeRunIdStorage.run(runId, () => next());
    },
    smokeGateway,
    (req: Request, res: Response) => {
      res.setHeader('Access-Control-Expose-Headers', 'payment-response, x-payment-response, PAYMENT-REQUIRED');
      const headerProof = decodePaymentHeaderProof(
        res.getHeader('payment-response') ||
        res.getHeader('x-payment-response') ||
        req.headers['payment-response'] ||
        req.headers['x-payment-response']
      );
      const config = x402ConfigFromEnv(env);
      const payer = headerProof.payer || lastSmokeSettlement?.payer || null;
      const txHash = headerProof.txHash || lastSmokeSettlement?.txHash || null;
      const network = headerProof.network || lastSmokeSettlement?.network || config.network || 'eip155:8453';
      const reqRunId = extractRunId(req) || smokeRunIdStorage.getStore();

      if (reqRunId) {
        lastBrowserRun = {
          runId: reqRunId,
          status: 'settled',
          txHash: txHash || undefined,
          payer: payer || undefined,
          settledAt: new Date().toISOString(),
        };
      }

      console.info('[x402] x402-browser-payment-started', {
        route: '/api/x402/smoke-paid',
        runId: reqRunId,
      });

      res.status(200).json({
        ok: true,
        data: 'x402 smoke payment accepted.',
        route: '/api/x402/smoke-paid',
        smokeRoute: '/api/x402/smoke-paid',
        runId: reqRunId,
        settlement: 'settled',
        payer,
        txHash,
        network,
        amount: config.amountAtomic || '1000',
        asset: config.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: config.payTo || '',
      });
    }
  );

  router.get('/diagnostics', async (_req: Request, res: Response) => {
    const statusConfig = await x402StatusFromEnv(env);
    const diagnostics = x402MiddlewareDiagnosticsFromEnv(env, {
      runtimeMode,
      smokeRoute: '/api/x402/smoke-paid',
      config: statusConfig,
    });
    const browserPaidAvailable = Boolean(
      diagnostics.configured &&
      diagnostics.officialMiddlewareEnabled &&
      diagnostics.smokeRouteAvailable &&
      diagnostics.settleReady &&
      !diagnostics.mockFacilitatorEnabled,
    );

    let latestGlobalRecord: { txHash?: string | null; createdAt?: Date } | null = null;
    let browserRunMatched = false;
    try {
      const rows = await db.select()
        .from(x402Receipts)
        .orderBy(desc(x402Receipts.createdAt))
        .limit(50);
      const parsed = rows.map(receiptRecord);
      latestGlobalRecord = parsed[0] || null;
      if (lastBrowserRun?.runId) {
        browserRunMatched = parsed.some((r) => r.runId === lastBrowserRun?.runId);
      }
    } catch {
      latestGlobalRecord = null;
    }

    res.json({
      status: diagnostics.status,
      middlewareMode: diagnostics.middlewareMode,
      officialMiddlewareEnabled: diagnostics.officialMiddlewareEnabled,
      mockFacilitatorEnabled: diagnostics.mockFacilitatorEnabled,
      facilitatorHost: diagnostics.facilitatorHost,
      browserPaidFlowAvailable: browserPaidAvailable,
      browserPaidActionAvailable: browserPaidAvailable,
      paymentResponseHeaderReadable: true,
      settleReady: diagnostics.settleReady,
      settleBlockedReason: diagnostics.settleBlockedReason || null,
      probeStatus: diagnostics.probeStatus || null,
      supportedNetworks: diagnostics.supportedNetworks || [],
      latestSettleFailureReason: lastSmokeSettlement?.errorReason || lastBrowserRun?.errorReason || null,
      lastSmokeSettlementStatus: lastSmokeSettlement?.status || null,
      lastSmokeSettlementReason: lastSmokeSettlement?.errorReason || null,
      lastSmokeTxHashPresent: Boolean(lastSmokeSettlement?.txHash),
      lastSmokePayerPresent: Boolean(lastSmokeSettlement?.payer),
      lastBrowserRunId: lastBrowserRun?.runId || null,
      lastBrowserRunStatus: lastBrowserRun?.status || null,
      lastBrowserRunReason: lastBrowserRun?.errorReason || null,
      lastBrowserRunLedgerMatched: browserRunMatched,
      lastBrowserRunTxHashPresent: Boolean(lastBrowserRun?.txHash),
      lastBrowserRunPayerPresent: Boolean(lastBrowserRun?.payer),
      lastGlobalLedgerTxHashPresent: Boolean(latestGlobalRecord?.txHash),
      lastGlobalLedgerCreatedAt: latestGlobalRecord?.createdAt ? latestGlobalRecord.createdAt.toISOString() : null,
      configured: diagnostics.configured,
      network: diagnostics.network,
      chainId: diagnostics.chainId,
      asset: diagnostics.asset,
      payToConfigured: diagnostics.payToConfigured,
      builderCodeConfigured: diagnostics.builderCodeConfigured,
      builderCodeAttribution: diagnostics.builderCodeAttribution,
      facilitatorAuthConfigured: diagnostics.facilitatorAuthConfigured,
      authSource: diagnostics.authSource,
      smokeRoute: diagnostics.smokeRoute,
      smokeRouteAvailable: diagnostics.smokeRouteAvailable,
      eip712DomainAttached: diagnostics.eip712DomainAttached,
      eip712DomainName: diagnostics.eip712DomainName,
      eip712DomainVersion: diagnostics.eip712DomainVersion,
      errorCode: diagnostics.errorCode,
      missingConfig: diagnostics.missingConfig,
      warnings: diagnostics.warnings,
    });
  });

  router.get('/ledger', async (req: Request, res: Response, next) => {
    try {
      const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
      let rows: any[] = [];
      let auditContext: any[] = [];
      try {
        rows = await db.select()
          .from(x402Receipts)
          .orderBy(desc(x402Receipts.createdAt))
          .limit(100);
        auditContext = await db.select()
          .from(auditLogs)
          .where(eq(auditLogs.userId, userId))
          .orderBy(desc(auditLogs.createdAt))
          .limit(100);
      } catch {
        rows = [];
        auditContext = [];
      }
      const filterRunId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
      const records = rows
        .map(receiptRecord)
        .filter((record) => !record.userId || record.userId === userId)
        .filter((record) => !filterRunId || record.runId === filterRunId);
      const auditByActionId = new Map(auditContext.map((log) => [log.actionId, log]));

      let totalSpent = 0;
      let inferenceSpent = 0;
      let toolsSpent = 0;
      let inferenceCount = 0;
      let toolsCount = 0;

      const entries = records.map(record => {
        const audit = record.actionId ? auditByActionId.get(record.actionId) : undefined;
        const actionType = record.actionType || audit?.actionType || 'x402_resource';
        const cost = record.cost || atomicUsdcToDecimal(record.amount);
        const costVal = parseFloat(cost || '0');
        const isInference = actionType === 'inference_call' || actionType === 'portfolio_scan' || actionType === 'security_screening';
        if (!isNaN(costVal)) {
          totalSpent += costVal;
          if (isInference) {
            inferenceSpent += costVal;
            inferenceCount++;
          } else {
            toolsSpent += costVal;
            toolsCount++;
          }
        }
        return {
          id: record.id,
          runId: record.runId,
          actionId: record.actionId || audit?.actionId || record.id,
          actionType,
          cost,
          txHash: record.txHash,
          network: record.network,
          asset: record.asset,
          amount: record.amount,
          payTo: record.payTo,
          status: record.status,
          attribution: record.attribution,
          createdAt: record.createdAt.toISOString(),
          settlement: record.status,
          proofStatus: record.txHash ? 'verified_tx' : 'state_only_tx_unavailable',
          details: {
            source: record.source,
            payer: record.payer,
            runId: record.runId,
            checkedAt: record.checkedAt,
            proofStatus: record.txHash ? 'verified_tx' : 'state_only_tx_unavailable',
            errorReason: record.errorReason,
            audit: audit?.details || null,
          },
        };
      });

      const response = {
        entries,
        summary: {
          totalSpentUsdc: totalSpent.toFixed(4),
          inferenceSpentUsdc: inferenceSpent.toFixed(4),
          toolsSpentUsdc: toolsSpent.toFixed(4),
          inferenceCallsCount: inferenceCount,
          toolsCallsCount: toolsCount,
          settlement: entries.length > 0 ? 'real' : 'none',
          x402: x402ConfigFromEnv(env).status,
        },
      };

      res.json(X402LedgerResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  router.get('/pricing', async (_req: Request, res: Response) => {
    const pricing = [
      { actionType: 'portfolio_scan', label: 'Portfolio Risk Scan', priceUsdc: '0.0010', description: 'Moralis token balance indexing and price feed valuation' },
      { actionType: 'security_screening', label: 'Token Security Screening', priceUsdc: '0.0020', description: 'GoPlus contract security checks and honeypot analysis' },
      { actionType: 'swap_execution', label: 'Swap Simulation & Routing', priceUsdc: '0.0050', description: 'EIP-5792 batch execution preparation and route optimization' },
      { actionType: 'inference_call', label: 'Autonomous AI Inference', priceUsdc: '0.0010', description: 'Agent LLM reasoning and intent classification' },
    ];
    res.json(X402PricingResponseSchema.parse({ pricing }));
  });

  return router;
}

export const x402Router = createX402Router();
