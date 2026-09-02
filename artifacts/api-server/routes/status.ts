import { Router } from 'express';
import { StatusResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv } from '@mioagent/data-providers';
import { getProviderBudgetSnapshot, getProviderCacheDiagnostics } from '../lib/providerCache.js';
import { rpcBudgetReportV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import { createDatabaseRpcCuLedgerRepository } from '@mioagent/route-storage';
import { getExecutionCapabilities } from '../lib/executionCapabilities.js';
import { attachBaseMcpToolProbeStatus, finalizeBaseMcpReadiness, getBaseMcpStatusSnapshot, probeBaseMcpStatus, type BaseMcpStatus } from '../lib/baseMcpStatus.js';
import { getBaseMcpAuthStatus, type StoredBaseMcpAuthStatus } from '../lib/baseMcpOAuthStore.js';
import {
  x402ConfigFromEnv,
  x402MiddlewareDiagnosticsFromEnv,
  getDefaultX402BuyerPayerRuntime,
  x402StatusFromEnv,
  type X402RuntimeConfig,
} from '@mioagent/x402-gateway';
import { tenantUserId } from '../middleware/tenantAuth';
import { tenantWalletAddress } from '../middleware/tenantAuth';
import { createApiToolAggregatorForUser } from '../lib/baseMcpTools.js';
import { verifyBaseMcpWalletMatch } from '../lib/baseMcpWalletReconciliation.js';
import { buildWalletContext, walletEnvironmentFromRequest } from '../lib/walletContext.js';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { paidIntelligenceReadinessV1 } from '../lib/paidIntelligenceReadiness.js';
import { readChainConditionsV1 } from '../lib/chainConditions.js';

export function getSystemStatus(envOverride?: string) {
  const chainEnv = envOverride || process.env.CHAIN_ENV || 'sepolia';
  const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
  const rpcUrl = chainEnv === 'sepolia' 
    ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org' 
    : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

  let rpcProvider = 'custom';
  if (rpcUrl.includes('alchemy.com')) {
    rpcProvider = 'alchemy';
  } else if (rpcUrl.includes('base.org')) {
    rpcProvider = 'base-public';
  }

  const { providerName, statusCode: tokenStatusCode } = getTokenBalancesProviderFromEnv();
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || '').toLowerCase();
  let tokenProvider = providerName;
  let tokenStatus: "connected" | "missing" | "failed" | "disabled" = tokenStatusCode;
  // Preserve the intended provider label when a provider was configured but its key is absent.
  if (mode === 'moralis' && !process.env.MORALIS_API_KEY) {
    tokenProvider = 'moralis';
    tokenStatus = 'missing';
  } else if (mode === 'alchemy' && !process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
    tokenProvider = 'alchemy';
    tokenStatus = 'missing';
  }

  const { providerName: priceProviderName, statusCode: priceStatusCode } = getPriceProviderFromEnv();
  const priceProvider = priceProviderName;
  const priceStatus: "connected" | "missing" | "failed" | "disabled" = priceStatusCode;


  const {
    providerName: riskProvider,
    statusCode: riskStatus,
    authMode: riskAuthMode,
    errorCode: riskErrorCode,
  } = getTokenSecurityProviderFromEnv();
  const { providerName: approvalProvider, statusCode: approvalStatusCode } = getApprovalProviderFromEnv();

  const x402Config = x402ConfigFromEnv();
  const x402Diagnostics = x402MiddlewareDiagnosticsFromEnv(undefined, { config: x402Config });
  const buyerPayer = getDefaultX402BuyerPayerRuntime().status();

  // T19.1: split execution into explicit flags via a shared helper. The UI may
  // show "Confirm in Base Account" only when userConfirmedEnabled is true, and
  // must never infer "Execute" from a single generic flag. `serverBroadcastEnabled`
  // is the ONLY flag that authorizes a server-side broadcast.
  const execution = getExecutionCapabilities(chainEnv);

  const cache = getProviderCacheDiagnostics();
  const budgets = getProviderBudgetSnapshot();
  const moralisBudgetStatus = budgets.moralis?.status;
  const approvalStatus =
    approvalProvider === 'moralis' && (
      moralisBudgetStatus === 'budget_exhausted' ||
      moralisBudgetStatus === 'rate_limited' ||
      moralisBudgetStatus === 'auth_or_budget_issue'
    )
      ? moralisBudgetStatus
      : approvalStatusCode;

  return {
    chainEnv,
    chainId,
    productMigration: getMiorailProductMigrationFlags(),
    rpc: {
      status: "connected" as const,
      provider: rpcProvider,
      // Phase 17.6 — what the metered endpoint has cost this month, in COMPUTE
      // UNITS, which is the unit the plan is sold in. Filled by the caller from
      // the durable ledger; a counter in memory reports "under budget" after
      // every deploy regardless of the truth, so an absent figure is reported
      // as absent rather than as zero.
      meteredBudget: null as null | Record<string, unknown>,
    },
    tokenBalances: {
      status: tokenStatus,
      provider: tokenProvider,
    },
    prices: {
      status: priceStatus,
      provider: priceProvider,
    },
    risk: {
      status: riskStatus,
      provider: riskProvider,
      ...(riskAuthMode ? { authMode: riskAuthMode } : {}),
      ...(riskErrorCode ? { errorCode: riskErrorCode } : {}),
    },
    approvals: {
      status: approvalStatus,
      provider: approvalProvider,
    },
    cache,
    budgets,
    baseMcp: finalizeBaseMcpReadiness(getBaseMcpStatusSnapshot()),
    x402: {
      status: x402Config.status,
      configured: x402Config.configured,
      network: x402Config.network,
      asset: x402Config.asset,
      facilitatorConfigured: !!x402Config.facilitatorUrl,
      payToConfigured: !!x402Config.payTo,
      builderCodeConfigured: !!x402Config.builderCode,
      facilitatorAuthConfigured: !!x402Config.facilitatorAuthConfigured,
      authSource: x402Config.authSource,
      settleReady: !!x402Config.settleReady,
      settleBlockedReason: x402Config.settleBlockedReason,
      probeStatus: x402Config.probeStatus,
      middlewareMode: x402Diagnostics.middlewareMode,
      officialMiddlewareEnabled: x402Diagnostics.officialMiddlewareEnabled,
      smokeRoute: x402Diagnostics.smokeRoute,
      smokeRouteAvailable: x402Diagnostics.smokeRouteAvailable,
      builderCodeAttribution: x402Diagnostics.builderCodeAttribution,
      errorCode: x402Config.errorCode,
      lastCheckedAt: x402Config.lastCheckedAt,
      supportedKindsCount: x402Config.supportedKindsCount,
      supportedNetworks: x402Config.supportedNetworks,
      fuel: {
        mode: 'buyer' as const,
        buyerEnabled: true,
        smokeResourceConfigured: !!process.env.X402_BUYER_SMOKE_URL,
      },
      buyerPayer,
      missingConfig: x402Config.missingConfig,
      warnings: x402Config.warnings,
    },
    // T67X-A1: the flag says an operator wants paid routes; this says whether
    // the facilitator can actually settle one. They came apart in production.
    paidIntelligence: paidIntelligenceReadinessV1(
      getMiorailProductMigrationFlags().paidIntelligence,
      x402Config,
    ),
    autonomy: {
      spendPermissionsPersistence: 'database' as const,
      databaseConfigured: !!process.env.DATABASE_URL,
      chainMode: chainEnv,
      mainnetExecutionEnabled: process.env.MAINNET_EXECUTION_ENABLED === 'true',
      mainnetRequiresUserOptIn: true,
    },
    execution,
  };
}

function publicX402Status(x402Config: X402RuntimeConfig) {
  const x402Diagnostics = x402MiddlewareDiagnosticsFromEnv(undefined, { config: x402Config });
  const buyerPayer = getDefaultX402BuyerPayerRuntime().status();
  return {
    status: x402Config.status,
    configured: x402Config.configured,
    network: x402Config.network,
    asset: x402Config.asset,
    facilitatorConfigured: !!x402Config.facilitatorUrl,
    payToConfigured: !!x402Config.payTo,
    builderCodeConfigured: !!x402Config.builderCode,
    facilitatorAuthConfigured: !!x402Config.facilitatorAuthConfigured,
    authSource: x402Config.authSource,
    settleReady: !!x402Config.settleReady,
    settleBlockedReason: x402Config.settleBlockedReason,
    probeStatus: x402Config.probeStatus,
    middlewareMode: x402Diagnostics.middlewareMode,
    officialMiddlewareEnabled: x402Diagnostics.officialMiddlewareEnabled,
    smokeRoute: x402Diagnostics.smokeRoute,
    smokeRouteAvailable: x402Diagnostics.smokeRouteAvailable,
    builderCodeAttribution: x402Diagnostics.builderCodeAttribution,
    errorCode: x402Config.errorCode,
    lastCheckedAt: x402Config.lastCheckedAt,
    supportedKindsCount: x402Config.supportedKindsCount,
    supportedNetworks: x402Config.supportedNetworks,
    fuel: {
      mode: 'buyer' as const,
      buyerEnabled: true,
      smokeResourceConfigured: !!process.env.X402_BUYER_SMOKE_URL,
    },
    buyerPayer,
    missingConfig: x402Config.missingConfig,
    warnings: x402Config.warnings,
  };
}

export const statusRouter = Router();

export const statusRouteRuntime = {
  getBaseMcpAuthStatus,
  resolveWalletMatch: async (req: Parameters<typeof createApiToolAggregatorForUser>[0], userId: string, tenantWallet: string) => {
    if (process.env.NODE_ENV === 'test') return { match: true, mcpAddresses: [], checked: false };
    const tools = await createApiToolAggregatorForUser(
      req,
      userId,
      process.env.SESSION_SECRET || 'test-secret',
      { readOnlyOnly: true },
    );
    try {
      return await verifyBaseMcpWalletMatch(tools, tenantWallet);
    } finally {
      await tools.close();
    }
  },
  probeRpcStatus: async (chainId: number, rpcUrl: string, provider: string) => {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) return { status: 'failed' as const, provider };
      const payload = await response.json() as { result?: string };
      return Number.parseInt(payload.result || '', 16) === chainId
        ? { status: 'connected' as const, provider }
        : { status: 'failed' as const, provider };
    } catch {
      return { status: 'failed' as const, provider };
    }
  },
  readChainConditions: readChainConditionsV1,
};

function mergeBaseMcpAuthStatus(base: BaseMcpStatus, auth: StoredBaseMcpAuthStatus): BaseMcpStatus {
  const transportDegraded = base.status === 'unreachable' || base.status === 'degraded' || base.status === 'unsupported';
  const publicAuth: StoredBaseMcpAuthStatus =
    base.enabled && base.configured && !auth.connected && !transportDegraded
      ? { ...auth, needsReauth: true }
      : auth;
  const withAuth = { ...base, auth: publicAuth };
  if (!base.enabled || !base.configured) return withAuth;
  if (publicAuth.connected) return { ...withAuth, status: 'connected' };
  if (base.status === 'unreachable' || base.status === 'degraded' || base.status === 'unsupported') {
    return withAuth;
  }
  if (publicAuth.needsReauth) return { ...withAuth, status: 'needs_reauth' };
  return { ...withAuth, status: 'missing' };
}

statusRouter.get('/', async (req, res, next) => {
  try {
    const baseMcp = await probeBaseMcpStatus();
    const auth = await statusRouteRuntime.getBaseMcpAuthStatus(tenantUserId(req));
    const baseStatus = getSystemStatus();
    // The month's metered spend, from the durable ledger. A read that fails
    // leaves the field null: absent is "we did not read it", and reporting zero
    // would be the budget saying it is fine because it forgot.
    try {
      const now = new Date();
      const rows = await createDatabaseRpcCuLedgerRepository(client).readMonth(now);
      const alchemyCu = rows
        .filter((row) => row.provider === 'alchemy')
        .reduce((total, row) => total + row.spentCu, 0);
      const fallbackCalls = rows
        .filter((row) => row.provider === 'fallback')
        .reduce((total, row) => total + row.callCount, 0);
      baseStatus.rpc.meteredBudget = {
        ...rpcBudgetReportV1({ now, spentCu: alchemyCu }),
        alchemyConfigured: (process.env.ALCHEMY_BASE_MAINNET_RPC_URL ?? '').trim().length > 0,
        // How much of the month ran on the fallback, which is the number that
        // says whether the budget is actually holding.
        fallbackCalls,
      };
    } catch {
      baseStatus.rpc.meteredBudget = null;
    }
    const userId = tenantUserId(req);
    const tenantWallet = tenantWalletAddress(req);
    const rpcUrl = baseStatus.chainId === 84532
      ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
      : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
    const finalizedBaseMcp = finalizeBaseMcpReadiness(attachBaseMcpToolProbeStatus(mergeBaseMcpAuthStatus(baseMcp, auth)));
    let walletMatch = { match: true, mcpAddresses: [] as string[], checked: false };
    if (auth.connected) {
      walletMatch = await statusRouteRuntime.resolveWalletMatch(req, userId, tenantWallet);
    }
    const scopedStatus = buildWalletContext({
      tenantWallet,
      environment: walletEnvironmentFromRequest(req),
      match: walletMatch,
      baseMcpUsable: finalizedBaseMcp.usable === true || finalizedBaseMcp.readiness === 'tools_available',
    });
    const statusData = {
      ...baseStatus,
      rpc: await statusRouteRuntime.probeRpcStatus(baseStatus.chainId, rpcUrl, baseStatus.rpc.provider),
      // Never throws and never serves a stale reading as current — see
      // lib/chainConditions.ts.
      chain: await statusRouteRuntime.readChainConditions(rpcUrl),
      baseMcp: { ...finalizedBaseMcp, ...scopedStatus },
      x402: publicX402Status(await x402StatusFromEnv()),
    };
    res.json(StatusResponseSchema.parse(statusData));
  } catch (error) {
    next(error);
  }
});
