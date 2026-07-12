import { Router } from 'express';
import { StatusResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv } from '@mioagent/data-providers';
import { getProviderBudgetSnapshot, getProviderCacheDiagnostics } from '../lib/providerCache.js';
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

  const isReadonly = chainEnv === 'mainnet-readonly';
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
    rpc: {
      status: "connected" as const,
      provider: rpcProvider,
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
      mockFacilitatorEnabled: x402Diagnostics.mockFacilitatorEnabled,
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
    mockFacilitatorEnabled: x402Diagnostics.mockFacilitatorEnabled,
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

const defaultBaseMcpAuthStatus: StoredBaseMcpAuthStatus = {
  connected: false,
  needsReauth: false,
  userScoped: true,
};

export const statusRouteRuntime = {
  getBaseMcpAuthStatus,
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
    const auth = await statusRouteRuntime
      .getBaseMcpAuthStatus(tenantUserId(req))
      .catch(() => defaultBaseMcpAuthStatus);
    const statusData = {
      ...getSystemStatus(),
      baseMcp: finalizeBaseMcpReadiness(attachBaseMcpToolProbeStatus(mergeBaseMcpAuthStatus(baseMcp, auth))),
      x402: publicX402Status(await x402StatusFromEnv()),
    };
    res.json(StatusResponseSchema.parse(statusData));
  } catch (error) {
    next(error);
  }
});
