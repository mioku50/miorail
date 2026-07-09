import { Router, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createX402MiddlewareFromEnv,
  x402MiddlewareDiagnosticsFromEnv,
  x402ConfigFromEnv,
  x402StatusFromEnv,
  classifyX402SettleFailureReason,
  type SupportedX402Network,
  type X402MiddlewareRuntimeMode,
  type X402SettlementRecord,
} from '@mioagent/x402-gateway';
import {
  db,
  client as sql,
  auditLogs,
  spendPermissions,
  x402Receipts,
} from '@mioagent/db';
import {
  FuelChargeService,
  createDatabaseSpendPermissionRepository,
  listFuelReservations,
  type FuelCategory,
} from '@mioagent/autonomy';
import { eq, desc, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  X402FuelResponseSchema,
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
  buyerPaidFetch?: typeof fetch;
  dbEnabled?: boolean;
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

function userIdFromRequest(req: Request): string {
  return (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
}

function sanitizedUrlHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function rpcUrlForNetwork(network?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (network === 'eip155:84532') {
    return env.BASE_SEPOLIA_RPC_URL || env.BASE_RPC_URL || 'https://sepolia.base.org';
  }
  if (network === 'eip155:8453' || !network) {
    return env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || 'https://mainnet.base.org';
  }
  return undefined;
}

async function detectPayerWalletType(
  payer?: string | null,
  network?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ addressPresent: boolean; walletType: 'eoa' | 'smart_wallet' | 'unknown'; eip1271Likely: boolean }> {
  if (!payer || !/^0x[a-fA-F0-9]{40}$/.test(payer)) {
    return { addressPresent: Boolean(payer), walletType: 'unknown', eip1271Likely: false };
  }
  const rpcUrl = rpcUrlForNetwork(network, env);
  if (!rpcUrl) return { addressPresent: true, walletType: 'unknown', eip1271Likely: false };
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [payer, 'latest'],
      }),
      signal: AbortSignal.timeout(1500),
    });
    const body = await response.json() as { result?: unknown };
    const code = typeof body.result === 'string' ? body.result : '0x';
    const smart = code !== '0x' && code !== '0x0';
    return {
      addressPresent: true,
      walletType: smart ? 'smart_wallet' : 'eoa',
      eip1271Likely: smart,
    };
  } catch {
    return { addressPresent: true, walletType: 'unknown', eip1271Likely: false };
  }
}

function mapDiagnosticFailureReason(
  reason?: string | null,
  message?: string | null,
  payer?: { walletType?: string; eip1271Likely?: boolean },
): string | null {
  const text = [reason, message].filter(Boolean).join(' ').toLowerCase();
  if (!text && !payer?.eip1271Likely) return null;
  if (payer?.eip1271Likely && /(settlement|revert|authorization|signature|eip-?3009|exact|smart|1271)/i.test(text || 'settlement')) {
    return 'smart_wallet_unsupported_by_exact';
  }
  if (/unauthori[sz]ed|forbidden|auth|jwt|401|403/.test(text)) return 'facilitator_auth';
  if (/insufficient|balance|funds?|allowance|usdc/.test(text)) return 'insufficient_usdc';
  if (/network|chain|unsupported|8453|84532/.test(text)) return 'network_mismatch';
  return reason || 'settlement_failed';
}

async function persistSettlement(record: X402SettlementRecord, persistDb = true): Promise<void> {
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
    direction: (record as any).direction || 'incoming_seller_smoke',
    category: (record as any).category || 'dev_smoke',
    details: {
      ...detailsRecord,
      ...(runId ? { runId } : {}),
    },
    userId: record.userId || 'default-user',
  };
  if (!persistDb) return;
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
  direction?: 'incoming_seller_smoke' | 'outgoing_buyer_payment';
  category?: FuelCategory;
  fuelPermissionId?: string;
  fuelChargeId?: string;
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
    direction: receipt.direction === 'outgoing_buyer_payment' ? 'outgoing_buyer_payment' : 'incoming_seller_smoke',
    category: typeof receipt.category === 'string' ? receipt.category as FuelCategory : undefined,
    fuelPermissionId: typeof receipt.fuelPermissionId === 'string' ? receipt.fuelPermissionId : undefined,
    fuelChargeId: typeof receipt.fuelChargeId === 'string' ? receipt.fuelChargeId : undefined,
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

function decimalString(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value || 0);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function ledgerCategory(actionType: string, explicit?: string): FuelCategory {
  if (explicit === 'inference' || explicit === 'premium_data' || explicit === 'mcp_tool' || explicit === 'execution' || explicit === 'dev_smoke') {
    return explicit;
  }
  if (actionType === 'inference_call') return 'inference';
  if (actionType === 'premium_security_scan' || actionType === 'security_screening') return 'premium_data';
  if (actionType === 'swap_execution' || actionType === 'execution') return 'execution';
  if (actionType === 'x402_smoke_paid' || actionType === 'x402_buyer_smoke') return 'dev_smoke';
  return 'mcp_tool';
}

function isReadOnlyActionType(actionType: string): boolean {
  return actionType === 'portfolio_scan' ||
    actionType === 'portfolio_review' ||
    actionType === 'risk_recommendation' ||
    actionType === 'read_only_recommendation';
}

async function findActiveFuelPermission(userId: string, dbEnabled = true) {
  if (!dbEnabled) return null;
  try {
    const rows = await db.select()
      .from(spendPermissions)
      .where(and(eq(spendPermissions.userId, userId), eq(spendPermissions.isActive, true)))
      .orderBy(desc(spendPermissions.updatedAt))
      .limit(1);
    return rows[0] || null;
  } catch {
    return null;
  }
}

function permissionResponse(row: Awaited<ReturnType<typeof findActiveFuelPermission>>) {
  if (!row) return null;
  const limit = Number(row.limit || 0);
  const spent = Number(row.spent || 0);
  const remaining = Math.max(0, limit - spent);
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    asset: row.asset,
    limitUsdc: decimalString(limit),
    spentUsdc: decimalString(spent),
    remainingUsdc: decimalString(remaining),
    expiresAt: row.expiresAt.toISOString(),
    isActive: row.isActive,
    whitelist: Array.isArray(row.whitelist) ? row.whitelist.map(String) : [],
  };
}

async function persistBuyerReceipt(input: {
  userId: string;
  permissionId: string;
  fuelChargeId?: string;
  amountUsdc: string;
  category: FuelCategory;
  proofTxHash?: string;
  network?: SupportedX402Network;
  asset?: string;
  payTo?: string;
  status: 'settled' | 'pending' | 'failed';
  details?: Record<string, unknown>;
}) {
  const id = input.proofTxHash
    ? `x402-buyer:${input.network || 'unknown'}:${input.proofTxHash}`
    : `x402-buyer:${randomUUID()}`;
  const receipt = {
    id,
    userId: input.userId,
    actionId: id,
    actionType: 'x402_buyer_smoke',
    direction: 'outgoing_buyer_payment',
    category: input.category,
    fuelPermissionId: input.permissionId,
    fuelChargeId: input.fuelChargeId,
    cost: input.amountUsdc,
    txHash: input.proofTxHash || null,
    network: input.network || '',
    asset: input.asset || '',
    amount: input.amountUsdc,
    payTo: input.payTo || '',
    status: input.status,
    attribution: { source: 'buyer_fuel', expectedBuilderCode: process.env.BUILDER_CODE },
    checkedAt: new Date().toISOString(),
    source: 'x402-facilitator',
    details: input.details || {},
  };
  await db.insert(x402Receipts).values({
    id,
    receipt,
    updatedAt: new Date(),
  });
  return receipt;
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
  const dbEnabled = options.dbEnabled !== false;
  const commonMiddlewareOptions = {
    serviceName: 'Miorail',
    onSettlement: (record: X402SettlementRecord) => persistSettlement(record, dbEnabled),
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
      if (dbEnabled) {
        const rows = await db.select()
          .from(x402Receipts)
          .orderBy(desc(x402Receipts.createdAt))
          .limit(50);
        const parsed = rows.map(receiptRecord);
        latestGlobalRecord = parsed[0] || null;
        if (lastBrowserRun?.runId) {
          browserRunMatched = parsed.some((r) => r.runId === lastBrowserRun?.runId);
        }
      }
    } catch {
      latestGlobalRecord = null;
    }

    const payerAddress = lastBrowserRun?.payer || lastSmokeSettlement?.payer || null;
    const lastPayer = await detectPayerWalletType(payerAddress, lastSmokeSettlement?.network || diagnostics.network, env);
    const latestErrorReason = lastSmokeSettlement?.errorReason || lastBrowserRun?.errorReason || null;
    const latestErrorMessage = lastSmokeSettlement?.errorMessage || null;
    const latestSettleFailure = latestErrorReason || latestErrorMessage
      ? {
          errorReason: latestErrorReason,
          errorCode: latestErrorReason,
          mappedReason: mapDiagnosticFailureReason(latestErrorReason, latestErrorMessage, lastPayer),
          checkedAt: lastSmokeSettlement?.settledAt || lastBrowserRun?.settledAt || null,
        }
      : null;

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
      latestSettleFailure,
      lastPayer,
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

  router.get('/fuel', async (req: Request, res: Response, next) => {
    try {
      const userId = userIdFromRequest(req);
      const statusConfig = await x402StatusFromEnv(env);
      const active = await findActiveFuelPermission(userId, dbEnabled);
      const activePermission = permissionResponse(active);
      const pending = activePermission ? listFuelReservations(activePermission.id) : [];

      let records: ReturnType<typeof receiptRecord>[] = [];
      try {
        if (dbEnabled) {
          const rows = await db.select()
            .from(x402Receipts)
            .orderBy(desc(x402Receipts.createdAt))
            .limit(100);
          records = rows.map(receiptRecord)
            .filter((record) => !record.userId || record.userId === userId);
        }
      } catch {
        records = [];
      }

      const spend = {
        inference: 0,
        premiumData: 0,
        mcpTool: 0,
        execution: 0,
        devSmoke: 0,
      };

      const recentReceipts = records.slice(0, 20).map((record) => {
        const actionType = record.actionType || 'x402_resource';
        const category = ledgerCategory(actionType, record.category);
        const cost = isReadOnlyActionType(actionType) ? '0' : (record.cost || atomicUsdcToDecimal(record.amount));
        if (record.direction === 'outgoing_buyer_payment') {
          const costVal = Number(cost || 0);
          if (Number.isFinite(costVal)) {
            if (category === 'inference') spend.inference += costVal;
            if (category === 'premium_data') spend.premiumData += costVal;
            if (category === 'mcp_tool') spend.mcpTool += costVal;
            if (category === 'execution') spend.execution += costVal;
            if (category === 'dev_smoke') spend.devSmoke += costVal;
          }
        }
        return {
          id: record.id,
          runId: record.runId,
          actionId: record.actionId || record.id,
          actionType,
          direction: record.direction || 'incoming_seller_smoke',
          category,
          fuelPermissionId: record.fuelPermissionId,
          fuelChargeId: record.fuelChargeId,
          cost,
          txHash: record.txHash,
          network: record.network,
          asset: record.asset,
          amount: record.amount,
          payTo: record.payTo,
          status: record.status,
          settlementStatus: record.status,
          attribution: record.attribution,
          createdAt: record.createdAt.toISOString(),
          settlement: record.status,
          details: {
            source: record.source,
            checkedAt: record.checkedAt,
            direction: record.direction || 'incoming_seller_smoke',
          },
        };
      });

      const response = {
        status: !activePermission
          ? 'missing_permission'
          : !activePermission.isActive
            ? 'permission_inactive'
            : Date.now() > new Date(activePermission.expiresAt).getTime()
              ? 'permission_expired'
              : Number(activePermission.remainingUsdc) <= 0
                ? 'limit_exhausted'
                : 'ready',
        mode: 'buyer' as const,
        activePermission,
        pendingReservations: pending.map((reservation) => ({
          id: reservation.id,
          amountUsdc: decimalString(reservation.amount),
          category: reservation.category,
          createdAt: reservation.createdAt,
        })),
        spendByCategory: {
          inference: spend.inference.toFixed(4),
          premiumData: spend.premiumData.toFixed(4),
          mcpTool: spend.mcpTool.toFixed(4),
          execution: spend.execution.toFixed(4),
          devSmoke: spend.devSmoke.toFixed(4),
        },
        recentReceipts,
        buyerSmoke: {
          configured: Boolean(env.X402_BUYER_SMOKE_URL),
          urlHost: sanitizedUrlHost(env.X402_BUYER_SMOKE_URL),
        },
        x402: {
          settleReady: statusConfig.settleReady,
          status: statusConfig.status,
          network: statusConfig.network,
        },
      };

      res.json(X402FuelResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  router.post('/buyer-smoke', async (req: Request, res: Response, next) => {
    try {
      const userId = userIdFromRequest(req);
      const smokeUrl = env.X402_BUYER_SMOKE_URL;
      if (!smokeUrl) {
        return res.status(503).json({
          error: 'x402_buyer_smoke_not_configured',
          missingConfig: ['X402_BUYER_SMOKE_URL'],
        });
      }
      if (!options.buyerPaidFetch) {
        return res.status(503).json({
          error: 'x402_buyer_unavailable',
          errorCode: 'x402_buyer_signer_missing',
          note: 'Buyer x402 requires a configured CDP-managed payer signer; no user key is stored or requested.',
        });
      }

      const active = await findActiveFuelPermission(userId, dbEnabled);
      if (!active) {
        return res.status(402).json({ error: 'fuel_permission_required', status: 'missing_permission' });
      }
      const amount = Number(env.X402_BUYER_SMOKE_AMOUNT_USDC || req.body?.amountUsdc || 1);
      const category: FuelCategory = 'dev_smoke';
      const repository = createDatabaseSpendPermissionRepository(sql);
      const fuel = new FuelChargeService(repository, {
        walletName: env.BASE_SUBSCRIPTION_WALLET_NAME || env.CDP_SUBSCRIPTION_WALLET_NAME,
        paymasterUrl: env.PAYMASTER_URL,
      });
      const reserved = await fuel.reserve({
        permissionId: active.id,
        amount,
        category,
        chainEnv: env.CHAIN_ENV || active.chainId,
      });
      if (!reserved.success || !reserved.reservation) {
        return res.status(402).json({
          error: 'fuel_reservation_failed',
          status: reserved.status,
          message: reserved.error,
        });
      }

      let paidResponse: globalThis.Response;
      try {
        paidResponse = await options.buyerPaidFetch(smokeUrl, {
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        fuel.release(reserved.reservation.id);
        return res.status(502).json({
          error: 'x402_buyer_fetch_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      fuel.release(reserved.reservation.id);
      if (!paidResponse.ok) {
        return res.status(502).json({
          error: 'x402_buyer_resource_failed',
          status: paidResponse.status,
        });
      }

      const charge = await fuel.charge({
        permissionId: active.id,
        amount,
        category,
        chainEnv: env.CHAIN_ENV || active.chainId,
      });
      if (!charge.success) {
        return res.status(402).json({
          error: 'fuel_charge_failed',
          status: charge.status,
          message: charge.error,
        });
      }

      const statusConfig = x402ConfigFromEnv(env);
      const receipt = await persistBuyerReceipt({
        userId,
        permissionId: active.id,
        fuelChargeId: charge.chargeId,
        amountUsdc: decimalString(amount),
        category,
        proofTxHash: charge.proof?.txHash,
        network: statusConfig.network,
        asset: statusConfig.asset,
        payTo: statusConfig.payTo,
        status: 'settled',
        details: {
          source: 'buyer-smoke',
          smokeUrlHost: sanitizedUrlHost(smokeUrl),
          chargeProof: charge.proof,
        },
      });

      res.status(200).json({
        ok: true,
        status: 'settled',
        receipt,
        fuelPermissionId: active.id,
        fuelChargeId: charge.chargeId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ledger', async (req: Request, res: Response, next) => {
    try {
      const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
      let rows: any[] = [];
      let auditContext: any[] = [];
      try {
        if (dbEnabled) {
          rows = await db.select()
            .from(x402Receipts)
            .orderBy(desc(x402Receipts.createdAt))
            .limit(100);
          auditContext = await db.select()
            .from(auditLogs)
            .where(eq(auditLogs.userId, userId))
            .orderBy(desc(auditLogs.createdAt))
            .limit(100);
        }
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
        const direction = record.direction || 'incoming_seller_smoke';
        const category = ledgerCategory(actionType, record.category);
        const cost = isReadOnlyActionType(actionType) ? '0' : (record.cost || atomicUsdcToDecimal(record.amount));
        const costVal = parseFloat(cost || '0');
        const isInference = category === 'inference';
        const isBuyer = direction === 'outgoing_buyer_payment';
        if (!isNaN(costVal) && isBuyer) {
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
          direction,
          category,
          fuelPermissionId: record.fuelPermissionId,
          fuelChargeId: record.fuelChargeId,
          cost,
          txHash: record.txHash,
          network: record.network,
          asset: record.asset,
          amount: record.amount,
          payTo: record.payTo,
          status: record.status,
          settlementStatus: record.status,
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
      { actionType: 'portfolio_scan', label: 'Read-only Portfolio Scan', priceUsdc: '0', description: 'Base portfolio read, provider status, and recommendation metadata stay free.' },
      { actionType: 'premium_security_scan', label: 'Premium Security Scan', priceUsdc: '0.0020', description: 'Paid deep token/security data. Basic read-only recommendations remain free.' },
      { actionType: 'swap_execution', label: 'Swap Simulation & Routing', priceUsdc: '0.0050', description: 'EIP-5792 batch execution preparation and route optimization' },
      { actionType: 'inference_call', label: 'Autonomous AI Inference', priceUsdc: '0.0010', description: 'Agent LLM reasoning and intent classification' },
      { actionType: 'paid_mcp_tool', label: 'Paid MCP Tool Call', priceUsdc: '0.0010', description: 'Outgoing paid tool resource accessed through buyer x402 fuel.' },
    ];
    res.json(X402PricingResponseSchema.parse({ pricing }));
  });

  return router;
}

export const x402Router = createX402Router();
