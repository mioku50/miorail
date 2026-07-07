import { Router } from 'express';
import { StatusResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv } from '@mioagent/data-providers';
import { getProviderBudgetSnapshot, getProviderCacheDiagnostics } from '../lib/providerCache.js';
import { getExecutionCapabilities } from '../lib/executionCapabilities.js';
import { getBaseMcpStatusSnapshot, probeBaseMcpStatus } from '../lib/baseMcpStatus.js';

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


  const { providerName: riskProvider, statusCode: riskStatus } = getTokenSecurityProviderFromEnv();
  const { providerName: approvalProvider, statusCode: approvalStatus } = getApprovalProviderFromEnv();

  const x402Status: "simulated" | "configured" | "missing" = process.env.X402_FACILITATOR_URL ? "configured" : "simulated";

  const isReadonly = chainEnv === 'mainnet-readonly';
  // T19.1: split execution into explicit flags via a shared helper. The UI may
  // show "Confirm in Base Account" only when userConfirmedEnabled is true, and
  // must never infer "Execute" from a single generic flag. `serverBroadcastEnabled`
  // is the ONLY flag that authorizes a server-side broadcast.
  const execution = getExecutionCapabilities(chainEnv);

  const cache = getProviderCacheDiagnostics();
  const budgets = getProviderBudgetSnapshot();

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
    },
    approvals: {
      status: approvalStatus,
      provider: approvalProvider,
    },
    cache,
    budgets,
    baseMcp: getBaseMcpStatusSnapshot(),
    x402: {
      status: x402Status,
    },
    execution,
  };
}

export const statusRouter = Router();

statusRouter.get('/', async (req, res, next) => {
  try {
    const baseMcp = await probeBaseMcpStatus();
    const statusData = {
      ...getSystemStatus(),
      baseMcp,
    };
    res.json(StatusResponseSchema.parse(statusData));
  } catch (error) {
    next(error);
  }
});
